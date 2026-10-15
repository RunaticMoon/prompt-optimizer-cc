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
 * resume may leave older ones; an empty last body clears the field). The
 * `UserPromptSubmit` blocks are attributed per user message rather than per
 * position in the block order, and only the ones belonging to the LAST message
 * that holds a person's prompt are kept (the memory retrieved for the previous
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

/**
 * Text blocks the engine wraps around its own output: its reminders, the
 * transcript of a slash command, a bash tool's input and output, and its notice
 * that a person interrupted the turn. Such a block is never a person's own
 * prompt and never injected long-term memory, so it must not confirm or clear a
 * `UserPromptSubmit` group. Matched as a whole-block prefix after trimming.
 *
 * The reminder opener and the command wrappers are the 2.1.300 measured shapes
 * (verify-E-REPORT.md: running `/optimize` adds `<local-command-caveat>`,
 * `<command-name>`, `<local-command-stdout>` blocks beside the prompt); the
 * bash wrappers and the interrupt notice are engine notations.
 */
const ENGINE_WRAPPER_PREFIXES: readonly string[] = [
  '<system-reminder>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '[Request interrupted by user',
]

/** True when a text block is entirely the engine's own output, not a prompt. */
function isEngineWrapper(text: string): boolean {
  const trimmed = text.trim()
  return ENGINE_WRAPPER_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

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
 * User messages are read one at a time, and each text block is classified:
 *
 * - A whole-block `SessionStart`/`UserPromptSubmit` envelope is captured; its
 *   body is trimmed and an empty body is dropped. The LAST `SessionStart` body
 *   wins (a resume may leave older ones), and an empty last body yields `[]`
 *   instead of falling back to an older block.
 * - A block the engine wrapped (`<system-reminder>`, the local-command/bash
 *   wrappers, an interrupt notice — {@link ENGINE_WRAPPER_PREFIXES}) is neither
 *   a person's prompt nor injected memory, so a slash command run between two
 *   prompts cannot pass for a prompt.
 * - Any other non-empty block is the person's own prompt.
 *
 * Attribution is per message, so the order of the blocks inside one message
 * does not matter: the bodies a message carries belong to that message. Bodies
 * seen in a message without a person's prompt (commands only, tool results
 * only) are held pending and belong to the next message that does hold a
 * prompt, which confirms them. The LAST confirmed group is the result, so a
 * last person-prompt message with no memory (its own or still pending) yields
 * `[]` rather than an older group.
 */
export function extractHookMemory(messages: readonly ApiMessage[]): CapturedMemory {
  let sessionStart: string[] = []
  let confirmed: string[] = []
  let pending: string[] = []

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue

    const bodies: string[] = []
    let hasPersonPrompt = false

    for (const text of textBlocks(message)) {
      const match = INJECTED_CONTEXT.exec(text)
      if (match !== null) {
        const body = (match[2] ?? '').trim()
        if (match[1] === 'SessionStart') {
          // The last SessionStart block is authoritative even when its body is
          // empty: a resume's older block must not stand in for it.
          sessionStart = body === '' ? [] : [body]
        } else if (body !== '') {
          bodies.push(body)
        }
        continue
      }
      if (isEngineWrapper(text)) continue
      if (text.trim() === '') continue
      hasPersonPrompt = true
    }

    if (hasPersonPrompt) {
      // This message's own bodies plus whatever earlier prompt-less messages
      // left pending belong to it; the ones after the last prompt stay unused.
      confirmed = [...pending, ...bodies]
      pending = []
    } else {
      pending.push(...bodies)
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
