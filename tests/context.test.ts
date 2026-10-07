import type { EngineInterface, SessionMessage, SessionRepo, ToolUseSummary } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_MEMORY_CHARS, CONTEXT_RULES_CHARS, DEFAULT_CONFIG } from '../hooks/contracts'
import {
  CONTEXT_MAX_RULE_BYTES,
  CONTEXT_MESSAGE_CHARS,
  CONTEXT_MIDDLE_MARK,
  CONTEXT_TRUNCATION_MARK,
  buildSnapshot,
  collectContext,
  type SnapshotInput,
} from '../hooks/context'

function message(
  role: 'user' | 'assistant',
  text: string,
  toolUses: ToolUseSummary[] = [],
): SessionMessage {
  return { role, text, toolUses }
}

function toolUse(tool: string, id: string = tool): ToolUseSummary {
  return { tool_use_id: id, tool, input: {} }
}

function baseInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    messages: [],
    rules: [],
    cwd: '/repo',
    root: '/repo',
    repoName: null,
    contextTurns: 4,
    contextMaxChars: 6000,
    memory: '',
    ...overrides,
  }
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

interface Calls {
  messages: number
  cwd: number
  root: number
  repo: number
  stat: number
  read: number
  forbidden: string[]
}

interface FakeOptions {
  messages?: readonly SessionMessage[]
  cwd?: string
  root?: string
  repo?: SessionRepo | null
  files?: Readonly<Record<string, string>>
  sizes?: Readonly<Record<string, number>>
  failMessages?: boolean
  failRead?: (path: string) => boolean
}

/**
 * A stand-in engine exposing only the read-only surface `collectContext`
 * may use. `model` and `prompt` methods exist solely to be counted if ever
 * called; a call from production code would throw and fail the test.
 */
function fakeEngine(options: FakeOptions = {}): {
  engine: EngineInterface
  calls: Calls
  reads: string[]
} {
  const calls: Calls = {
    messages: 0,
    cwd: 0,
    root: 0,
    repo: 0,
    stat: 0,
    read: 0,
    forbidden: [],
  }
  const reads: string[] = []
  const files = options.files ?? {}
  const sizes = options.sizes ?? {}
  const forbid =
    (noun: string, method: string): (() => never) =>
    () => {
      calls.forbidden.push(`${noun}.${method}`)
      throw new Error(`forbidden ${noun}.${method}`)
    }

  const engine = {
    session: {
      messages: async () => {
        calls.messages += 1
        if (options.failMessages === true) throw new Error('transcript unavailable')
        return [...(options.messages ?? [])]
      },
      cwd: async () => {
        calls.cwd += 1
        return options.cwd ?? '/repo'
      },
      root: async () => {
        calls.root += 1
        return options.root ?? '/repo'
      },
      repo: async () => {
        calls.repo += 1
        return options.repo ?? null
      },
    },
    fs: {
      stat: async (path: string) => {
        calls.stat += 1
        const text = files[path]
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return { kind: 'file' as const, size: sizes[path] ?? text.length, mtimeMs: 0, isLink: false }
      },
      read: async (path: string) => {
        calls.read += 1
        reads.push(path)
        if (options.failRead?.(path) === true) throw new Error(`EACCES: ${path}`)
        const text = files[path]
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
    },
    model: {
      complete: forbid('model', 'complete'),
      fork: forbid('model', 'fork'),
      classify: forbid('model', 'classify'),
    },
    prompt: {
      context: forbid('prompt', 'context'),
      section: forbid('prompt', 'section'),
      read: forbid('prompt', 'read'),
      fill: forbid('prompt', 'fill'),
      submit: forbid('prompt', 'submit'),
    },
  }

  return { engine: engine as unknown as EngineInterface, calls, reads }
}

describe('buildSnapshot', () => {
  test('drops the oldest messages once past the message cap', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      message(i % 2 === 0 ? 'user' : 'assistant', `[[${i}]]`),
    )

    const snapshot = buildSnapshot(baseInput({ messages, contextTurns: 50 }))

    expect(snapshot.conversation.split('\n')).toHaveLength(8)
    expect(snapshot.conversation).toContain('[[11]]')
    expect(snapshot.conversation).toContain('[[4]]')
    expect(snapshot.conversation).not.toContain('[[3]]')
    expect(snapshot.conversation).not.toContain('[[0]]')
  })

  test('keeps the newest conversation when the conversation cap is exceeded', () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      message('user', `[[${i}]]${'x'.repeat(1000)}`),
    )

    const snapshot = buildSnapshot(baseInput({ messages, contextTurns: 50 }))

    expect(snapshot.conversation.length).toBeLessThanOrEqual(4000)
    expect(snapshot.conversation).toContain('[[7]]')
    expect(snapshot.conversation).not.toContain('[[4]]')
  })

  test('truncates a long message with head, middle marker and tail', () => {
    const snapshot = buildSnapshot(baseInput({ messages: [message('user', 'a'.repeat(5000))] }))

    expect(snapshot.conversation).toContain(CONTEXT_MIDDLE_MARK)
    expect(snapshot.conversation.startsWith('[user] a')).toBe(true)
    expect(snapshot.conversation.endsWith('a')).toBe(true)
    expect(snapshot.conversation.length).toBeLessThanOrEqual('[user] '.length + CONTEXT_MESSAGE_CHARS)
  })

  test('never splits a surrogate pair when cutting', () => {
    const snapshot = buildSnapshot(
      baseInput({ messages: [message('assistant', '😀가'.repeat(1500))] }),
    )

    expect(hasLoneSurrogate(snapshot.conversation)).toBe(false)
    expect(snapshot.conversation).toContain(CONTEXT_MIDDLE_MARK)
  })

  test('reports an empty conversation for no messages', () => {
    const snapshot = buildSnapshot(baseInput())

    expect(snapshot.conversation).toBe('')
    expect(snapshot.text).not.toContain('## Recent conversation')
    expect(snapshot.text).not.toContain('## Recent tools')
  })

  test('reads no conversation or tools when contextTurns is 0', () => {
    const messages = [message('user', 'hi'), message('assistant', 'there', [toolUse('Read')])]

    const snapshot = buildSnapshot(baseInput({ messages, contextTurns: 0 }))

    expect(snapshot.conversation).toBe('')
    expect(snapshot.tools).toBe('')
    expect(snapshot.text).not.toContain('## Recent conversation')
  })

  test('omits tool result bodies and empty-text messages', () => {
    const messages: SessionMessage[] = [
      message('user', 'question'),
      message('assistant', '', [toolUse('Read')]),
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'SECRET_RESULT', isError: false }] },
      message('assistant', 'the answer'),
    ]

    const snapshot = buildSnapshot(baseInput({ messages, contextTurns: 50 }))

    expect(snapshot.conversation).toContain('[user] question')
    expect(snapshot.conversation).toContain('[assistant] the answer')
    expect(snapshot.conversation).not.toContain('SECRET_RESULT')
    expect(snapshot.tools).toBe('Read')
  })

  test('lists distinct recent tool names, newest first', () => {
    const messages = [
      message('assistant', 'a', [toolUse('Read', 'r1')]),
      message('assistant', 'b', [toolUse('Bash', 'b1'), toolUse('Read', 'r2')]),
      message('assistant', 'c', [toolUse('Edit', 'e1')]),
    ]

    const snapshot = buildSnapshot(baseInput({ messages, contextTurns: 50 }))

    expect(snapshot.tools).toBe('Edit, Bash, Read')
  })

  test('caps project rules and appends the truncation marker', () => {
    const rules = [{ path: '/repo/CLAUDE.md', text: 'R'.repeat(3000) }]

    const snapshot = buildSnapshot(baseInput({ rules }))

    expect(snapshot.rules.length).toBeLessThanOrEqual(CONTEXT_RULES_CHARS)
    expect(snapshot.rules.endsWith(CONTEXT_TRUNCATION_MARK)).toBe(true)
    expect(snapshot.text).toContain('## Project rules')
    expect(snapshot.chars).toBe(snapshot.text.length)
  })

  test('never splits a surrogate pair in truncated rules', () => {
    const rules = [{ path: '/repo/CLAUDE.md', text: '😀'.repeat(2000) }]

    const snapshot = buildSnapshot(baseInput({ rules }))

    expect(hasLoneSurrogate(snapshot.rules)).toBe(false)
    expect(snapshot.rules.length).toBeLessThanOrEqual(CONTEXT_RULES_CHARS)
  })

  test('describes cwd and repo, using a dot for the root itself', () => {
    const relative = buildSnapshot(
      baseInput({ cwd: '/repo/a/b', root: '/repo', repoName: 'owner/name' }),
    )
    const atRoot = buildSnapshot(baseInput({ cwd: '/repo', root: '/repo' }))

    expect(relative.location).toBe('cwd: a/b\nrepo: owner/name')
    expect(atRoot.location).toBe('cwd: .')
  })

  test('drops the oldest conversation first when the overall budget is exceeded', () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      message('user', `[[${i}]]${'x'.repeat(295)}`),
    )
    const rules = [{ path: '/repo/CLAUDE.md', text: 'R'.repeat(100) }]

    const snapshot = buildSnapshot(
      baseInput({ messages, rules, contextTurns: 50, contextMaxChars: 1000 }),
    )

    expect(snapshot.text.length).toBeLessThanOrEqual(1000)
    expect(snapshot.text).toContain('## Project rules')
    expect(snapshot.conversation).toContain('[[7]]')
    expect(snapshot.conversation).not.toContain('[[0]]')
  })

  test('empties the text when the budget is zero', () => {
    const snapshot = buildSnapshot(
      baseInput({ rules: [{ path: '/repo/CLAUDE.md', text: 'rules' }], contextMaxChars: 0 }),
    )

    expect(snapshot.text).toBe('')
    expect(snapshot.chars).toBe(0)
  })

  test('places the memory section between location and recent conversation', () => {
    const messages = [message('user', 'hello')]
    const snapshot = buildSnapshot(baseInput({ messages, memory: 'injected fact' }))

    const memoryAt = snapshot.text.indexOf('## Long-term memory (injected by other plugins)')
    const locationAt = snapshot.text.indexOf('## Location')
    const conversationAt = snapshot.text.indexOf('## Recent conversation')

    expect(snapshot.memory).toBe('injected fact')
    expect(memoryAt).toBeGreaterThan(locationAt)
    expect(memoryAt).toBeLessThan(conversationAt)
    expect(snapshot.text).toContain('## Long-term memory (injected by other plugins)\ninjected fact')
  })

  test('omits the memory section when there is no memory', () => {
    const snapshot = buildSnapshot(baseInput({ memory: '' }))

    expect(snapshot.memory).toBe('')
    expect(snapshot.text).not.toContain('## Long-term memory')
  })

  test('caps memory and appends the truncation marker', () => {
    const snapshot = buildSnapshot(baseInput({ memory: 'M'.repeat(CONTEXT_MEMORY_CHARS + 500) }))

    expect(snapshot.memory.length).toBeLessThanOrEqual(CONTEXT_MEMORY_CHARS)
    expect(snapshot.memory.endsWith(CONTEXT_TRUNCATION_MARK)).toBe(true)
  })

  test('never splits a surrogate pair in truncated memory', () => {
    const snapshot = buildSnapshot(baseInput({ memory: '😀'.repeat(CONTEXT_MEMORY_CHARS) }))

    expect(hasLoneSurrogate(snapshot.memory)).toBe(false)
    expect(snapshot.memory.length).toBeLessThanOrEqual(CONTEXT_MEMORY_CHARS)
  })

  test('keeps memory while dropping conversation when the budget is exceeded', () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      message('user', `[[${i}]]${'x'.repeat(295)}`),
    )
    const snapshot = buildSnapshot(
      baseInput({
        messages,
        memory: 'M'.repeat(500),
        contextTurns: 50,
        contextMaxChars: 700,
      }),
    )

    expect(snapshot.text.length).toBeLessThanOrEqual(700)
    expect(snapshot.text).toContain('## Long-term memory')
    expect(snapshot.text).toContain('M'.repeat(100))
    expect(snapshot.text).not.toContain('[[0]]')
  })

  test('preserves repository evidence before memory and conversation within the total budget', () => {
    const snapshot = buildSnapshot(baseInput({
      project: 'src/images.ts:12 baseline = previousImage',
      memory: 'M'.repeat(2000),
      messages: [message('user', 'old conversation')],
      contextMaxChars: 500,
    }))
    expect(snapshot.project).toBe('src/images.ts:12 baseline = previousImage')
    expect(snapshot.text).toContain('## Repository evidence (partial, read-only)')
    expect(snapshot.text).toContain('baseline = previousImage')
    expect(snapshot.text.length).toBeLessThanOrEqual(500)
    expect(snapshot.text).toContain('old conversation')
  })
})

describe('collectContext', () => {
  test('reads only session and fs, never model or prompt', async () => {
    const { engine, calls, reads } = fakeEngine({
      messages: [message('user', 'hello')],
      cwd: '/repo',
      root: '/repo',
      repo: { root: '/repo', remote: null, internal: false, name: 'owner/name' },
      files: { '/repo/CLAUDE.md': 'project rules' },
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(calls.forbidden).toEqual([])
    expect(calls.messages).toBe(1)
    expect(calls.cwd).toBe(1)
    expect(calls.root).toBe(1)
    expect(calls.repo).toBe(1)
    expect(reads).toEqual(['/repo/CLAUDE.md'])
    expect(snapshot.text).toContain('## Project rules')
    expect(snapshot.text).toContain('project rules')
    expect(snapshot.location).toBe('cwd: .\nrepo: owner/name')
  })

  test('reads the three CLAUDE.md candidates in order', async () => {
    const { engine, reads } = fakeEngine({
      cwd: '/repo/sub',
      root: '/repo',
      files: {
        '/repo/CLAUDE.md': 'root',
        '/repo/.claude/CLAUDE.md': 'nested',
        '/repo/sub/CLAUDE.md': 'sub',
      },
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(reads).toEqual([
      '/repo/CLAUDE.md',
      '/repo/.claude/CLAUDE.md',
      '/repo/sub/CLAUDE.md',
    ])
    expect(snapshot.rules).toContain('root')
    expect(snapshot.rules).toContain('nested')
    expect(snapshot.rules).toContain('sub')
  })

  test('includes root and current-directory AGENTS.md project instructions', async () => {
    const { engine } = fakeEngine({
      cwd: '/repo/sub',
      files: { '/repo/AGENTS.md': 'root instructions', '/repo/sub/AGENTS.md': 'nested instructions' },
    })
    const snapshot = await collectContext(engine, DEFAULT_CONFIG)
    expect(snapshot.rules).toContain('root instructions')
    expect(snapshot.rules).toContain('nested instructions')
  })

  test('surfaces unavailable repository evidence for the original request', async () => {
    const { engine } = fakeEngine()
    const snapshot = await collectContext(engine, DEFAULT_CONFIG, '', 'node image API')
    expect(snapshot.project).toContain('repository inspection unavailable')
    expect(snapshot.text).toContain('Repository evidence (partial, read-only)')
  })

  test('does not collect repository evidence with a zero context budget', async () => {
    const { engine, calls } = fakeEngine()
    const snapshot = await collectContext(engine, { ...DEFAULT_CONFIG, contextMaxChars: 0 }, '', 'node image API')
    expect(snapshot.project).toBe('')
    expect(snapshot.text).toBe('')
    expect(calls.stat).toBe(3)
  })

  test('skips an oversized rule file without reading it', async () => {
    const path = '/repo/CLAUDE.md'
    const { engine, reads } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { [path]: 'x'.repeat(10) },
      sizes: { [path]: CONTEXT_MAX_RULE_BYTES + 1 },
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(reads).toEqual([])
    expect(snapshot.rules).toBe('')
  })

  test('caps a moderately large rule file', async () => {
    const { engine } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { '/repo/CLAUDE.md': '가'.repeat(3000) },
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(snapshot.rules.length).toBeLessThanOrEqual(CONTEXT_RULES_CHARS)
    expect(snapshot.rules.endsWith(CONTEXT_TRUNCATION_MARK)).toBe(true)
  })

  test('omits a rule file that cannot be read', async () => {
    const path = '/repo/CLAUDE.md'
    const { engine, reads } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { [path]: 'secret' },
      failRead: candidate => candidate === path,
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(reads).toEqual([path])
    expect(snapshot.rules).toBe('')
  })

  test('omits a missing rule file', async () => {
    const { engine } = fakeEngine({ cwd: '/repo', root: '/repo' })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(snapshot.rules).toBe('')
    expect(snapshot.text).not.toContain('## Project rules')
  })

  test('keeps collecting when the transcript read fails', async () => {
    const { engine } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      failMessages: true,
      files: { '/repo/CLAUDE.md': 'rules' },
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(snapshot.conversation).toBe('')
    expect(snapshot.rules).toContain('rules')
  })

  test('folds the given memory into the snapshot by default', async () => {
    const { engine } = fakeEngine({ cwd: '/repo', root: '/repo' })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG, '## Injected\nremembered fact')

    expect(snapshot.memory).toBe('## Injected\nremembered fact')
    expect(snapshot.text).toContain('## Long-term memory (injected by other plugins)')
    expect(snapshot.text).toContain('remembered fact')
  })

  test('ignores the given memory when memoryContext is off', async () => {
    const { engine } = fakeEngine({ cwd: '/repo', root: '/repo' })
    const config = { ...DEFAULT_CONFIG, memoryContext: false }

    const snapshot = await collectContext(engine, config, 'remembered fact')

    expect(snapshot.memory).toBe('')
    expect(snapshot.text).not.toContain('## Long-term memory')
    expect(snapshot.text).not.toContain('remembered fact')
  })

  test('leaves the memory section out when no memory is given', async () => {
    const { engine } = fakeEngine({ cwd: '/repo', root: '/repo' })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    expect(snapshot.memory).toBe('')
    expect(snapshot.text).not.toContain('## Long-term memory')
  })
})
