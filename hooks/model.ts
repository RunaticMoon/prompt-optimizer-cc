/**
 * Task F — one independent model completion turned into a validated
 * {@link RewriteResult}.
 *
 * {@link buildModelRequest} assembles the one-shot request: the configured
 * model, `effort`, `maxTokens` and `timeoutMs`, the caller's system prompt,
 * and a tagged prompt holding the context snapshot, the original prompt, the
 * current draft, the recent dialogue and the caller's instruction. The whole
 * prompt plus system is budgeted against {@link MAX_REQUEST_CHARS}: older
 * dialogue, context and the previous draft yield to the latest exchange. The
 * original prompt and the latest user decisions are never cut.
 *
 * {@link completeRewrite} makes exactly one `$.model.complete` call — no retry,
 * no model fallback, no `$.model.fork` — and maps every outcome (answer,
 * invalid JSON, empty draft, API error, abort, reject) to a {@link RewriteResult}
 * that always carries `usage`.
 *
 * {@link parseReply} reads the fixed JSON contract: an optional code fence is
 * ignored, the first `{` to the last `}` is parsed, and only `draft`, `message`,
 * `question` and `options` are read.
 */

import type { ModelCompleteRequest, ModelCompleteResult, ModelTextBlock } from 'claude-code'

import {
  DEFAULT_EFFORT,
  type DecisionLedger,
  type EnginePorts,
  MAX_REPLY_OPTION_CHARS,
  MAX_REPLY_OPTIONS,
  MAX_REQUEST_CHARS,
  type ModelUsage,
  type OptimizerConfig,
  type OptimizerMessage,
  type OptimizerReply,
  type RewriteResult,
  type Workflow,
} from './contracts'
import { activeDecisions, supersededBy } from './decisions'

/** A usage record with every token count at zero. */
function zeroUsage(): ModelUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
}

/** A token count, or `0` for anything that is not a finite number. */
function coerceToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Normalizes an engine usage record, filling missing counts with `0`. */
function normalizeUsage(raw: unknown): ModelUsage {
  if (raw === null || typeof raw !== 'object') return zeroUsage()
  const record = raw as Record<string, unknown>
  return {
    input_tokens: coerceToken(record.input_tokens),
    output_tokens: coerceToken(record.output_tokens),
    cache_read_input_tokens: coerceToken(record.cache_read_input_tokens),
    cache_creation_input_tokens: coerceToken(record.cache_creation_input_tokens),
  }
}

/** A human-readable message from a rejected promise or thrown value. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The most recent user supplement in the dialogue, if there is one. */
function lastUserInstruction(dialogue: readonly OptimizerMessage[]): string | undefined {
  for (let i = dialogue.length - 1; i >= 0; i -= 1) {
    const message = dialogue[i]
    if (message !== undefined && message.role === 'user' && message.text !== '') return message.text
  }
  return undefined
}

/**
 * A recoverable preflight refusal: the protected content (original, active
 * user decisions with their source, an uncaptured explicit instruction, a
 * pending question and the fixed formatting) cannot fit in one request even
 * after every optional section is dropped. No model call is made.
 */
export class RequestBudgetError extends Error {
  /** Prompt plus system length the protected content needs. */
  readonly requiredChars: number
  /** The request limit it exceeded. */
  readonly limitChars: number
  /** Active decision ids that are protected. */
  readonly decisionIds: readonly string[]

  constructor(requiredChars: number, limitChars: number, decisionIds: readonly string[]) {
    super(REQUEST_BUDGET_NOTICE)
    this.name = 'RequestBudgetError'
    this.requiredChars = requiredChars
    this.limitChars = limitChars
    this.decisionIds = decisionIds
  }
}

/** The exact user-facing notice for a {@link RequestBudgetError}. */
export const REQUEST_BUDGET_NOTICE =
  `확정 결정과 필수 입력이 요청 한도(${MAX_REQUEST_CHARS}자)를 초과했습니다. 결정을 정정하거나 새 작업으로 나눠 주세요. 모델은 호출하지 않았습니다.`

/** Fixed instructions that frame the captured decision evidence. */
const DECISION_RULES = [
  '아래 JSON만 사용자가 직접 쓴 확정 결정과 그 출처다.',
  'selectedOption은 사용자가 선택지에서 고른 확정 선택이다.',
  'current_draft·context·변경 메모는 사용자 합의가 아니며 미확정 제안이다.',
  'supersedes로 대체된 id의 결정은 비활성이다. 활성 결정과 모순되면 활성 결정을 따른다.',
]

/** One deduplicated question/option payload referenced by decisions. */
interface EvidenceSource {
  key: string
  questionId: string | null
  question: string | null
  options: readonly string[]
  answeredAfterRound: number
}

/** One active decision in the request's JSON evidence. */
interface EvidenceDecision {
  id: string
  text: string
  source: string
  selectedOption?: { index: number; text: string }
  supersedes?: string
}

/**
 * Escapes `<` and `>` inside the serialized evidence. The replacement is the
 * JSON escape `\u003c`/`\u003e`, so the text still parses back exactly while a
 * captured `</user_decisions>` cannot end the section early.
 */
function escapeJsonAngles(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

/**
 * Renders active decisions outside the cached original/context prefix. The
 * source payload is deduplicated by question id; entries that were superseded
 * are left to local inspection, not sent as operative constraints.
 */
function decisionSection(ledger: DecisionLedger): string | null {
  const active = activeDecisions(ledger)
  if (active.length === 0) return null
  const sources: EvidenceSource[] = []
  const byKey = new Map<string, EvidenceSource>()
  const decisions: EvidenceDecision[] = []
  for (const entry of active) {
    // A question id identifies one identical source payload; an answer with no
    // question id keeps its own single source.
    const key = entry.source.questionId ?? `${entry.id}:source`
    if (!byKey.has(key)) {
      const source: EvidenceSource = {
        key,
        questionId: entry.source.questionId,
        question: entry.source.question,
        options: [...entry.source.options],
        answeredAfterRound: entry.source.answeredAfterRound,
      }
      byKey.set(key, source)
      sources.push(source)
    }
    decisions.push({
      id: entry.id,
      text: entry.text,
      source: key,
      ...(entry.selectedOption === undefined ? {} : { selectedOption: { ...entry.selectedOption } }),
      ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
    })
  }
  const json = escapeJsonAngles(JSON.stringify({ decisions, sources }))
  return `<user_decisions>\n${DECISION_RULES.join('\n')}\n${json}\n</user_decisions>`
}

/** Renders the current unanswered question/choices as protected JSON, if any. */
function pendingQuestionSection(workflow: Readonly<Workflow>): string | null {
  const question = workflow.question
  if (question === null || question === undefined || question.trim() === '') return null
  const json = escapeJsonAngles(JSON.stringify({
    questionId: workflow.questionId ?? null,
    question,
    options: [...(workflow.options ?? [])],
  }))
  return `<pending_question>\n${json}\n</pending_question>`
}

/**
 * The dialogue turns that may still be sent. A captured answer whose decision
 * was superseded never appears as operative dialogue; once the ledger records
 * a correction, optimizer turns up to the LATEST correction are omitted too,
 * since an earlier turn can repeat a value the person has since replaced.
 */
function operativeDialogue(
  dialogue: readonly OptimizerMessage[],
  ledger: DecisionLedger,
): OptimizerMessage[] {
  const replaced = supersededBy(ledger)
  const correctionIds = new Set(
    ledger.entries.filter(entry => entry.supersedes !== undefined).map(entry => entry.id),
  )
  const lastCorrection = dialogue.findLastIndex(
    message => message.decisionId !== undefined && correctionIds.has(message.decisionId),
  )
  return dialogue.filter((message, index) => {
    if (message.role === 'user' && message.decisionId !== undefined && replaced.has(message.decisionId)) {
      return false
    }
    if (lastCorrection !== -1 && index <= lastCorrection && message.role === 'optimizer') return false
    return true
  })
}

/** Whether an explicit instruction is already one of the active decisions. */
function isCapturedInstruction(ledger: DecisionLedger, instruction: string): boolean {
  return instruction !== '' && activeDecisions(ledger).some(entry => entry.text === instruction)
}

/** The parts of the request prompt, already selected for the budget. */
interface PromptParts {
  context: string
  original: string
  /** Pre-rendered active-decision section, or null when there is no ledger. */
  decisions: string | null
  /** Pre-rendered pending-question section, or null. */
  pending: string | null
  draft: string | null
  /** Whether to label the draft as an unconfirmed proposal (ledger runs only). */
  labelDraft: boolean
  dialogue: readonly OptimizerMessage[]
  instruction: string
  round: number
  maxRounds: number
}

/**
 * Replaces the `<` of a section tag inside captured text with `‹` (U+2039), so
 * a stray `</context>` (or another section tag) cannot close the section early
 * and make the following text read as a top-level instruction. Matching is
 * case-insensitive, tolerates whitespace after `<` and around the `/`, and
 * requires a word boundary after the tag name; every other `<` is left alone.
 */
export function neutralizeTags(text: string): string {
  return text.replace(
    /<(\s*\/?\s*(?:context|original_prompt|current_draft|dialogue|instruction|refinement_round|user_decisions|pending_question)\b)/gi,
    '‹$1',
  )
}

/** The rendered tagged prompt and the index just past `</original_prompt>`. */
interface RenderedPrompt {
  /** The whole prompt, exactly as `blocks.join('\n\n')`. */
  text: string
  /**
   * Index in {@link text} just after the `</original_prompt>` block, so
   * `text.slice(0, prefixEnd)` is the cacheable prefix (context + original)
   * and the remainder still opens the request's variable part.
   */
  prefixEnd: number
}

/** Renders the tagged prompt; the selected dialogue stays in time order. */
function renderPrompt(parts: PromptParts): RenderedPrompt {
  const blocks: string[] = []
  // Only the context is neutralized: it can carry text from the conversation or
  // the repository. The original/draft/dialogue/instruction are the user's own
  // text, and changing their tags could leak the replacement character into an
  // improved draft.
  if (parts.context !== '') blocks.push(`<context>\n${neutralizeTags(parts.context)}\n</context>`)
  blocks.push(`<original_prompt>\n${parts.original}\n</original_prompt>`)
  // The prefix is exactly the joined context + original blocks; computing it
  // here (rather than searching for `</original_prompt>`) keeps the split exact
  // even when the user's own text contains that look-alike tag.
  const prefixEnd = blocks.join('\n\n').length
  // Decision evidence sits after the cached prefix but before the generated
  // draft, so the model reads confirmed user intent first.
  if (parts.decisions !== null) blocks.push(parts.decisions)
  if (parts.pending !== null) blocks.push(parts.pending)
  if (parts.draft !== null) {
    const label = parts.labelDraft ? '\n[미확정 모델 제안: 활성 user_decisions가 우선한다]' : ''
    blocks.push(`<current_draft>${label}\n${parts.draft}\n</current_draft>`)
  }
  if (parts.dialogue.length > 0) {
    // Selection is newest-first (see buildModelRequest); the kept turns read
    // oldest first here so the model follows the conversation in order.
    const lines = parts.dialogue.map(message => `${message.role}: ${message.text}`).join('\n')
    blocks.push(`<dialogue>\n${lines}\n</dialogue>`)
  }
  if (parts.instruction !== '') blocks.push(`<instruction>\n${parts.instruction}\n</instruction>`)
  blocks.push(
    `<refinement_round>\ncurrent: ${parts.round}\nmax: ${parts.maxRounds}\nremaining: ${Math.max(0, parts.maxRounds - parts.round)}\n</refinement_round>`,
  )
  blocks.push(
    'JSON 객체만 출력한다. 코드 펜스 없이 위 계약의 JSON 객체 하나만 보낸다. draft는 <original_prompt>와 같은 언어로, message·question·options는 항상 한국어로 쓴다.',
  )
  return { text: blocks.join('\n\n'), prefixEnd }
}

/**
 * Builds the one completion request for a workflow.
 *
 * The model is named explicitly (`config.model`), never followed from the
 * session; `effort` is {@link DEFAULT_EFFORT} and `maxTokens`/`timeoutMs` come
 * from the config. `instruction` is used as the `<instruction>` section when
 * given, else the dialogue's most recent user supplement.
 *
 * A workflow with a decision ledger keeps every active answer and its exact
 * question/options in a `<user_decisions>` section (and a pending question in
 * `<pending_question>`) outside the cached context/original prefix. When the
 * prompt plus `system` exceeds {@link MAX_REQUEST_CHARS}, dialogue is dropped
 * oldest first, then the context tail, then the generated draft tail; the
 * protected evidence is never trimmed. If even protected content cannot fit,
 * {@link RequestBudgetError} is thrown rather than silently dropping a
 * decision. A fixture without a ledger keeps the older behavior, including
 * protecting the latest exchange.
 *
 * `options.cache` defaults to `false`, which keeps `prompt`/`system` as plain
 * strings (the older shape every engine takes). When `true`, both become
 * {@link ModelTextBlock} lists marked for the prompt cache: `system` is one
 * cached block (omitted when blank) and `prompt` is the context-plus-original
 * prefix (cached) followed by the still-variable remainder. Concatenating the
 * blocks reproduces the string request exactly, and the budget above is still
 * measured on that string.
 */
export function buildModelRequest(
  workflow: Readonly<Workflow>,
  config: OptimizerConfig,
  system: string,
  instruction?: string,
  options: { cache?: boolean } = {},
): ModelCompleteRequest {
  const original = workflow.original
  let draft = workflow.draft !== '' && workflow.draft !== original ? workflow.draft : null
  const fallbackInstruction = instruction !== undefined
    ? instruction
    : lastUserInstruction(workflow.dialogue) ?? ''
  const ledger = workflow.decisions
  // A supplement already recorded as a decision is protected there; don't pay
  // for the same text twice in `<instruction>`.
  const instructionText = ledger !== undefined && isCapturedInstruction(ledger, fallbackInstruction)
    ? ''
    : fallbackInstruction
  const decisions = ledger === undefined ? null : decisionSection(ledger)
  const pending = ledger === undefined ? null : pendingQuestionSection(workflow)
  let dialogue = ledger === undefined
    ? workflow.dialogue.slice()
    : operativeDialogue(workflow.dialogue, ledger)
  let context = workflow.context?.text ?? ''

  const build = (): RenderedPrompt =>
    renderPrompt({
      context, original, decisions, pending, draft,
      labelDraft: ledger !== undefined, dialogue, instruction: instructionText,
      round: workflow.rounds + 1, maxRounds: config.maxRounds,
    })

  let prompt = build()

  if (ledger === undefined) {
    // Legacy fixture path: keep the latest question/answer pair protected and
    // never throw, so the older no-ledger tests and callers still work.
    const lastOptimizer = dialogue.findLastIndex(message => message.role === 'optimizer')
    const protectedTurns = dialogue.length === 0 ? 0
      : lastOptimizer < 0 ? 1 : dialogue.length - lastOptimizer

    // 1) Drop the oldest dialogue turns until the request fits.
    while (prompt.text.length + system.length > MAX_REQUEST_CHARS && dialogue.length > protectedTurns) {
      dialogue.shift()
      prompt = build()
    }

    // 2) Trim the context from its tail, keeping its head.
    if (prompt.text.length + system.length > MAX_REQUEST_CHARS && context !== '') {
      const overflow = prompt.text.length + system.length - MAX_REQUEST_CHARS
      context = context.slice(0, Math.max(0, context.length - overflow))
      prompt = build()
    }

    // Large prior drafts are replaceable summaries. Preserve the user's original
    // and latest decision before preserving generated prose, and flag truncation.
    if (prompt.text.length + system.length > MAX_REQUEST_CHARS && draft !== null) {
      const overflow = prompt.text.length + system.length - MAX_REQUEST_CHARS
      const marker = '\n[Earlier draft truncated; retain the original request and user decisions.]'
      const keep = Math.max(0, draft.length - overflow - marker.length)
      draft = keep > 0 ? draft.slice(0, keep) + marker : null
      prompt = build()
    }
  } else {
    // Refuse before spending a call when the protected evidence alone is over
    // budget. The count is the exact prompt+system the evidence needs.
    const protectedPrompt = renderPrompt({
      context: '', original, decisions, pending, draft: null, labelDraft: true,
      dialogue: [], instruction: instructionText,
      round: workflow.rounds + 1, maxRounds: config.maxRounds,
    })
    const requiredChars = protectedPrompt.text.length + system.length
    if (requiredChars > MAX_REQUEST_CHARS) {
      throw new RequestBudgetError(
        requiredChars,
        MAX_REQUEST_CHARS,
        activeDecisions(ledger).map(entry => entry.id),
      )
    }

    // 1) Ordinary dialogue yields first, oldest to newest. The ledger already
    // carries every captured answer, so even the latest exchange may go.
    while (prompt.text.length + system.length > MAX_REQUEST_CHARS && dialogue.length > 0) {
      dialogue.shift()
      prompt = build()
    }

    // 2) Trim the context from its tail, keeping its head.
    if (prompt.text.length + system.length > MAX_REQUEST_CHARS && context !== '') {
      const overflow = prompt.text.length + system.length - MAX_REQUEST_CHARS
      context = context.slice(0, Math.max(0, context.length - overflow))
      prompt = build()
    }

    // 3) Trim the generated draft tail; the decisions section outranks it.
    if (prompt.text.length + system.length > MAX_REQUEST_CHARS && draft !== null) {
      const overflow = prompt.text.length + system.length - MAX_REQUEST_CHARS
      const marker = '\n[Earlier draft truncated; retain the original request and user decisions.]'
      const keep = Math.max(0, draft.length - overflow - marker.length)
      draft = keep > 0 ? draft.slice(0, keep) + marker : null
      prompt = build()
    }

    // 4) Drop any remaining optional section and recompute. The protected
    // check above guarantees the result now fits.
    if (prompt.text.length + system.length > MAX_REQUEST_CHARS) {
      context = ''
      draft = null
      prompt = build()
    }
  }

  const text = prompt.text
  if (options.cache !== true) {
    return {
      model: config.model,
      prompt: text,
      system,
      maxTokens: config.maxTokens,
      effort: DEFAULT_EFFORT,
      timeoutMs: config.timeoutMs,
    }
  }

  // The text before `</original_prompt>` is the context the round repeats; only
  // the remainder changes between rounds, so the prefix is the cache breakpoint.
  const prefix = text.slice(0, prompt.prefixEnd)
  const rest = text.slice(prompt.prefixEnd)
  const request: ModelCompleteRequest = {
    model: config.model,
    prompt: [{ text: prefix, cache: true }, { text: rest }],
    maxTokens: config.maxTokens,
    effort: DEFAULT_EFFORT,
    timeoutMs: config.timeoutMs,
  }
  if (system !== '') request.system = [{ text: system, cache: true }]
  return request
}

/**
 * Joins a request's `prompt`/`system` value back into one string: a plain
 * string stands, and a block list joins its texts in order. The helper keeps
 * tests and logs reading a request the same way whatever shape it carries.
 */
export function requestText(value: string | readonly ModelTextBlock[] | undefined): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return value.map(block => block.text).join('')
}

/** Describes an API-error arm, naming its status and error kind, in Korean. */
function describeApiError(result: { status: number | null; error: string }): string {
  const status = result.status === null ? '응답 없음' : `status ${result.status}`
  return `옵티마이저 API 호출에 실패했습니다 (${status}: ${result.error})`
}

/**
 * Makes exactly one `$.model.complete` call and maps its outcome.
 *
 * A rejection (a bad model, a bad cap, an engine fault) becomes
 * `rejected` with the cause's message. A non-answer maps `aborted` and
 * `empty-reply` across, and any other API failure to `api-error`. An answer
 * with blank text is `empty-reply`; otherwise {@link parseReply} decides
 * between `ok`, `invalid-json` and `empty-draft`. Every arm carries `usage`,
 * zero-filled when the engine returned none.
 */
export async function completeRewrite(
  $: EnginePorts,
  request: ModelCompleteRequest,
  signal: AbortSignal,
): Promise<RewriteResult> {
  let result: ModelCompleteResult
  try {
    result = await $.model.complete(request, { signal })
  } catch (cause) {
    return { kind: 'failed', reason: 'rejected', message: describeError(cause), usage: zeroUsage() }
  }

  const usage = normalizeUsage((result as { usage?: unknown }).usage)

  if (!result.isAnswered) {
    if (result.reason === 'aborted') {
      return { kind: 'failed', reason: 'aborted', message: '옵티마이저 요청이 중단되었습니다', usage }
    }
    if (result.reason === 'empty-reply') {
      return { kind: 'failed', reason: 'empty-reply', message: '모델이 텍스트를 반환하지 않았습니다', usage }
    }
    return { kind: 'failed', reason: 'api-error', message: describeApiError(result), usage }
  }

  if (result.text.trim() === '') {
    return { kind: 'failed', reason: 'empty-reply', message: '모델이 텍스트를 반환하지 않았습니다', usage }
  }

  const parsed = parseReply(result.text)
  if (!parsed.ok) {
    return {
      kind: 'failed',
      reason: parsed.reason,
      message:
        parsed.reason === 'empty-draft'
          ? '모델 응답에 개선안이 없습니다'
          : '모델 응답이 올바른 JSON이 아닙니다',
      usage,
    }
  }

  return { kind: 'ok', reply: parsed.reply, usage }
}

/**
 * Parses one reply against the fixed JSON contract.
 *
 * Surrounding whitespace and a code fence are tolerated: the first `{` to the
 * last `}` is extracted and parsed. Two narrowly recognized question-tail
 * mistakes can be repaired ({@link parseObject}); truncated draft/message
 * values are never repaired. `draft` must be a non-empty string (trimmed);
 * `message` defaults to `''`; `question` is a non-empty string or `null`;
 * `options` is always an array — string choices only, trimmed, with blanks,
 * duplicates and over-long entries dropped and at most
 * {@link MAX_REPLY_OPTIONS} kept, and `[]` when the question is `null`. Any
 * other field is ignored. A missing object or unparseable JSON is
 * `invalid-json`; a missing or blank draft is `empty-draft`.
 */
export function parseReply(
  text: string,
): { ok: true; reply: OptimizerReply } | { ok: false; reason: 'invalid-json' | 'empty-draft' } {
  const body = text.trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end < start) return { ok: false, reason: 'invalid-json' }

  const tail = body.slice(end + 1).trim()
  const record = parseObject(body.slice(start, end + 1), tail === '' || tail === '```')
  if (record === null) return { ok: false, reason: 'invalid-json' }

  const draft = typeof record.draft === 'string' ? record.draft.trim() : ''
  if (draft === '') return { ok: false, reason: 'empty-draft' }

  const message = typeof record.message === 'string' ? record.message : ''
  const question =
    typeof record.question === 'string' && record.question.trim() !== '' ? record.question : null
  const options = parseOptions(record.options, question)

  return { ok: true, reply: { draft, message, question, options } }
}

/**
 * Reads the `options` array for one reply. Without a question there is nothing
 * to answer, so the list is empty; otherwise only complete, in-budget string
 * choices survive, duplicates and blanks drop, and the first
 * {@link MAX_REPLY_OPTIONS} are kept.
 */
function parseOptions(raw: unknown, question: string | null): readonly string[] {
  if (question === null || !Array.isArray(raw)) return []
  const options: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    // Count user-perceived characters (code points), so an emoji choice is
    // measured as one character rather than its two UTF-16 code units.
    if (text === '' || [...text].length > MAX_REPLY_OPTION_CHARS) continue
    if (options.includes(text)) continue
    options.push(text)
    if (options.length === MAX_REPLY_OPTIONS) break
  }
  return options
}

/**
 * Repairs only the two tail mistakes observed in real replies. A missing
 * quote must belong to the final `question` value, with no literal brace that
 * could instead be an interior brace at a truncation point. A stray `,"`
 * may be removed only after all values are already complete. Repairs require
 * the final brace to end the reply (apart from an optional closing fence).
 * Without a model stop reason, even this narrow repair cannot prove that an
 * otherwise complete-looking question was not cut off.
 */
function parseObject(json: string, allowRepair: boolean): Record<string, unknown> | null {
  const direct = parseRecord(json)
  if (direct !== null) return direct
  if (!allowRepair) return null

  const head = json.slice(0, -1)
  if (/"question"\s*:\s*"(?:[^"\\{}\r\n]|\\.)*$/.test(head)) {
    const record = parseRecord(`${head}"}`)
    if (record !== null && typeof record.question === 'string') return record
  }
  if (/,\s*"\s*$/.test(head)) {
    const record = parseRecord(`${head.replace(/,\s*"\s*$/, '')}}`)
    if (record !== null && Object.hasOwn(record, 'question')) return record
  }
  return null
}

/** `JSON.parse` narrowed to a plain object; anything else is null. */
function parseRecord(json: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}
