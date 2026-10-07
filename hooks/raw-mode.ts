/**
 * The optimizer-off mode's decision for one prompt-box edit ("RAW-677D").
 *
 * Pure and synchronous: it reads the edit's facts, the armed flag, the raw
 * prefix and the workflow flag, and returns what the caller should do with the
 * edit. It never touches the engine or the store, so the mode's rules are
 * testable in isolation and the controller can inspect the decision before it
 * consumes the edit or emits a state event.
 *
 * The person types `rawPrefix` (default `>> `) at the very start of the prompt
 * box: the marker disappears and the box becomes the rest of the text. A paste
 * whose text merely happens to start with the marker (`>> ` quote) is not a
 * key stroke, so it stays as ordinary text unless the burst is no longer than
 * the marker itself.
 */

import type { ClientKeyEvent } from 'claude-code'

/** The facts of one prompt-box edit this module reads (a subset of PromptEditInput). */
export interface RawEditFacts {
  key?: ClientKeyEvent
  text: string
  cursor: number
  start: number
  end: number
  inputText: string
}

/** What one prompt-box edit should do to the box and the mode. */
export type RawEditDecision =
  | { kind: 'arm'; box: { text: string; cursor: number } }
  | { kind: 'release'; box: { text: string; cursor: number } }
  | { kind: 'pass' }

/** Hint shown at the end of the prompt hint line while the mode is armed. */
export const RAW_MODE_HINT = '최적화 끔 ctrl+u 켜기'

/**
 * Decides what one prompt edit means for the optimizer-off mode.
 *
 * @param e the edit's facts, as `prompt.edit` reports them
 * @param armed whether the mode is currently on for this session
 * @param rawPrefix the configured leading marker; empty disables the mode
 * @param workflowActive whether an optimizer workflow holds the composer
 * @returns `arm` (consume the edit and turn the mode on), `release` (consume
 *   the edit and turn the mode off), or `pass` (let the edit through)
 */
export function decideRawEdit(
  e: RawEditFacts,
  armed: boolean,
  rawPrefix: string,
  workflowActive: boolean,
): RawEditDecision {
  // 1. While armed, ctrl+u anywhere consumes the edit and only turns the mode
  //    off; the box keeps the text and caret it already had.
  if (armed && e.key?.key === 'u' && e.key.ctrl === true) {
    return { kind: 'release', box: { text: e.text, cursor: e.cursor } }
  }

  // 2. While armed, every other edit is the person's own writing: pass.
  if (armed) return { kind: 'pass' }

  // 3. Nothing can arm: the mode is off, a workflow owns the composer, or the
  //    edit carries no inserted text.
  if (rawPrefix === '' || workflowActive || e.inputText === '') return { kind: 'pass' }

  // 4. Arm only when this edit starts the box with the whole marker. A single
  //    key stroke counts as typed even when its text is shorter than the
  //    marker; for a paste (no `key`), only a burst no longer than the marker
  //    itself counts, so pasting `>> ` quote text does not arm.
  const after = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
  const typed = e.key !== undefined || e.inputText.length <= rawPrefix.length
  if (
    typed &&
    e.start < rawPrefix.length &&
    after.startsWith(rawPrefix) &&
    !e.text.startsWith(rawPrefix)
  ) {
    return {
      kind: 'arm',
      box: {
        text: after.slice(rawPrefix.length),
        cursor: Math.max(0, e.start + e.inputText.length - rawPrefix.length),
      },
    }
  }

  // 5. Everything else is ordinary editing.
  return { kind: 'pass' }
}
