/**
 * Task D — the injected-memory reader and its snapshot renderer.
 *
 * Pure: no `$`, no I/O, no clock. Other plugins and settings inject long-term
 * memory into the main session through their `SessionStart`/`UserPromptSubmit`
 * hooks. On an organization-managed Claude Code this plugin's own `classic.*`
 * hooks are skipped (and a load-time note says so), so this module no longer
 * observes the classic chain. Instead {@link extractHookMemory} reads the main
 * conversation in Messages API form (`$.session.messages({ as: "api" })`,
 * wired in `register.ts`) and pulls the injected `additionalContext` blocks the
 * hooks left there as `<system-reminder>` text blocks. {@link renderMemory}
 * turns whatever it finds into the bounded "Long-term memory" section that
 * `collectContext` in `context.ts` folds into the snapshot.
 *
 * Extraction is stateless and re-run per snapshot: the conversation already
 * holds the authoritative latest blocks, so `/clear`, `/compact` and resume
 * need no bookkeeping here. Only the LAST `SessionStart` block is kept (a
 * resume may leave older ones), and only the `UserPromptSubmit` blocks that
 * precede the LAST person's prompt (the memory retrieved for the previous
 * prompt, not for the prompt being optimized now).
 */

import { truncateHead } from './context'
import type { ApiMessage, CapturedMemory } from './contracts'

/**
 * A block that is entirely one injected-context envelope. Only a whole-block
 * match counts: a block that merely quotes the marker text inside other prose
 * is a person's text or an engine reminder, not an injected block.
 */
const INJECTED_CONTEXT =
  /^\s*<system-reminder>\s*\n(SessionStart|UserPromptSubmit) hook additional context: ([\s\S]*?)\s*<\/system-reminder>\s*$/

/** The text blocks of one API message, in order; a string content is one block. */
function textBlocks(message: ApiMessage): string[] {
  const content = message.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    // Only `text` blocks carry hook-injected context; a `tool_result` block is
    // not a person's prompt and is skipped with the other non-text kinds.
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    texts.push(block.text)
  }
  return texts
}

/**
 * Pulls the settings/plugin-injected memory out of the main conversation.
 *
 * User-message text blocks are scanned in order:
 *
 * - A whole-block `SessionStart`/`UserPromptSubmit` envelope is captured; its
 *   body is trimmed and an empty body is dropped. The LAST `SessionStart` body
 *   wins (a resume may leave older ones).
 * - A block that starts with `<system-reminder>` is an engine reminder and
 *   neither a person's prompt nor injected memory.
 * - Any other non-empty block is the person's own prompt: the
 *   `UserPromptSubmit` bodies collected since the previous prompt are confirmed
 *   as that prompt's memory. The LAST confirmed group is the result, so
 *   `UserPromptSubmit` blocks left after the last prompt are not used and a
 *   last prompt with none yields `[]`.
 */
export function extractHookMemory(messages: readonly ApiMessage[]): CapturedMemory {
  let sessionStart: string[] = []
  let confirmed: string[] = []
  let pending: string[] = []

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    for (const text of textBlocks(message)) {
      const match = INJECTED_CONTEXT.exec(text)
      if (match !== null) {
        const body = (match[2] ?? '').trim()
        if (body === '') continue
        if (match[1] === 'SessionStart') sessionStart = [body]
        else pending.push(body)
        continue
      }
      if (text.trim().startsWith('<system-reminder>')) continue
      if (text.trim() === '') continue
      // The person's own prompt: the collected UserPromptSubmit bodies belong
      // to it and the ones after the last prompt stay unconfirmed.
      confirmed = pending
      pending = []
    }
  }

  return { sessionStart, lastPrompt: confirmed }
}

/**
 * Reads the conversation through `read` and renders the memory it holds. A
 * refusing read, or one that does not resolve to an array, yields no memory;
 * the caller's round goes on regardless. The result is
 * `renderMemory(extractHookMemory(...), maxChars)`.
 */
export async function readHookMemory(
  read: () => Promise<unknown>,
  maxChars: number,
): Promise<string> {
  let messages: readonly ApiMessage[] = []
  try {
    const value = await read()
    if (Array.isArray(value)) messages = value as readonly ApiMessage[]
  } catch {
    return ''
  }
  return renderMemory(extractHookMemory(messages), maxChars)
}

const SESSION_START_HEADING = '### Injected at session start'

const LAST_PROMPT_HEADING =
  '### Injected for the previous prompt (not retrieved for this prompt)'

/**
 * Renders the captured memory as a bounded snapshot section. Both fields get
 * their head kept, with the truncation marker when cut; the previous-prompt
 * body may use at most 40% of `maxChars`, and whatever it leaves stays with
 * the session-start body. The whole result is at most `maxChars` characters.
 */
export function renderMemory(memory: CapturedMemory, maxChars: number): string {
  const budget = Math.max(0, maxChars)
  const sessionEntries = memory.sessionStart.filter(entry => entry.trim().length > 0)
  const promptEntries = memory.lastPrompt.filter(entry => entry.trim().length > 0)
  if (sessionEntries.length === 0 && promptEntries.length === 0) return ''

  const sections: { heading: string; body: string }[] = []
  let overhead = 0
  if (sessionEntries.length > 0) {
    sections.push({ heading: SESSION_START_HEADING, body: sessionEntries.join('\n\n') })
    overhead += SESSION_START_HEADING.length + 1
  }
  if (promptEntries.length > 0) {
    sections.push({ heading: LAST_PROMPT_HEADING, body: promptEntries.join('\n\n') })
    overhead += LAST_PROMPT_HEADING.length + 1
  }
  if (sections.length > 1) overhead += 2

  const bodyBudget = Math.max(0, budget - overhead)
  const promptCap = Math.min(bodyBudget, Math.floor(budget * 0.4))

  const sessionSection = sections.find(section => section.heading === SESSION_START_HEADING)
  const promptSection = sections.find(section => section.heading === LAST_PROMPT_HEADING)
  const promptBody =
    promptSection === undefined ? '' : truncateHead(promptSection.body, promptCap)
  const sessionBody =
    sessionSection === undefined
      ? ''
      : truncateHead(sessionSection.body, Math.max(0, bodyBudget - promptBody.length))

  const rendered = sections
    .map(section => {
      const body = section.heading === SESSION_START_HEADING ? sessionBody : promptBody
      return `${section.heading}\n${body}`
    })
    .join('\n\n')

  return rendered.length <= budget ? rendered : truncateHead(rendered, budget)
}
