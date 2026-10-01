/**
 * Task D — the captured long-term memory store and its snapshot renderer.
 *
 * Pure: no `$`, no I/O, no clock. Other plugins inject long-term memory into
 * the main session through their settings hooks; the mod's own `classic.*`
 * hooks observe those `additionalContext` entries (wired in a later task) and
 * hand them to {@link createMemoryStore}. {@link renderMemory} turns whatever
 * the store holds into the bounded "Long-term memory" section that
 * `collectContext` in `context.ts` folds into the snapshot.
 */

import { CONTEXT_TRUNCATION_MARK } from './context'
import type { CapturedMemory } from './contracts'

/** Holds the latest memory observed for one session. */
export interface MemoryStore {
  /** The current captured memory. */
  current(): CapturedMemory
  /** Replaces the session-start entries (`undefined` clears them). */
  recordSessionStart(entries: readonly string[] | undefined): void
  /** Replaces the previous-prompt entries (`undefined` clears them). */
  recordPromptSubmit(entries: readonly string[] | undefined): void
  /** Clears both fields. */
  reset(): void
}

/** Trims every entry and drops those that are empty (or whitespace only). */
function clean(entries: readonly string[] | undefined): string[] {
  if (entries === undefined) return []
  const out: string[] = []
  for (const entry of entries) {
    const text = entry.trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

/** A fresh store, backed by closure state. */
export function createMemoryStore(): MemoryStore {
  let sessionStart: string[] = []
  let lastPrompt: string[] = []

  return {
    current(): CapturedMemory {
      return { sessionStart: [...sessionStart], lastPrompt: [...lastPrompt] }
    },
    recordSessionStart(entries: readonly string[] | undefined): void {
      sessionStart = clean(entries)
    },
    recordPromptSubmit(entries: readonly string[] | undefined): void {
      lastPrompt = clean(entries)
    },
    reset(): void {
      sessionStart = []
      lastPrompt = []
    },
  }
}

const SESSION_START_HEADING = '### Injected at session start'

const LAST_PROMPT_HEADING =
  '### Injected for the previous prompt (not retrieved for this prompt)'

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** First `end` characters, never splitting a surrogate pair. */
function safeHead(text: string, end: number): string {
  if (end >= text.length) return text
  let cut = end < 0 ? 0 : end
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1
  return text.slice(0, cut)
}

/** Keeps the head, appends the truncation marker, within `cap` characters. */
function truncateHead(text: string, cap: number): string {
  if (text.length <= cap) return text
  if (cap <= CONTEXT_TRUNCATION_MARK.length) return safeHead(text, Math.max(0, cap))
  return `${safeHead(text, cap - CONTEXT_TRUNCATION_MARK.length)}${CONTEXT_TRUNCATION_MARK}`
}

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
