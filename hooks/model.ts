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

/** The parts of the request prompt, already selected for the budget. */
interface PromptParts {
  context: string
  original: string
  draft: string | null
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
    /<(\s*\/?\s*(?:context|original_prompt|current_draft|dialogue|instruction|refinement_round)\b)/gi,
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
  // Only the context is neutralized: it can carry other sources' memory text.
  // The original/draft/dialogue/instruction are the user's own text, and changing
  // their tags could leak the replacement character into an improved draft.
  if (parts.context !== '') blocks.push(`<context>\n${neutralizeTags(parts.context)}\n</context>`)
  blocks.push(`<original_prompt>\n${parts.original}\n</original_prompt>`)
  // The prefix is exactly the joined context + original blocks; computing it
  // here (rather than searching for `</original_prompt>`) keeps the split exact
  // even when the user's own text contains that look-alike tag.
  const prefixEnd = blocks.join('\n\n').length
  if (parts.draft !== null) blocks.push(`<current_draft>\n${parts.draft}\n</current_draft>`)
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
 * When the prompt plus `system` exceeds {@link MAX_REQUEST_CHARS}, the newest
 * dialogue turns are kept (the oldest are dropped first), then context and the
 * generated draft are trimmed. The latest question/answer stays together and
 * the original prompt is never truncated. Oversized user input alone can
 * exceed the budget; it is never silently rewritten or discarded here.
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
  const instructionText = instruction !== undefined ? instruction : lastUserInstruction(workflow.dialogue) ?? ''

  const dialogue = workflow.dialogue.slice()
  // An answer such as "the first option" is meaningless without its question.
  // Keep the latest optimizer question and subsequent answers as one exchange.
  const lastOptimizer = dialogue.findLastIndex(message => message.role === 'optimizer')
  const protectedTurns = dialogue.length === 0 ? 0
    : lastOptimizer < 0 ? 1 : dialogue.length - lastOptimizer
  let context = workflow.context?.text ?? ''

  const build = (): RenderedPrompt =>
    renderPrompt({
      context, original, draft, dialogue, instruction: instructionText,
      round: workflow.rounds + 1, maxRounds: config.maxRounds,
    })

  let prompt = build()

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
    if (text === '' || text.length > MAX_REPLY_OPTION_CHARS) continue
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
