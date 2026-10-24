import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_COMPOSITION,
  PASTE_MIN_CHARS,
  classifyComposition,
  isPasteOnly,
  noteAutocomplete,
  noteBox,
  noteEditInput,
} from '../hooks/composition'
import type { Composition } from '../hooks/composition'
import { COMPOSITION_CASES, type CompositionStep } from './fixtures/composition-cases'

/** One key-less paste of `text`, as `prompt.edit` reports an injected insertion. */
function paste(c: Composition, text: string): Composition {
  return noteEditInput(c, { inputText: text })
}

/** One key stroke inserting `text`, as `prompt.edit` reports human typing. */
function type(c: Composition, text: string): Composition {
  return noteEditInput(c, { key: { key: 'a' }, inputText: text })
}

describe('composition — constants', () => {
  test('an empty draft is all false and zero', () => {
    expect(EMPTY_COMPOSITION).toEqual({ typed: false, pastedChars: 0, placeholder: false, observed: false })
  })

  test('the paste threshold is eight characters', () => {
    expect(PASTE_MIN_CHARS).toBe(8)
  })
})

describe('isPasteOnly', () => {
  test('a draft built by one paste of at least the threshold is paste-only', () => {
    const c = paste(EMPTY_COMPOSITION, 'a'.repeat(PASTE_MIN_CHARS))
    expect(c.pastedChars).toBe(PASTE_MIN_CHARS)
    expect(isPasteOnly(c)).toBe(true)
  })

  test('a draft with any key stroke mixed in is not paste-only', () => {
    const c = type(paste(EMPTY_COMPOSITION, 'a pasted sentence'), 'x')
    expect(c.typed).toBe(true)
    expect(isPasteOnly(c)).toBe(false)
  })

  test('a key-less burst of two to six characters counts as typing', () => {
    for (const len of [1, 2, 3, 6, PASTE_MIN_CHARS - 1]) {
      const c = paste(EMPTY_COMPOSITION, 'x'.repeat(len))
      expect(c.pastedChars).toBe(0)
      expect(c.typed).toBe(true)
      expect(isPasteOnly(c)).toBe(false)
    }
  })

  test('a placeholder autocomplete with no edit is paste-only', () => {
    const c = noteAutocomplete(EMPTY_COMPOSITION, '[Pasted text #1 +29 lines]')
    expect(c.placeholder).toBe(true)
    expect(isPasteOnly(c)).toBe(true)
  })

  test('a plain autocomplete with no edit is not paste-only', () => {
    const c = noteAutocomplete(EMPTY_COMPOSITION, '/optimize')
    expect(c.placeholder).toBe(false)
    expect(isPasteOnly(c)).toBe(false)
  })

  test('a draft with nothing observed is paste-only', () => {
    // A long paste followed by an immediate Enter can submit with no event.
    expect(isPasteOnly(EMPTY_COMPOSITION)).toBe(true)
  })

  test('typing then pasting is not paste-only', () => {
    const c = paste(type(EMPTY_COMPOSITION, 'fix'), ' the whole log file')
    expect(isPasteOnly(c)).toBe(false)
  })

  test('emptying the box starts a fresh draft', () => {
    const pasted = paste(EMPTY_COMPOSITION, 'a pasted sentence')
    expect(isPasteOnly(pasted)).toBe(true)
    expect(noteBox(pasted, '   \n\t ')).toEqual(EMPTY_COMPOSITION)
    expect(noteBox(pasted, '')).toEqual(EMPTY_COMPOSITION)
  })

  test('a short key-less burst is typing even when a paste came first', () => {
    const c = type(noteBox(paste(EMPTY_COMPOSITION, 'a pasted sentence'), ''), 'ok')
    expect(isPasteOnly(c)).toBe(false)
  })

  test('a paste after a placeholder stays paste-only', () => {
    const c = paste(noteAutocomplete(EMPTY_COMPOSITION, '[Pasted text #1]'), 'x'.repeat(20))
    expect(c.placeholder).toBe(true)
    expect(isPasteOnly(c)).toBe(true)
  })
})

describe('noteEditInput', () => {
  test('only an insertion of at least the threshold adds pasted characters', () => {
    const c = paste(EMPTY_COMPOSITION, 'a'.repeat(PASTE_MIN_CHARS + 4))
    expect(c.pastedChars).toBe(PASTE_MIN_CHARS + 4)
    expect(c.observed).toBe(true)
  })

  test('pasted characters accumulate across edits', () => {
    const c = paste(paste(EMPTY_COMPOSITION, 'a'.repeat(10)), 'b'.repeat(12))
    expect(c.pastedChars).toBe(22)
  })

  test('a key stroke marks typing without pasted characters', () => {
    const c = type(EMPTY_COMPOSITION, 'hello')
    expect(c).toEqual({ typed: true, pastedChars: 0, placeholder: false, observed: true })
  })

  test('a key-less empty edit observes the draft but changes nothing else', () => {
    const before = paste(EMPTY_COMPOSITION, 'a pasted sentence')
    const after = noteEditInput(before, { inputText: '' })
    expect(after).toEqual({ ...before, observed: true })
  })

  test('a typed draft is not reset by a key-less empty edit', () => {
    const after = noteEditInput(type(EMPTY_COMPOSITION, 'hi'), { inputText: '' })
    expect(after.typed).toBe(true)
  })
})

describe('noteBox', () => {
  test('a non-empty box keeps the composition it applies to', () => {
    const c = paste(EMPTY_COMPOSITION, 'a pasted sentence')
    expect(noteBox(c, 'a pasted sentence')).toBe(c)
  })

  test('an empty box returns the shared empty value', () => {
    expect(noteBox(paste(EMPTY_COMPOSITION, 'a pasted sentence'), '   ')).toBe(EMPTY_COMPOSITION)
  })
})

describe('noteAutocomplete', () => {
  test('a placeholder is recognized with and without the line count', () => {
    for (const text of ['[Pasted text #1 +29 lines]', '[Pasted text #12]']) {
      expect(noteAutocomplete(EMPTY_COMPOSITION, text).placeholder).toBe(true)
    }
  })

  test('ordinary text is observed but not a placeholder', () => {
    const c = noteAutocomplete(EMPTY_COMPOSITION, 'composer text')
    expect(c).toEqual({ typed: false, pastedChars: 0, placeholder: false, observed: true })
  })

  test('a placeholder stays once seen', () => {
    const c = noteAutocomplete(noteAutocomplete(EMPTY_COMPOSITION, '[Pasted text #3]'), 'plain')
    expect(c.placeholder).toBe(true)
  })
})

describe('inputs are never modified', () => {
  test('every note function returns a new value and leaves its input intact', () => {
    const original: Composition = Object.freeze({
      typed: false,
      pastedChars: 0,
      placeholder: false,
      observed: false,
    })
    const snapshot = { ...original }

    const edited = noteEditInput(original, { inputText: 'a pasted sentence' })
    const typed = noteEditInput(original, { key: { key: 'a' }, inputText: 'a' })
    const blanked = noteBox(original, '')
    const kept = noteBox(original, 'text')
    const completed = noteAutocomplete(original, '[Pasted text #1]')
    const classified = classifyComposition(original)

    expect(original).toEqual(snapshot)
    expect(edited).not.toBe(original)
    expect(typed).not.toBe(original)
    expect(blanked).not.toBe(original)
    expect(kept).toBe(original)
    expect(completed).not.toBe(original)
    expect(classified).toEqual({ pasted: true, reason: 'no-input-events' })
  })

  test('the empty value is frozen', () => {
    expect(Object.isFrozen(EMPTY_COMPOSITION)).toBe(true)
  })
})

/** Folds one fixture's steps into a composition, as the host would report them. */
function fold(steps: readonly CompositionStep[]): Composition {
  let c = EMPTY_COMPOSITION
  for (const step of steps) {
    if (step.kind === 'edit') c = noteEditInput(c, step.key !== undefined ? { key: step.key, inputText: step.inputText } : step)
    else if (step.kind === 'autocomplete') c = noteAutocomplete(c, step.text)
    else c = noteBox(c, step.text)
  }
  return c
}

describe('classifyComposition — synthetic fixtures', () => {
  test('every fixture folds to its documented verdict', () => {
    for (const kase of COMPOSITION_CASES) {
      expect(classifyComposition(fold(kase.steps)), kase.id).toEqual(kase.expected)
    }
  })

  test('each fixture id is unique and every case is marked synthetic and unverified', () => {
    const ids = COMPOSITION_CASES.map(kase => kase.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const kase of COMPOSITION_CASES) {
      expect(kase.source).toBe('synthetic')
      expect(kase.terminal).toBe('unverified')
      expect(kase.expected.reason).toBeDefined()
    }
  })

  test('a Korean short commit is typed while a long one-batch commit reads as pasted', () => {
    const short = COMPOSITION_CASES.find(kase => kase.id === 'korean-short-commit')!
    const long = COMPOSITION_CASES.find(kase => kase.id === 'korean-long-commit')!
    expect(classifyComposition(fold(short.steps))).toEqual({ pasted: false, reason: 'typed' })
    expect(classifyComposition(fold(long.steps))).toEqual({ pasted: true, reason: 'keyless-long-insert' })
  })

  test('a Japanese long conversion shares the key-less long insertion verdict', () => {
    const kase = COMPOSITION_CASES.find(kase => kase.id === 'japanese-long-conversion')!
    expect(classifyComposition(fold(kase.steps))).toEqual({ pasted: true, reason: 'keyless-long-insert' })
  })

  test('key-less bursts up to seven characters stay typed and eight crosses the threshold', () => {
    for (const [id, pasted] of [
      ['keyless-burst-1', false],
      ['keyless-burst-6', false],
      ['keyless-burst-7', false],
      ['keyless-burst-8-boundary', true],
    ] as const) {
      const kase = COMPOSITION_CASES.find(k => k.id === id)!
      expect(classifyComposition(fold(kase.steps)).pasted, id).toBe(pasted)
    }
  })

  test('a short paste is currently indistinguishable from a fast typing burst', () => {
    const kase = COMPOSITION_CASES.find(k => k.id === 'short-paste-ambiguity')!
    const burst = COMPOSITION_CASES.find(k => k.id === 'keyless-burst-1')!
    expect(classifyComposition(fold(kase.steps))).toEqual(classifyComposition(fold(burst.steps)))
  })

  test('a long paste and an external app injection share one verdict', () => {
    const paste = COMPOSITION_CASES.find(k => k.id === 'long-paste')!
    const injection = COMPOSITION_CASES.find(k => k.id === 'external-app-injection')!
    expect(classifyComposition(fold(paste.steps))).toEqual(classifyComposition(fold(injection.steps)))
  })

  test('a placeholder outranks a key-less long insertion', () => {
    const kase = COMPOSITION_CASES.find(k => k.id === 'placeholder-outranks-insert')!
    const c = fold(kase.steps)
    expect(c.placeholder).toBe(true)
    expect(c.pastedChars).toBeGreaterThan(0)
    expect(classifyComposition(c)).toEqual({ pasted: true, reason: 'paste-placeholder' })
  })

  test('no events at all reads as no-input-events, other observations as observed-other', () => {
    expect(classifyComposition(EMPTY_COMPOSITION)).toEqual({ pasted: true, reason: 'no-input-events' })
    expect(classifyComposition(fold([{ kind: 'autocomplete', text: '/optimize' }]))).toEqual({
      pasted: false,
      reason: 'observed-other',
    })
    expect(classifyComposition(fold([{ kind: 'edit', inputText: '' }]))).toEqual({
      pasted: false,
      reason: 'observed-other',
    })
  })

  test('one typed key anywhere in the draft wins over pastes before and after it', () => {
    const after = COMPOSITION_CASES.find(k => k.id === 'paste-then-one-key')!
    const before = COMPOSITION_CASES.find(k => k.id === 'typing-then-paste')!
    expect(classifyComposition(fold(after.steps)).reason).toBe('typed')
    expect(classifyComposition(fold(before.steps)).reason).toBe('typed')
  })

  test('emptying the box resets the draft and drops the earlier paste evidence', () => {
    const kase = COMPOSITION_CASES.find(k => k.id === 'emptied-box-resets')!
    expect(classifyComposition(fold(kase.steps))).toEqual({ pasted: true, reason: 'no-input-events' })
  })
})

describe('classifyComposition — the boolean verdict is unchanged', () => {
  // The old formula, kept verbatim so the table proves the refactor changed
  // no decision whatever.
  function legacyIsPasteOnly(c: Composition): boolean {
    return !c.typed && (c.pastedChars > 0 || c.placeholder || !c.observed)
  }

  test('the classification agrees with the old formula over the full 2×2×2×2 table', () => {
    for (const typed of [false, true]) {
      for (const hasPastedChars of [false, true]) {
        for (const placeholder of [false, true]) {
          for (const observed of [false, true]) {
            const c: Composition = {
              typed,
              pastedChars: hasPastedChars ? 12 : 0,
              placeholder,
              observed,
            }
            const expected = legacyIsPasteOnly(c)
            expect(isPasteOnly(c)).toBe(expected)
            expect(classifyComposition(c).pasted).toBe(expected)
            expect(classifyComposition(c).reason).toBe(
              expected
                ? placeholder ? 'paste-placeholder' : hasPastedChars ? 'keyless-long-insert' : 'no-input-events'
                : typed ? 'typed' : 'observed-other',
            )
          }
        }
      }
    }
  })
})
