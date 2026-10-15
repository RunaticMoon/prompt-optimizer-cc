import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_TRUNCATION_MARK } from '../hooks/context'
import type { ApiMessage, CapturedMemory } from '../hooks/contracts'
import { extractHookMemory, readHookMemory, renderMemory } from '../hooks/memory'

const SESSION_HEADING = '### Injected at session start'
const PROMPT_HEADING = '### Injected for the previous prompt (not retrieved for this prompt)'

function memory(over: Partial<CapturedMemory> = {}): CapturedMemory {
  return { sessionStart: [], lastPrompt: [], ...over }
}

/** The `<system-reminder>` envelope an injected hook-context block has. */
function injected(kind: 'SessionStart' | 'UserPromptSubmit', body: string): string {
  return `<system-reminder>\n${kind} hook additional context: ${body}\n</system-reminder>`
}

/** An engine reminder block: a `<system-reminder>` with other content. */
function reminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

function textBlock(text: string) {
  return { type: 'text', text }
}

/** One user message holding the given text blocks, in order. */
function userMessage(...blocks: string[]): ApiMessage {
  return { role: 'user', content: blocks.map(textBlock) }
}

/** One assistant message holding the given text. */
function assistantMessage(text: string): ApiMessage {
  return { role: 'assistant', content: [textBlock(text)] }
}

describe('extractHookMemory', () => {
  test('reads the measured block shape: session start plus the previous prompt', () => {
    // The 2.1.300 shape (A-REPORT §2): every injected block is a separate text
    // block of the first user message, the engine's own reminders between them,
    // and the person's own prompt text last, unwrapped.
    const messages: ApiMessage[] = [
      userMessage(
        injected('SessionStart', 'SS1\nSS2\nPLUGIN_SS'),
        reminder('# Environment\ncwd: /repo'),
        injected('UserPromptSubmit', 'UPS1'),
        reminder('other engine reminder'),
        'managed-first',
      ),
    ]

    expect(extractHookMemory(messages)).toEqual({
      sessionStart: ['SS1\nSS2\nPLUGIN_SS'],
      lastPrompt: ['UPS1'],
    })
  })

  test('keeps the previous prompt memory when a slash command sits beside the prompt', () => {
    // verify-E-REPORT.md: with a command run between two prompts, the first
    // user message holds the engine's command transcript
    // (`<local-command-caveat>`, `<command-name>`, `<local-command-stdout>`)
    // beside the injected blocks and the person's own text. Those blocks must
    // not confirm an empty group before the prompt is reached.
    const messages: ApiMessage[] = [
      userMessage(
        injected('SessionStart', 'SS'),
        reminder('# Environment'),
        injected('UserPromptSubmit', 'UPS-FIRST'),
        '<local-command-caveat>The command below was run directly in Claude Code, ...</local-command-caveat>',
        '<command-name>/optimize</command-name>\n<command-message>optimize</command-message>\n<command-args></command-args>',
        '<local-command-stdout>설정에 저장했습니다.</local-command-stdout>',
        'managed-first',
      ),
      assistantMessage('ok'),
      userMessage(
        '<command-name>/optimize</command-name>',
        '<local-command-stdout>설정에 저장했습니다.</local-command-stdout>',
      ),
    ]

    expect(extractHookMemory(messages)).toEqual({
      sessionStart: ['SS'],
      lastPrompt: ['UPS-FIRST'],
    })
  })

  test('gives the same memory whichever order the prompt and its block arrive in', () => {
    const blockBefore = [userMessage(injected('UserPromptSubmit', 'UPS-BEFORE'), 'prompt')]
    const blockAfter = [userMessage('prompt', injected('UserPromptSubmit', 'UPS-AFTER'))]

    expect(extractHookMemory(blockBefore).lastPrompt).toEqual(['UPS-BEFORE'])
    expect(extractHookMemory(blockAfter).lastPrompt).toEqual(['UPS-AFTER'])
  })

  test('keeps the previous prompt memory when the last message is only a command', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('UserPromptSubmit', 'UPS-KEPT'), 'first'),
      assistantMessage('ok'),
      userMessage(
        '<command-name>/optimize</command-name>',
        '<local-command-stdout>done</local-command-stdout>',
      ),
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual(['UPS-KEPT'])
  })

  test('does not treat an interrupt notice as a person prompt', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('UserPromptSubmit', 'UPS-KEPT'), 'first'),
      assistantMessage('partial'),
      userMessage('[Request interrupted by user]'),
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual(['UPS-KEPT'])
  })

  test('clears the session-start memory when the last SessionStart body is empty', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('SessionStart', 'OLD-SS'), 'first'),
      assistantMessage('ok'),
      userMessage(injected('SessionStart', '   '), 'second'),
    ]

    expect(extractHookMemory(messages).sessionStart).toEqual([])
  })

  test('treats every engine wrapper as a block that is not a person prompt', () => {
    const wrappers = [
      '<system-reminder>engine note</system-reminder>',
      '<local-command-caveat>caveat</local-command-caveat>',
      '<local-command-stdout>out</local-command-stdout>',
      '<local-command-stderr>err</local-command-stderr>',
      '<command-name>/optimize</command-name>',
      '<command-message>optimize</command-message>',
      '<command-args>--help</command-args>',
      '<bash-input>ls</bash-input>',
      '<bash-stdout>file.txt</bash-stdout>',
      '<bash-stderr>not found</bash-stderr>',
      '[Request interrupted by user]',
    ]

    for (const wrapper of wrappers) {
      const messages = [userMessage(injected('UserPromptSubmit', 'UPS'), wrapper, 'real prompt')]
      expect(extractHookMemory(messages).lastPrompt).toEqual(['UPS'])
    }
  })

  test('keeps only the last SessionStart block (a resume may leave older ones)', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('SessionStart', 'OLD-SS'), 'first'),
      assistantMessage('ok'),
      userMessage(injected('SessionStart', 'NEW-SS'), 'second'),
    ]

    expect(extractHookMemory(messages)).toEqual({ sessionStart: ['NEW-SS'], lastPrompt: [] })
  })

  test('keeps the UserPromptSubmit blocks of the last person prompt only', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('UserPromptSubmit', 'UPS-1'), 'first'),
      assistantMessage('ok'),
      userMessage(injected('UserPromptSubmit', 'UPS-2'), 'second'),
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual(['UPS-2'])
  })

  test('yields no previous-prompt memory when the last prompt had none', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('UserPromptSubmit', 'UPS-1'), 'first'),
      assistantMessage('ok'),
      userMessage('second'),
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual([])
  })

  test('ignores UserPromptSubmit blocks left after the last person prompt', () => {
    // The block is not confirmed by a following prompt: it is a retrieval for
    // the prompt being optimized now, not for the previous one.
    const messages: ApiMessage[] = [
      userMessage('first'),
      userMessage(injected('UserPromptSubmit', 'LATE-UPS')),
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual([])
  })

  test('carries a UserPromptSubmit across tool_result blocks up to the prompt', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('UserPromptSubmit', 'UPS-TOOL')),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', text: 'file contents' }],
      },
      userMessage('do it'),
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual(['UPS-TOOL'])
  })

  test('treats a string content as a single text block', () => {
    const messages: ApiMessage[] = [
      { role: 'user', content: injected('SessionStart', 'STR-SS') },
      { role: 'user', content: 'string prompt' },
    ]

    expect(extractHookMemory(messages)).toEqual({ sessionStart: ['STR-SS'], lastPrompt: [] })
  })

  test('treats a string content as a person prompt that confirms a UserPromptSubmit', () => {
    const messages: ApiMessage[] = [
      userMessage(injected('UserPromptSubmit', 'UPS-STR')),
      { role: 'user', content: 'string prompt' },
    ]

    expect(extractHookMemory(messages).lastPrompt).toEqual(['UPS-STR'])
  })

  test('ignores a block that only quotes the marker inside other text', () => {
    const messages: ApiMessage[] = [
      userMessage(reminder('Example: SessionStart hook additional context: NOT-MEMORY'), 'hi'),
    ]

    expect(extractHookMemory(messages)).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('drops an injected block whose body is empty or whitespace only', () => {
    const messages: ApiMessage[] = [
      userMessage(
        injected('SessionStart', '   '),
        injected('UserPromptSubmit', ''),
        'hello',
      ),
    ]

    expect(extractHookMemory(messages)).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('ignores injected blocks carried on non-user messages', () => {
    const messages: ApiMessage[] = [assistantMessage(injected('SessionStart', 'FROM-ASSISTANT'))]

    expect(extractHookMemory(messages)).toEqual({ sessionStart: [], lastPrompt: [] })
  })

  test('reads nothing from an empty conversation', () => {
    expect(extractHookMemory([])).toEqual({ sessionStart: [], lastPrompt: [] })
  })
})

describe('readHookMemory', () => {
  test('renders the memory found in the conversation', async () => {
    const text = await readHookMemory(
      async () => [userMessage(injected('SessionStart', '세션 기억'), '원문')],
      400,
    )

    expect(text).toContain(SESSION_HEADING)
    expect(text).toContain('세션 기억')
  })

  test('treats a refusing read as no memory', async () => {
    const text = await readHookMemory(async () => {
      throw new Error('unavailable')
    }, 400)

    expect(text).toBe('')
  })

  test('treats a non-array value as no memory', async () => {
    const text = await readHookMemory(async () => ({ deny: 'nope' }), 400)

    expect(text).toBe('')
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

/** The body under `heading`, up to the next blank-line separator. */
function sectionBody(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const bodyStart = start + heading.length + 1
  const next = text.indexOf('\n\n', bodyStart)
  return next < 0 ? text.slice(bodyStart) : text.slice(bodyStart, next)
}

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
