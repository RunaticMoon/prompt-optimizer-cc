/**
 * The composer draft's composition: what the plugin saw build the box since it
 * was last empty.
 *
 * Pure and synchronous. Each `note*` function folds one observation (an edit
 * event, the box's text, an autocomplete event) into a {@link Composition} and
 * returns the next value, leaving its input untouched, so the caller can keep
 * the running value in its own state and later ask whether the submitted draft
 * was the person's own writing.
 *
 * The signals come from measurement (PSTB-2735, A-REPORT §5·§7). Pasting,
 * another app's injection (Orca) and a fast key burst all arrive as a key-less
 * `prompt.edit`; human typing carries a `key`, and a key-less burst is only a
 * few characters (measured: at most six). A long paste collapses to a
 * `[Pasted text #N ...]` placeholder that only `prompt.autocomplete` shows,
 * and pressing Enter right after one can submit with no event at all.
 */

/** What the plugin saw build the current composer draft since the box was last empty. */
export interface Composition {
  /** A key stroke, or a short key-less burst (fast typing), edited the draft. */
  typed: boolean
  /** Characters inserted by key-less edits of at least PASTE_MIN_CHARS (pastes, app injections). */
  pastedChars: number
  /** A collapsed paste placeholder was seen in the box. */
  placeholder: boolean
  /** Any edit or autocomplete event arrived for this draft. */
  observed: boolean
}

/** A draft nothing has built: the box is empty, or no event was seen for it. */
export const EMPTY_COMPOSITION: Composition = Object.freeze({
  typed: false,
  pastedChars: 0,
  placeholder: false,
  observed: false,
})

/**
 * Shortest key-less insertion counted as a paste.
 *
 * A fast typist also produces key-less bursts, but measurement found them to be
 * at most six characters, so eight separates typing from pasting or another
 * app's injection (PSTB-2735 §7, signal S1).
 */
export const PASTE_MIN_CHARS = 8

/** The collapsed paste placeholder as `prompt.autocomplete` shows it. */
const PASTE_PLACEHOLDER = /\[Pasted text #\d+(?: \+\d+ lines)?\]/

/**
 * Folds one `prompt.edit` event into the draft's composition.
 *
 * A carried `key` is the person typing. Without a key, an insertion of at least
 * {@link PASTE_MIN_CHARS} characters is a paste or an app's injection, a 1-7
 * character one is a fast-typing burst (counts as typing), and an empty
 * `inputText` is a key-less delete or move that changes nothing else. Every
 * event marks the draft as observed.
 *
 * @param c the draft's composition so far
 * @param e the edit's `key`, when the engine reported one, and its inserted text
 * @returns the next composition; `c` is not modified
 */
export function noteEditInput(c: Composition, e: { key?: unknown; inputText: string }): Composition {
  const observed = { ...c, observed: true }
  if (e.key !== undefined) return { ...observed, typed: true }
  if (e.inputText.length >= PASTE_MIN_CHARS) {
    return { ...observed, pastedChars: c.pastedChars + e.inputText.length }
  }
  if (e.inputText.length > 0) return { ...observed, typed: true }
  return observed
}

/**
 * Folds the box's current text into the draft's composition.
 *
 * An emptied box starts a fresh draft: everything seen before belonged to the
 * draft that was sent or dropped from it. Any other text leaves the value as
 * it is.
 *
 * @param c the draft's composition so far
 * @param text the box's text as last read
 * @returns {@link EMPTY_COMPOSITION} for an empty box, otherwise `c`
 */
export function noteBox(c: Composition, text: string): Composition {
  return text.trim() === '' ? EMPTY_COMPOSITION : c
}

/**
 * Folds one `prompt.autocomplete` event into the draft's composition.
 *
 * A long paste shows up only here, as a collapsed placeholder, so seeing one
 * marks the draft as pasted even when no edit arrived for it.
 *
 * @param c the draft's composition so far
 * @param text the autocomplete text
 * @returns the next composition; `c` is not modified
 */
export function noteAutocomplete(c: Composition, text: string): Composition {
  return { ...c, observed: true, placeholder: c.placeholder || PASTE_PLACEHOLDER.test(text) }
}

/**
 * Whether the draft was only pasted, or injected by another app, and never
 * typed in.
 *
 * True when the person typed nothing and either a large key-less insertion was
 * seen, a paste placeholder was seen, or nothing at all was observed (a paste
 * followed by an immediate Enter can submit with no event). A typed draft is
 * never paste-only.
 *
 * @param c the draft's composition
 * @returns whether the draft is paste-only
 */
export function isPasteOnly(c: Composition): boolean {
  return !c.typed && (c.pastedChars > 0 || c.placeholder || !c.observed)
}
