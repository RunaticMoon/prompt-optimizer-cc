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
  test('starts empty for any id, including the empty one', () => {
    const store = createMemoryStore()

    expect(store.current('sess-a')).toEqual({ sessionStart: [], lastPrompt: [] })
    expect(store.current('')).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('records each field independently and replaces on every call, within one session', () => {
    const store = createMemoryStore()

    store.recordSessionStart('sess-a', ['s1', 's2'])
    store.recordPromptSubmit('sess-a', ['p1'])
    expect(store.current('sess-a')).toEqual({ sessionStart: ['s1', 's2'], lastPrompt: ['p1'] })

    store.recordSessionStart('sess-a', ['s3'])
    expect(store.current('sess-a')).toEqual({ sessionStart: ['s3'], lastPrompt: ['p1'] })

    store.recordPromptSubmit('sess-a', ['p2', 'p3'])
    expect(store.current('sess-a')).toEqual({ sessionStart: ['s3'], lastPrompt: ['p2', 'p3'] })
  })

  test('clears a field when recorded undefined', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    store.recordSessionStart('sess-a', undefined)
    store.recordPromptSubmit('sess-a', undefined)

    expect(store.current('sess-a')).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('trims entries and drops empty or whitespace-only ones', () => {
    const store = createMemoryStore()

    store.recordSessionStart('sess-a', ['  keep  ', '', '   ', '\n', 'also'])
    store.recordPromptSubmit('sess-a', ['\t\n  '])

    expect(store.current('sess-a')).toEqual({ sessionStart: ['keep', 'also'], lastPrompt: [] })
  })

  test('resetSession clears both fields only for the stored session', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    store.resetSession('sess-a')

    expect(store.current('sess-a')).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('resetSession leaves a different or empty id\'s memory untouched', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-b', ['s2'])
    store.recordPromptSubmit('sess-b', ['p2'])

    store.resetSession('sess-a')
    store.resetSession('')

    expect(store.current('sess-b')).toEqual({ sessionStart: ['s2'], lastPrompt: ['p2'] })
  })

  test('hands out a copy, so later records do not mutate an earlier read', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])

    const read = store.current('sess-a')
    store.recordSessionStart('sess-a', ['s2'])

    expect(read.sessionStart).toEqual(['s1'])
    expect(store.current('sess-a').sessionStart).toEqual(['s2'])
  })

  test('reads nothing for a different or empty id', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    expect(store.current('sess-b')).toEqual({ sessionStart: [], lastPrompt: [] })
    expect(store.current('')).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('a new session id drops the previous session\'s memory on the next record', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    // The new session records only a SessionStart: the previous session's
    // previous-prompt entries are gone, not carried over.
    store.recordSessionStart('sess-b', ['s2'])

    expect(store.current('sess-b')).toEqual({ sessionStart: ['s2'], lastPrompt: [] })
    expect(store.current('sess-a')).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('a prompt record for a different session does not steal the stored slot', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])

    // A UserPromptSubmit from another session must not adopt: only
    // `SessionStart` changes the stored session.
    store.recordPromptSubmit('sess-b', ['p1'])

    expect(store.storedSessionId()).toBe('sess-a')
    expect(store.current('sess-b')).toEqual({ sessionStart: [], lastPrompt: [] })
    expect(store.latest()).toEqual({ sessionStart: ['s1'], lastPrompt: [] })
  })

  test('a prompt record adopts when the store is still empty', () => {
    const store = createMemoryStore()

    store.recordPromptSubmit('sess-b', ['p1'])

    expect(store.storedSessionId()).toBe('sess-b')
    expect(store.current('sess-b')).toEqual({ sessionStart: [], lastPrompt: ['p1'] })
    expect(store.latest()).toEqual({ sessionStart: [], lastPrompt: ['p1'] })
  })

  test('latest() and storedSessionId() start empty', () => {
    const store = createMemoryStore()

    expect(store.latest()).toEqual({ sessionStart: [], lastPrompt: [] })
    expect(store.storedSessionId()).toBe('')
  })

  test('latest() returns the adopted session\'s memory and storedSessionId() names it', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    expect(store.latest()).toEqual({ sessionStart: ['s1'], lastPrompt: ['p1'] })
    expect(store.storedSessionId()).toBe('sess-a')
  })

  test('latest() follows a newly adopted id and drops the previous session', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    // No `session.start` for `sess-b` (the `/clear` case): the classic hook
    // alone adopts it, and the previous session's memory does not survive.
    store.recordSessionStart('sess-b', ['s2'])

    expect(store.storedSessionId()).toBe('sess-b')
    expect(store.latest()).toEqual({ sessionStart: ['s2'], lastPrompt: [] })
  })

  test('latest() is empty again after resetSession clears the stored session', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])
    store.recordPromptSubmit('sess-a', ['p1'])

    store.resetSession('sess-a')

    expect(store.storedSessionId()).toBe('')
    expect(store.latest()).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('latest() hands out a copy, so later records do not mutate an earlier read', () => {
    const store = createMemoryStore()
    store.recordSessionStart('sess-a', ['s1'])

    const read = store.latest()
    store.recordSessionStart('sess-a', ['s2'])

    expect(read.sessionStart).toEqual(['s1'])
    expect(store.latest().sessionStart).toEqual(['s2'])
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
