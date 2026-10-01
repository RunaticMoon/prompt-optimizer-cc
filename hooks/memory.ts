/**
 * Task D — the captured long-term memory store and its snapshot renderer.
 *
 * Pure: no `$`, no I/O, no clock. Other plugins inject long-term memory into
 * the main session through their settings hooks; the mod's own `classic.*`
 * hooks observe those `additionalContext` entries (wired in `register.ts`) and
 * hand them to {@link createMemoryStore}. {@link renderMemory} turns whatever
 * the store holds into the bounded "Long-term memory" section that
 * `collectContext` in `context.ts` folds into the snapshot.
 *
 * The store holds one session at a time: each record carries the classic hook's
 * `e.session_id`, and the first record for a new id adopts it, dropping the
 * previous session's memory. The snapshot reads through
 * {@link MemoryStore.latest}, which follows the classic hook's id: `/clear`
 * changes that id without a `session.start`, so the new session's SessionStart
 * (with no `session.start` behind it) is still what the next request sees.
 * {@link MemoryStore.current} stays for callers that must key by a known id,
 * and `session.end` clears only the ending session's record.
 */

import { truncateHead } from './context'
import type { CapturedMemory } from './contracts'

/** Holds the latest memory observed for the most recently recorded session. */
export interface MemoryStore {
  /** The captured memory for `sessionId`; empty unless it is the stored session. */
  current(sessionId: string): CapturedMemory
  /**
   * The captured memory for the session the store last adopted, whatever its
   * id; empty when none has been adopted. This is the snapshot's read key: it
   * follows the classic hook's `session_id`, which `/clear` changes without a
   * `session.start`.
   */
  latest(): CapturedMemory
  /** The id of the session the store last adopted, or `''` when none has been. */
  storedSessionId(): string
  /** Replaces the session-start entries for `sessionId` (`undefined` clears them). */
  recordSessionStart(sessionId: string, entries: readonly string[] | undefined): void
  /** Replaces the previous-prompt entries for `sessionId` (`undefined` clears them). */
  recordPromptSubmit(sessionId: string, entries: readonly string[] | undefined): void
  /**
   * Clears the store only when `sessionId` is the stored session; a different
   * or empty id leaves it untouched. Used at `session.end` so an already
   * captured next session (e.g. a `/clear` whose SessionStart arrived first)
   * survives the ending session's end.
   */
  resetSession(sessionId: string): void
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
  let sessionId = ''
  let sessionStart: string[] = []
  let lastPrompt: string[] = []

  /** Adopts `id` as the stored session, dropping whatever the previous one held. */
  const adopt = (id: string): void => {
    if (id === sessionId) return
    sessionId = id
    sessionStart = []
    lastPrompt = []
  }

  return {
    current(id: string): CapturedMemory {
      if (id === '' || id !== sessionId) return { sessionStart: [], lastPrompt: [] }
      return { sessionStart: [...sessionStart], lastPrompt: [...lastPrompt] }
    },
    latest(): CapturedMemory {
      return { sessionStart: [...sessionStart], lastPrompt: [...lastPrompt] }
    },
    storedSessionId(): string {
      return sessionId
    },
    recordSessionStart(id: string, entries: readonly string[] | undefined): void {
      adopt(id)
      sessionStart = clean(entries)
    },
    recordPromptSubmit(id: string, entries: readonly string[] | undefined): void {
      adopt(id)
      lastPrompt = clean(entries)
    },
    resetSession(id: string): void {
      if (id === '' || id !== sessionId) return
      sessionId = ''
      sessionStart = []
      lastPrompt = []
    },
  }
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
