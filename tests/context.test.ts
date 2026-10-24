import type { EngineInterface, SessionMessage, SessionRepo, ToolUseSummary } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { CONTEXT_RULES_CHARS, DEFAULT_CONFIG, type EnginePorts } from '../hooks/contracts'
import { PROJECT_SCAN_MS } from '../hooks/project-context'
import { PreparationCancelled } from '../hooks/preparation'
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
  /** Timer waits requested from the fake clock. */
  sleep: number
  forbidden: string[]
  /** Every argument `$.session.messages()` was called with (`undefined` for none). */
  messageCalls: unknown[]
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface SleepCall {
  readonly ms: number
  readonly signal: AbortSignal | undefined
  readonly due: number
  readonly resolve: () => void
  readonly reject: (reason?: unknown) => void
  settled: boolean
}

/** A deterministic timer: `advance` moves `now` and resolves due waits. */
interface TestClock {
  readonly port: NonNullable<EnginePorts['clock']>
  readonly calls: SleepCall[]
  advance(ms: number): void
}

function testClock(start = 0): TestClock {
  let now = start
  const calls: SleepCall[] = []
  const port = {
    sleep: (ms: number, options?: { signal?: AbortSignal }): Promise<void> => {
      const wait = deferred<void>()
      const call: SleepCall = {
        ms,
        signal: options?.signal,
        due: now + ms,
        resolve: () => {
          if (call.settled) return
          call.settled = true
          wait.resolve(undefined)
        },
        reject: reason => {
          if (call.settled) return
          call.settled = true
          wait.reject(reason)
        },
        settled: false,
      }
      calls.push(call)
      const onAbort = (): void => call.reject(new Error('sleep aborted'))
      if (options?.signal?.aborted === true) onAbort()
      else options?.signal?.addEventListener('abort', onAbort, { once: true })
      return wait.promise
    },
  } as unknown as NonNullable<EnginePorts['clock']>
  return {
    port,
    calls,
    advance: ms => {
      now += ms
      for (const call of [...calls]) if (call.due <= now) call.resolve()
    },
  }
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
  clock?: TestClock
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
  clock: TestClock
} {
  const calls: Calls = {
    messages: 0,
    cwd: 0,
    root: 0,
    repo: 0,
    stat: 0,
    read: 0,
    sleep: 0,
    forbidden: [],
    messageCalls: [],
  }
  const clock = options.clock ?? testClock()
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
      messages: async (args?: { as?: 'api' }) => {
        calls.messages += 1
        calls.messageCalls.push(args)
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
    clock: {
      sleep: (ms: number, waitOptions?: { signal?: AbortSignal }) => {
        calls.sleep += 1
        return clock.port.sleep(ms, waitOptions)
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

  return { engine: engine as unknown as EngineInterface, calls, reads, clock }
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

  test('preserves repository evidence and the latest conversation within the total budget', () => {
    const snapshot = buildSnapshot(baseInput({
      project: 'src/images.ts:12 baseline = previousImage',
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
    const snapshot = await collectContext(engine, DEFAULT_CONFIG, 'node image API')
    expect(snapshot.project).toContain('repository inspection unavailable')
    expect(snapshot.text).toContain('Repository evidence (partial, read-only)')
  })

  test('a zero context budget skips every transcript, filesystem and timer call', async () => {
    const { engine, calls } = fakeEngine({
      messages: [message('user', 'hello')],
      files: { '/repo/CLAUDE.md': 'rules' },
    })
    const snapshot = await collectContext(engine, { ...DEFAULT_CONFIG, contextMaxChars: 0 }, 'node image API')

    expect(snapshot).toEqual({
      conversation: '',
      rules: '',
      location: '',
      project: '',
      // #31 carries the source records on every snapshot; a skipped
      // collection records that nothing was read.
      repositorySources: [],
      tools: '',
      text: '',
      chars: 0,
    })
    expect(calls.messages).toBe(0)
    expect(calls.cwd).toBe(0)
    expect(calls.root).toBe(0)
    expect(calls.repo).toBe(0)
    expect(calls.stat).toBe(0)
    expect(calls.read).toBe(0)
    expect(calls.sleep).toBe(0)
    expect(calls.forbidden).toEqual([])
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

  test('never emits a long-term memory section and never reads the API-form transcript', async () => {
    const { engine, calls } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      messages: [
        message(
          'user',
          '<system-reminder>\nSessionStart hook additional context: MEM-SS-1\n</system-reminder>',
        ),
      ],
    })

    const snapshot = await collectContext(engine, DEFAULT_CONFIG)

    const apiCalls = calls.messageCalls.filter(
      call => (call as { as?: string } | undefined)?.as === 'api',
    )
    expect(calls.messageCalls.length).toBeGreaterThan(0)
    expect(apiCalls).toHaveLength(0)
    expect('memory' in snapshot).toBe(false)
    expect(snapshot.text).not.toContain('## Long-term memory')
  })
})

describe('repository source records', () => {
  test('buildSnapshot carries the records without altering the text', () => {
    const sources = [{ path: 'docs/ADR.md', excerpt: 'docs/ADR.md\n1: Decision: keep history', kind: 'domain' as const }]
    const carried = buildSnapshot(baseInput({ project: 'docs/ADR.md\n1: Decision: keep history', projectSources: sources }))
    expect(carried.repositorySources).toEqual(sources)
    expect(carried.text).toContain('Decision: keep history')

    const without = buildSnapshot(baseInput({ project: 'x' }))
    expect('repositorySources' in without).toBe(false)
  })

  test('collectContext carries the collector records, each read exactly once', async () => {
    const { engine, reads } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: {
        '/repo/CLAUDE.md': 'project rules',
        '/repo/GLOSSARY.md': '# Domain\nNode: resolved graph object',
        '/repo/package.json': '{"scripts":{"test":"vitest run"}}',
      },
    })
    // The plain fake stats only files; give the scan a resolvable root and
    // real paths so the bounded inspection can read its candidates.
    const baseStat = engine.fs.stat.bind(engine.fs)
    engine.fs.stat = (async (path: string, options?: { resolve?: boolean }) => {
      if (path === '/repo') {
        return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' }
      }
      const result = await baseStat(path, options)
      return result.kind === 'file' && result.realPath === undefined
        ? { ...result, realPath: path }
        : result
    }) as typeof engine.fs.stat

    const snapshot = await collectContext(engine, DEFAULT_CONFIG, 'node image API')

    const sources = snapshot.repositorySources ?? []
    expect(sources.map(source => source.path).sort()).toEqual(['GLOSSARY.md', 'package.json'])
    for (const source of sources) {
      expect(source.excerpt.length).toBeGreaterThan(0)
      expect(snapshot.text).toContain(source.excerpt)
      // One scan serves both the text and the records: each path is read once,
      // and nothing is parsed back out of the model-facing text.
      expect(reads.filter(path => path === `/repo/${source.path}`)).toHaveLength(1)
    }
  })

  test('unavailable or skipped collection records no sources', async () => {
    const { engine } = fakeEngine()
    const unavailable = await collectContext(engine, DEFAULT_CONFIG, 'node image API')
    expect(unavailable.project).toContain('repository inspection unavailable')
    expect(unavailable.repositorySources).toEqual([])

    const { engine: zero } = fakeEngine()
    const skipped = await collectContext(zero, { ...DEFAULT_CONFIG, contextMaxChars: 0 }, 'node image API')
    expect(skipped.project).toBe('')
    expect(skipped.repositorySources).toEqual([])
  })
})

describe('collectContext — bounded preparation', () => {
  /** Spins microtasks until `predicate` holds; no real time passes. */
  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('waitFor: condition never held')
  }

  test('a hung transcript times out while location and rules still collect', async () => {
    const { engine, calls, clock } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { '/repo/CLAUDE.md': 'project rules' },
    })
    let started = false
    engine.session.messages = (() => {
      started = true
      return new Promise<SessionMessage[]>(() => {})
    }) as EnginePorts['session']['messages']

    const pending = collectContext(engine, DEFAULT_CONFIG)
    expect(started).toBe(true)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.conversation).toBe('')
    expect(snapshot.location).toBe('cwd: .')
    expect(snapshot.rules).toContain('project rules')
    expect(calls.forbidden).toEqual([])
  })

  test('a hung cwd times out without losing the other sections', async () => {
    const { engine, clock } = fakeEngine({
      root: '/repo',
      files: { '/repo/CLAUDE.md': 'project rules' },
    })
    let started = false
    engine.session.cwd = (() => {
      started = true
      return new Promise<string>(() => {})
    }) as EnginePorts['session']['cwd']

    const pending = collectContext(engine, DEFAULT_CONFIG)
    await waitFor(() => started)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.location).toBe('')
    expect(snapshot.rules).toContain('project rules')
  })

  test('a hung root times out and skips rule and repository scans', async () => {
    const { engine, calls, clock } = fakeEngine({
      files: { '/repo/CLAUDE.md': 'project rules' },
    })
    let started = false
    engine.session.root = (() => {
      started = true
      return new Promise<string>(() => {})
    }) as EnginePorts['session']['root']

    const pending = collectContext(engine, DEFAULT_CONFIG, 'image')
    await waitFor(() => started)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.rules).toBe('')
    expect(snapshot.project).toBe('')
    expect(calls.stat).toBe(0)
    expect(calls.read).toBe(0)
  })

  test('a hung repo times out while the location still names cwd', async () => {
    const { engine, clock } = fakeEngine({ cwd: '/repo', root: '/repo' })
    let started = false
    engine.session.repo = (() => {
      started = true
      return new Promise<SessionRepo | null>(() => {})
    }) as EnginePorts['session']['repo']

    const pending = collectContext(engine, DEFAULT_CONFIG)
    await waitFor(() => started)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.location).toBe('cwd: .')
  })

  test('a hung rule stat times out and later candidates still run', async () => {
    const { engine, clock } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { '/repo/AGENTS.md': 'later rules' },
    })
    const stat = engine.fs.stat
    let started = false
    engine.fs.stat = async path => {
      if (path === '/repo/CLAUDE.md') {
        started = true
        return new Promise(() => {})
      }
      return stat(path)
    }

    const pending = collectContext(engine, DEFAULT_CONFIG)
    await waitFor(() => started)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.rules).toContain('later rules')
  })

  test('a hung rule read times out and the read is not retried', async () => {
    const { engine, calls, clock } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { '/repo/CLAUDE.md': 'unreachable', '/repo/AGENTS.md': 'later rules' },
    })
    let reads = 0
    let started = false
    engine.fs.read = async path => {
      reads += 1
      if (path === '/repo/CLAUDE.md') {
        started = true
        return new Promise(() => {})
      }
      return 'later rules'
    }

    const pending = collectContext(engine, DEFAULT_CONFIG)
    await waitFor(() => started)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.rules).toContain('later rules')
    expect(reads).toBe(2)
    expect(calls.read).toBe(0)
  })

  test('the first rule survives a later hung candidate', async () => {
    const { engine, clock } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { '/repo/CLAUDE.md': 'first rules', '/repo/AGENTS.md': 'later rules' },
    })
    const stat = engine.fs.stat
    let started = false
    engine.fs.stat = async path => {
      if (path === '/repo/AGENTS.md') {
        started = true
        return new Promise(() => {})
      }
      return stat(path)
    }

    const pending = collectContext(engine, DEFAULT_CONFIG)
    await waitFor(() => started)
    clock.advance(500)
    const snapshot = await pending

    expect(snapshot.rules).toContain('first rules')
    expect(snapshot.rules).not.toContain('later rules')
  })

  test('a missing root skips all rule and repository file IO', async () => {
    const { engine, calls } = fakeEngine({ root: '' })
    const snapshot = await collectContext(engine, DEFAULT_CONFIG, 'image')

    expect(snapshot.rules).toBe('')
    expect(snapshot.project).toBe('')
    expect(calls.stat).toBe(0)
    expect(calls.read).toBe(0)
  })

  test('contextTurns 0 skips the transcript while other sections collect', async () => {
    const { engine, calls } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      messages: [message('user', 'hello')],
      files: { '/repo/CLAUDE.md': 'project rules' },
    })
    const snapshot = await collectContext(engine, { ...DEFAULT_CONFIG, contextTurns: 0 })

    expect(calls.messages).toBe(0)
    expect(snapshot.conversation).toBe('')
    expect(snapshot.rules).toContain('project rules')
  })

  test('cancellation rejects with PreparationCancelled and starts no next read', async () => {
    const { engine, calls } = fakeEngine({ cwd: '/repo', root: '/repo' })
    engine.session.messages = (() => new Promise<SessionMessage[]>(() => {})) as EnginePorts['session']['messages']
    const controller = new AbortController()

    const pending = collectContext(engine, DEFAULT_CONFIG, '', { signal: controller.signal })
    controller.abort()
    let error: unknown
    try {
      await pending
    } catch (cause) {
      error = cause
    }

    expect(error).toBeInstanceOf(PreparationCancelled)
    expect(calls.cwd).toBe(0)
    expect(calls.root).toBe(0)
    expect(calls.stat).toBe(0)
  })

  test('a hung project scan times out, keeps the rest, and ignores its late result', async () => {
    const { engine, calls, clock } = fakeEngine({
      cwd: '/repo',
      root: '/repo',
      files: { '/repo/CLAUDE.md': 'project rules' },
    })
    const stat = engine.fs.stat
    let release: ((value: { kind: 'dir'; size: number; mtimeMs: number; isLink: boolean; realPath: string }) => void) | undefined
    engine.fs.stat = async (path, options) => {
      if (path === '/repo') {
        return new Promise(resolve => { release = resolve as typeof release })
      }
      return stat(path, options)
    }
    const pending = collectContext(engine, DEFAULT_CONFIG, 'image')
    await waitFor(() => release !== undefined)
    // Rule reads finished before the repository step; any later read is late.
    const before = calls.read
    clock.advance(PROJECT_SCAN_MS)
    const snapshot = await pending

    expect(snapshot.project).toBe('')
    expect(snapshot.rules).toContain('project rules')

    release?.({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' })
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    expect(calls.read).toBe(before)
  })

  test('cancellation during a project scan exits without waiting for the read', async () => {
    const { engine, clock } = fakeEngine({ cwd: '/repo', root: '/repo' })
    const stat = engine.fs.stat
    let release: (() => void) | undefined
    engine.fs.stat = async (path, options) => {
      if (path === '/repo') return new Promise(() => {})
      return stat(path, options)
    }
    const controller = new AbortController()
    const pending = collectContext(engine, DEFAULT_CONFIG, 'image', { signal: controller.signal })
    await waitFor(() => clock.calls.some(call => call.ms === PROJECT_SCAN_MS))

    controller.abort()
    let error: unknown
    try {
      await pending
    } catch (cause) {
      error = cause
    }
    expect(error).toBeInstanceOf(PreparationCancelled)
    release?.()
  })

  test('the repository step is capped at PROJECT_SCAN_MS', async () => {
    const { engine, clock } = fakeEngine({ files: { '/repo/README.md': 'image docs' } })
    await collectContext(engine, DEFAULT_CONFIG, 'image')
    expect(clock.calls.some(call => call.ms === PROJECT_SCAN_MS)).toBe(true)
  })

  test('a host without a usable timer fails closed without any read', async () => {
    const { engine, calls } = fakeEngine({
      messages: [message('user', 'hello')],
      files: { '/repo/CLAUDE.md': 'rules' },
    })
    delete (engine as unknown as { clock?: unknown }).clock

    const snapshot = await collectContext(engine, DEFAULT_CONFIG, 'image')

    expect(snapshot.text).toBe('')
    expect(calls.messages).toBe(0)
    expect(calls.cwd).toBe(0)
    expect(calls.root).toBe(0)
    expect(calls.repo).toBe(0)
    expect(calls.stat).toBe(0)
    expect(calls.read).toBe(0)
  })
})
