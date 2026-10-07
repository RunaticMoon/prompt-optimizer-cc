import { describe, expect, test } from 'claude-code/testing'

import type { ClientKeyEvent } from 'claude-code'

import { decideRawEdit, RAW_MODE_HINT } from '../hooks/raw-mode'
import type { RawEditFacts } from '../hooks/raw-mode'

const PREFIX = '>> '

function facts(over: Partial<RawEditFacts> = {}): RawEditFacts {
  const start = over.start ?? 0
  return { text: '', cursor: 0, start, end: over.end ?? start, inputText: '', ...over }
}

/** One key stroke, in the engine's `ClientKeyEvent` shape. */
function key(name: string): ClientKeyEvent {
  return { key: name }
}

const CTRL_U: ClientKeyEvent = { key: 'u', ctrl: true }

describe('RAW_MODE_HINT', () => {
  test('is the exact hint line the UI shows while armed', () => {
    expect(RAW_MODE_HINT).toBe('최적화 끔 ctrl+u 켜기')
  })
})

describe('decideRawEdit — arming', () => {
  test('typing the marker key by key arms only on the final space', () => {
    expect(
      decideRawEdit(facts({ inputText: '>', key: key('>') }), false, PREFIX, false),
    ).toEqual({ kind: 'pass' })
    expect(
      decideRawEdit(
        facts({ text: '>', cursor: 1, start: 1, inputText: '>', key: key('>') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })

    const e = facts({ text: '>>', cursor: 2, start: 2, inputText: ' ', key: key(' ') })
    expect(decideRawEdit(e, false, PREFIX, false)).toEqual({ kind: 'arm', box: { text: '', cursor: 0 } })
  })

  test('typing the marker before existing text keeps the text and puts the caret at 0', () => {
    expect(
      decideRawEdit(
        facts({ text: 'abc', cursor: 0, start: 0, inputText: '>', key: key('>') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
    expect(
      decideRawEdit(
        facts({ text: '>abc', cursor: 1, start: 1, inputText: '>', key: key('>') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
    expect(
      decideRawEdit(
        facts({ text: '>>abc', cursor: 2, start: 2, inputText: ' ', key: key(' ') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'arm', box: { text: 'abc', cursor: 0 } })
  })

  test('a fast burst without a key arms when it is no longer than the marker', () => {
    expect(decideRawEdit(facts({ inputText: PREFIX }), false, PREFIX, false)).toEqual({
      kind: 'arm',
      box: { text: '', cursor: 0 },
    })
  })

  test('the marker landing after the start does not arm', () => {
    expect(
      decideRawEdit(
        facts({ text: 'ab', cursor: 2, start: 2, inputText: PREFIX, key: key('>') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
  })

  test('a paste of quoted text does not arm', () => {
    const quoted = PREFIX + '인용문 내용입니다'
    expect(quoted.length).toBeGreaterThan(PREFIX.length)
    expect(decideRawEdit(facts({ inputText: quoted }), false, PREFIX, false)).toEqual({ kind: 'pass' })
    // A short paste that is still longer than the marker does not arm either.
    expect(decideRawEdit(facts({ inputText: PREFIX + ' ' }), false, PREFIX, false)).toEqual({
      kind: 'pass',
    })
  })

  test('an edit on text that already starts with the marker passes', () => {
    expect(
      decideRawEdit(
        facts({ text: PREFIX + 'abc', cursor: PREFIX.length, start: 0, end: 0, inputText: PREFIX, key: key('>') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
  })

  test('a bare deletion passes even though no text is inserted', () => {
    expect(
      decideRawEdit(
        facts({ text: 'x', cursor: 0, start: 0, end: 1, inputText: '', key: key('backspace') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
  })

  test('a workflow holding the composer blocks arming', () => {
    expect(decideRawEdit(facts({ inputText: PREFIX }), false, PREFIX, true)).toEqual({ kind: 'pass' })
  })

  test('an empty raw prefix disables the mode', () => {
    expect(decideRawEdit(facts({ inputText: PREFIX }), false, '', false)).toEqual({ kind: 'pass' })
  })
})

describe('decideRawEdit — armed', () => {
  test('ctrl+u releases at any caret position, keeping the box as it was', () => {
    const text = 'ab'
    for (const cursor of [0, 1, 2]) {
      expect(
        decideRawEdit(
          facts({ text, cursor, start: cursor, end: cursor, key: CTRL_U }),
          true,
          PREFIX,
          false,
        ),
      ).toEqual({ kind: 'release', box: { text, cursor } })
    }
  })

  test('a plain u without ctrl does not release while armed', () => {
    expect(
      decideRawEdit(facts({ text: 'ab', cursor: 2, start: 2, inputText: 'u', key: key('u') }), true, PREFIX, false),
    ).toEqual({ kind: 'pass' })
  })

  test('any other edit passes while armed, even one that would arm', () => {
    expect(
      decideRawEdit(
        facts({ text: 'ab', cursor: 2, start: 2, inputText: 'c', key: key('c') }),
        true,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
    expect(
      decideRawEdit(
        facts({ text: '>>', cursor: 2, start: 2, inputText: ' ', key: key(' ') }),
        true,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
  })
})

describe('decideRawEdit — custom raw prefix', () => {
  test('arms on the configured marker and strips exactly its length', () => {
    expect(
      decideRawEdit(
        facts({ text: '!', cursor: 1, start: 1, inputText: '!', key: key('!') }),
        false,
        '!!',
        false,
      ),
    ).toEqual({ kind: 'arm', box: { text: '', cursor: 0 } })

    expect(
      decideRawEdit(
        facts({ text: '>hello', cursor: 1, start: 1, inputText: '!', key: key('!') }),
        false,
        '!!',
        false,
      ),
    ).toEqual({ kind: 'pass' })
  })

  test('does not arm on the default marker', () => {
    expect(
      decideRawEdit(
        facts({ text: '!', cursor: 1, start: 1, inputText: '!', key: key('!') }),
        false,
        PREFIX,
        false,
      ),
    ).toEqual({ kind: 'pass' })
  })
})
