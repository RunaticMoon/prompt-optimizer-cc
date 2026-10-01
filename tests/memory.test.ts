import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_TRUNCATION_MARK } from '../hooks/context'
import type { CapturedMemory } from '../hooks/contracts'
import { createMemoryStore, renderMemory } from '../hooks/memory'

const SESSION_HEADING = '### Injected at session start'
const PROMPT_HEADING = '### Injected for the previous prompt (not retrieved for this prompt)'

function memory(over: Partial<CapturedMemory> = {}): CapturedMemory {
  return { sessionStart: [], lastPrompt: [], ...over }
}

/** The body under `heading`, up to the next blank-line separator. */
function sectionBody(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const bodyStart = start + heading.length + 1
  const next = text.indexOf('\n\n', bodyStart)
  return next < 0 ? text.slice(bodyStart) : text.slice(bodyStart, next)
}

describe('createMemoryStore', () => {
  test('starts empty', () => {
    const store = createMemoryStore()

    expect(store.current()).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('records each field independently and replaces on every call', () => {
    const store = createMemoryStore()

    store.recordSessionStart(['s1', 's2'])
    store.recordPromptSubmit(['p1'])
    expect(store.current()).toEqual({ sessionStart: ['s1', 's2'], lastPrompt: ['p1'] })

    store.recordSessionStart(['s3'])
    expect(store.current()).toEqual({ sessionStart: ['s3'], lastPrompt: ['p1'] })

    store.recordPromptSubmit(['p2', 'p3'])
    expect(store.current()).toEqual({ sessionStart: ['s3'], lastPrompt: ['p2', 'p3'] })
  })

  test('clears a field when recorded undefined', () => {
    const store = createMemoryStore()
    store.recordSessionStart(['s1'])
    store.recordPromptSubmit(['p1'])

    store.recordSessionStart(undefined)
    store.recordPromptSubmit(undefined)

    expect(store.current()).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('trims entries and drops empty or whitespace-only ones', () => {
    const store = createMemoryStore()

    store.recordSessionStart(['  keep  ', '', '   ', '\n', 'also'])
    store.recordPromptSubmit(['\t\n  '])

    expect(store.current()).toEqual({ sessionStart: ['keep', 'also'], lastPrompt: [] })
  })

  test('reset clears both fields', () => {
    const store = createMemoryStore()
    store.recordSessionStart(['s1'])
    store.recordPromptSubmit(['p1'])

    store.reset()

    expect(store.current()).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('hands out a copy, so later records do not mutate an earlier read', () => {
    const store = createMemoryStore()
    store.recordSessionStart(['s1'])

    const read = store.current()
    store.recordSessionStart(['s2'])

    expect(read.sessionStart).toEqual(['s1'])
    expect(store.current().sessionStart).toEqual(['s2'])
  })
})

describe('renderMemory', () => {
  test('returns nothing when both fields are empty', () => {
    expect(renderMemory(memory(), 100)).toBe('')
    expect(renderMemory(memory({ sessionStart: [], lastPrompt: [] }), 100)).toBe('')
  })

  test('omits the session-start heading when that side is empty', () => {
    const text = renderMemory(memory({ lastPrompt: ['only prompt'] }), 400)

    expect(text).not.toContain(SESSION_HEADING)
    expect(text).toContain(PROMPT_HEADING)
    expect(text).toContain('only prompt')
  })

  test('omits the previous-prompt heading when that side is empty', () => {
    const text = renderMemory(memory({ sessionStart: ['only start'] }), 400)

    expect(text).toContain(SESSION_HEADING)
    expect(text).not.toContain(PROMPT_HEADING)
    expect(text).toContain('only start')
  })

  test('joins entries with a blank line under each heading', () => {
    const text = renderMemory(
      memory({ sessionStart: ['first', 'second'], lastPrompt: ['third'] }),
      400,
    )

    expect(text).toContain(`${SESSION_HEADING}\nfirst\n\nsecond`)
    expect(text).toContain(`${PROMPT_HEADING}\nthird`)
  })

  test('caps the previous-prompt body at 40% of the budget and marks the cut', () => {
    const maxChars = 400
    const text = renderMemory(
      memory({ sessionStart: ['S'.repeat(2000)], lastPrompt: ['P'.repeat(2000)] }),
      maxChars,
    )
    const body = sectionBody(text, PROMPT_HEADING)

    expect(body.length).toBe(Math.floor(maxChars * 0.4))
    expect(body.endsWith(CONTEXT_TRUNCATION_MARK)).toBe(true)
    expect(text.length).toBeLessThanOrEqual(maxChars)
  })

  test('leaves budget the previous-prompt body did not spend to session start', () => {
    const maxChars = 400
    const sessionStart = 'S'.repeat(2000)
    const withShortPrompt = renderMemory(
      memory({ sessionStart: [sessionStart], lastPrompt: ['short'] }),
      maxChars,
    )
    const withLongPrompt = renderMemory(
      memory({ sessionStart: [sessionStart], lastPrompt: ['P'.repeat(2000)] }),
      maxChars,
    )

    const shortPromptSession = sectionBody(withShortPrompt, SESSION_HEADING)
    const longPromptSession = sectionBody(withLongPrompt, SESSION_HEADING)

    expect(shortPromptSession.length).toBeGreaterThan(longPromptSession.length)
    expect(shortPromptSession.startsWith('SSS')).toBe(true)
    expect(longPromptSession.startsWith('SSS')).toBe(true)
    expect(withShortPrompt.length).toBeLessThanOrEqual(maxChars)
    expect(withLongPrompt.length).toBeLessThanOrEqual(maxChars)
  })

  test('never exceeds the budget across a range of sizes', () => {
    for (const maxChars of [0, 10, 40, 100, 250, 1000]) {
      const text = renderMemory(
        memory({ sessionStart: ['a'.repeat(900)], lastPrompt: ['b'.repeat(900)] }),
        maxChars,
      )
      expect(text.length).toBeLessThanOrEqual(maxChars)
    }
  })

  test('never splits a surrogate pair when cutting', () => {
    const text = renderMemory(
      memory({ sessionStart: ['😀'.repeat(500)], lastPrompt: ['😀'.repeat(500)] }),
      200,
    )

    expect(hasLoneSurrogate(text)).toBe(false)
  })
})

/** True when the text holds a half of a surrogate pair with no partner. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
