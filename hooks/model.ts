/**
 * Task F — one independent model completion turned into a validated
 * {@link RewriteResult}.
 *
 * {@link buildModelRequest} assembles the one-shot request: the configured
 * model, `effort`, `maxTokens` and `timeoutMs`, the caller's system prompt,
 * and a tagged prompt holding the context snapshot, the original prompt, the
 * current draft, the recent dialogue and the caller's instruction. The whole
 * prompt plus system stays within {@link MAX_REQUEST_CHARS}: first the oldest
 * dialogue turns are dropped, then the context is trimmed; the original prompt
 * is never cut.
 *
 * {@link completeRewrite} makes exactly one `$.model.complete` call — no retry,
 * no model fallback, no `$.model.fork` — and maps every outcome (answer,
 * invalid JSON, empty draft, API error, abort, reject) to a {@link RewriteResult}
 * that always carries `usage`.
 *
 * {@link parseReply} reads the fixed JSON contract: an optional code fence is
 * ignored, the first `{` to the last `}` is parsed, and only `draft`, `message`
 * and `question` are read.
 */

import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'

import {
  DEFAULT_EFFORT,
  type EnginePorts,
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
}

/** Renders the tagged prompt; the selected dialogue stays in time order. */
function renderPrompt(parts: PromptParts): string {
  const blocks: string[] = []
  if (parts.context !== '') blocks.push(`<context>\n${parts.context}\n</context>`)
  blocks.push(`<original_prompt>\n${parts.original}\n</original_prompt>`)
  if (parts.draft !== null) blocks.push(`<current_draft>\n${parts.draft}\n</current_draft>`)
  if (parts.dialogue.length > 0) {
    // Selection is newest-first (see buildModelRequest); the kept turns read
    // oldest first here so the model follows the conversation in order.
    const lines = parts.dialogue.map(message => `${message.role}: ${message.text}`).join('\n')
    blocks.push(`<dialogue>\n${lines}\n</dialogue>`)
  }
  if (parts.instruction !== '') blocks.push(`<instruction>\n${parts.instruction}\n</instruction>`)
  blocks.push('JSON 객체만 출력한다. 코드 펜스 없이 위 계약의 JSON 객체 하나만 보낸다.')
  return blocks.join('\n\n')
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
 * dialogue turns are kept (the oldest are dropped first), then the context text
 * is trimmed from its tail; the kept dialogue is rendered oldest first, and the
 * original prompt is never truncated.
 */
export function buildModelRequest(
  workflow: Readonly<Workflow>,
  config: OptimizerConfig,
  system: string,
  instruction?: string,
): ModelCompleteRequest {
  const original = workflow.original
  const draft = workflow.draft !== '' && workflow.draft !== original ? workflow.draft : null
  const instructionText = instruction !== undefined ? instruction : lastUserInstruction(workflow.dialogue) ?? ''

  const dialogue = workflow.dialogue.slice()
  let context = workflow.context?.text ?? ''

  const build = (): string =>
    renderPrompt({ context, original, draft, dialogue, instruction: instructionText })

  let prompt = build()

  // 1) Drop the oldest dialogue turns until the request fits.
  while (prompt.length + system.length > MAX_REQUEST_CHARS && dialogue.length > 0) {
    dialogue.shift()
    prompt = build()
  }

  // 2) Trim the context from its tail, keeping its head.
  if (prompt.length + system.length > MAX_REQUEST_CHARS && context !== '') {
    const overflow = prompt.length + system.length - MAX_REQUEST_CHARS
    context = context.slice(0, Math.max(0, context.length - overflow))
    prompt = build()
  }

  return {
    model: config.model,
    prompt,
    system,
    maxTokens: config.maxTokens,
    effort: DEFAULT_EFFORT,
    timeoutMs: config.timeoutMs,
  }
}

/** Describes an API-error arm, naming its status and error kind. */
function describeApiError(result: { status: number | null; error: string }): string {
  const status = result.status === null ? 'no response' : `status ${result.status}`
  return `the optimizer API call failed (${status}: ${result.error})`
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
      return { kind: 'failed', reason: 'aborted', message: 'the optimizer completion was aborted', usage }
    }
    if (result.reason === 'empty-reply') {
      return { kind: 'failed', reason: 'empty-reply', message: 'the model returned no text', usage }
    }
    return { kind: 'failed', reason: 'api-error', message: describeApiError(result), usage }
  }

  if (result.text.trim() === '') {
    return { kind: 'failed', reason: 'empty-reply', message: 'the model returned no text', usage }
  }

  const parsed = parseReply(result.text)
  if (!parsed.ok) {
    return {
      kind: 'failed',
      reason: parsed.reason,
      message:
        parsed.reason === 'empty-draft'
          ? 'the model reply carried no draft'
          : 'the model reply was not valid JSON',
      usage,
    }
  }

  return { kind: 'ok', reply: parsed.reply, usage }
}

/**
 * Parses one reply against the fixed JSON contract.
 *
 * Surrounding whitespace and a code fence are tolerated: the first `{` to the
 * last `}` is extracted and parsed. `draft` must be a non-empty string (trimmed);
 * `message` defaults to `''`; `question` is a non-empty string or `null`. Any
 * other field is ignored. A missing object or unparseable JSON is `invalid-json`;
 * a missing or blank draft is `empty-draft`.
 */
export function parseReply(
  text: string,
): { ok: true; reply: OptimizerReply } | { ok: false; reason: 'invalid-json' | 'empty-draft' } {
  const body = text.trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end < start) return { ok: false, reason: 'invalid-json' }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' }
  }

  const record = parsed as Record<string, unknown>
  const draft = typeof record.draft === 'string' ? record.draft.trim() : ''
  if (draft === '') return { ok: false, reason: 'empty-draft' }

  const message = typeof record.message === 'string' ? record.message : ''
  const question =
    typeof record.question === 'string' && record.question.trim() !== '' ? record.question : null

  return { ok: true, reply: { draft, message, question } }
}
