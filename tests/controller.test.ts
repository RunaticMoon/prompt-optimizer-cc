import type {
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelTextBlock,
  PromptFillArgs,
  PromptFilled,
  PromptSubmitArgs,
  PromptSubmitInput,
  PromptSubmitResult,
  SessionMessage,
  SessionVersion,
} from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type {
  EnginePorts,
  ModelUsage,
  OptimizerConfig,
  RefinementLevel,
  RuntimeState,
} from '../hooks/contracts'
import { DEFAULT_CONFIG, MAX_REQUEST_CHARS } from '../hooks/contracts'
import {
  createController,
  IN_FLIGHT_REASON,
  PANE_ID,
  type ControllerDeps,
  type OptimizerController,
} from '../hooks/controller'
import { activeDecisions, hasPendingCorrection } from '../hooks/decisions'
import { REQUEST_BUDGET_NOTICE } from '../hooks/model'
import type { RawEditFacts } from '../hooks/raw-mode'

const USAGE: ModelUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1,
  cache_creation_input_tokens: 2,
}

/** An answered completion carrying the fixed JSON contract. */
function answered(
  draft: string,
  message = '',
  question: string | null = null,
  options?: readonly string[],
): ModelCompleteResult {
  return { isAnswered: true, text: JSON.stringify({ draft, message, question, options }), usage: USAGE }
}

/** A failed completion, the API-error arm. */
function apiError(): ModelCompleteResult {
  return { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE }
}

/** A recorded request's `prompt`/`system` as one text: a string stands, blocks join in order. */
function requestText(input: string | readonly ModelTextBlock[] | undefined): string {
  return typeof input === 'string' ? input : (input ?? []).map(block => block.text).join('')
}

/** One engine call each, counted so a test can assert what ran and how often. */
interface Calls {
  messages: number
  cwd: number
  root: number
  repo: number
  model: number
  stat: number
  fileRead: number
  complete: number
  fork: number
  promptRead: number
  fill: number
  submit: number
  close: number
  version: number
}

interface HarnessOptions {
  ui?: Partial<EnginePorts['ui']>
  config?: Partial<OptimizerConfig>
  /** Overrides for individual dependencies (e.g. a throwing `getConfig`). */
  deps?: Partial<ControllerDeps>
  /** A live box, or texts returned by successive reads; '' when absent. */
  box?: string | readonly string[]
  messages?: readonly SessionMessage[]
  files?: Readonly<Record<string, string>>
  /**
   * The main session's model getter. Supplying it also installs a deterministic
   * clock, so the target-model race resolves without a real 500 ms wait. Omit it
   * to model a host with no `session.model` port (common/unavailable).
   */
  model?: () => string | Promise<string>
  /** Overrides `session.version()`. Omit to model a host with no version port. */
  version?: () => Promise<SessionVersion>
  /** Overrides `fs.read`; lets a test hold one file read open. */
  read?: (path: string) => Promise<string>
  complete?: (
    request: ModelCompleteRequest,
    signal: AbortSignal | undefined,
    call: number,
  ) => Promise<ModelCompleteResult>
  fill?: (input: PromptFillArgs) => PromptFilled | Promise<PromptFilled>
  submit?: (input: PromptSubmitArgs) => PromptSubmitResult | Promise<PromptSubmitResult>
  now?: number
  /**
   * When false, `onSubmit` reaches the controller exactly as called, with no
   * simulated typing. The default (true) models the engine's `prompt.edit` for
   * the person's typing before a composer Enter, so `onSubmit(submit(text))`
   * alone is an ordinary typed prompt rather than a paste (PSTB-2735 §7).
   */
  simulateTyping?: boolean
}

interface Harness {
  controller: OptimizerController
  ports: EnginePorts
  /** A manual `schedule` queue; `flush` runs each queued callback in order. */
  queue: Array<() => unknown>
  notices: Array<string | undefined>
  changes: RuntimeState[]
  calls: Calls
  fills: PromptFillArgs[]
  submits: PromptSubmitArgs[]
  closes: string[]
  completes: ModelCompleteRequest[]
  signals: Array<AbortSignal | undefined>
  /** Fault injection: make the next notice-less repaint throw once. */
  flags: { throwOnRepaint: boolean }
  /** Runs every queued round to completion (awaits the round's own promise). */
  flush(): Promise<void>
  /** Spins microtasks until `predicate` holds, so a detached round can be observed. */
  waitFor(predicate: () => boolean, rounds?: number): Promise<void>
}

/**
 * A deterministic timer for the target-model race. `sleep` never settles on its
 * own, so a resolving getter always wins without a real wait; it rejects when
 * its own signal aborts, exactly as the resolver expects `$.clock.sleep` to.
 */
function fakeClock(): NonNullable<EnginePorts['clock']> {
  return {
    sleep: (_ms, options) =>
      new Promise<void>((_resolve, reject) => {
        const signal = options?.signal
        const onAbort = (): void => reject(new Error('sleep aborted'))
        if (signal?.aborted === true) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      }),
  }
}

/**
 * A stand-in engine plus a manual schedule queue. The controller only sees the
 * `EnginePorts` surface; the counters and thrown `fork` make a stray call fail
 * loudly. The scheduled callback returns the round's promise, so `flush` can
 * await the detached round the host would otherwise ignore.
 */
function harness(options: HarnessOptions = {}): Harness {
  const now = options.now ?? 1_000
  let nextId = 0
  let completions = 0
  const config: OptimizerConfig = { ...DEFAULT_CONFIG, ...options.config }
  const modelGetter = options.model
  const versionGetter = options.version

  const queue: Array<() => unknown> = []
  const notices: Array<string | undefined> = []
  const changes: RuntimeState[] = []
  const calls: Calls = {
    messages: 0,
    cwd: 0,
    root: 0,
    repo: 0,
    model: 0,
    stat: 0,
    fileRead: 0,
    complete: 0,
    fork: 0,
    promptRead: 0,
    fill: 0,
    submit: 0,
    close: 0,
    version: 0,
  }
  const fills: PromptFillArgs[] = []
  const submits: PromptSubmitArgs[] = []
  const closes: string[] = []
  const completes: ModelCompleteRequest[] = []
  const signals: Array<AbortSignal | undefined> = []
  const flags = { throwOnRepaint: false }
  let box = typeof options.box === 'string' ? options.box : ''
  const boxes = Array.isArray(options.box) ? [...options.box] : null
  const files = options.files ?? {}

  const deps: ControllerDeps = {
    now: () => now,
    newId: () => `wf-${(nextId += 1)}`,
    schedule: fn => {
      queue.push(fn)
    },
    getConfig: () => config,
    onChange: (state, notice) => {
      changes.push(state)
      notices.push(notice)
      if (flags.throwOnRepaint && notice === undefined) {
        flags.throwOnRepaint = false
        throw new Error('repaint failed')
      }
    },
    ...options.deps,
  }

  const engine = {
    session: {
      messages: async (): Promise<readonly SessionMessage[]> => {
        calls.messages += 1
        return [...(options.messages ?? [])]
      },
      cwd: async () => {
        calls.cwd += 1
        return '/repo'
      },
      root: async () => {
        calls.root += 1
        return '/repo'
      },
      repo: async () => {
        calls.repo += 1
        return null
      },
      ...(modelGetter === undefined
        ? {}
        : {
            model: async (): Promise<string> => {
              calls.model += 1
              return modelGetter()
            },
          }),
      ...(versionGetter === undefined
        ? {}
        : {
            version: (): Promise<SessionVersion> => {
              calls.version += 1
              return versionGetter()
            },
          }),
    },
    ...(modelGetter === undefined ? {} : { clock: fakeClock() }),
    fs: {
      stat: async (path: string) => {
        calls.stat += 1
        const text = files[path]
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false }
      },
      read: async (path: string) => {
        calls.fileRead += 1
        if (options.read !== undefined) return options.read(path)
        const text = files[path]
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
    },
    env: {
      get: async (_name: string): Promise<string | null> => null,
    },
    model: {
      complete: (
        request: ModelCompleteRequest,
        opts?: { signal?: AbortSignal },
      ): Promise<ModelCompleteResult> => {
        calls.complete += 1
        completions += 1
        completes.push(request)
        signals.push(opts?.signal)
        if (options.complete !== undefined) return options.complete(request, opts?.signal, completions)
        return Promise.resolve(answered('개선된 요청', '다듬었습니다'))
      },
      fork: (): never => {
        calls.fork += 1
        throw new Error('model.fork must never be called')
      },
    },
    prompt: {
      read: async (): Promise<{ text: string; cursor: number }> => {
        calls.promptRead += 1
        const text = boxes === null ? box : boxes.shift() ?? ''
        return { text, cursor: text.length }
      },
      fill: async (input: PromptFillArgs): Promise<PromptFilled> => {
        calls.fill += 1
        fills.push(input)
        if (options.fill !== undefined) return options.fill(input)
        box = input.mode === 'append' || input.mode === 'insert' ? box + input.text : input.text
        return { isFilled: true, text: box, cursor: box.length }
      },
      submit: async (input: PromptSubmitArgs): Promise<PromptSubmitResult> => {
        calls.submit += 1
        submits.push(input)
        if (options.submit !== undefined) return options.submit(input)
        return { text: input.text }
      },
    },
    ui: {
      ...options.ui,
      close: async ({ id }: { id: string }): Promise<void> => {
        calls.close += 1
        closes.push(id)
      },
    },
  }

  async function flush(): Promise<void> {
    while (queue.length > 0) {
      const fn = queue.shift()
      if (fn === undefined) break
      await fn()
    }
  }

  async function waitFor(predicate: () => boolean, spins = 500): Promise<void> {
    for (let i = 0; i < spins; i += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('waitFor: condition never held')
  }

  // The engine reports the person's typing as a `prompt.edit` before Enter. A
  // test that drives no edit chain still means "the person typed this draft", so
  // the harness records one typed edit before a composer submission unless the
  // test observed the draft itself (`observeEditInput`/`onFill`) or asked for
  // the raw controller (`simulateTyping: false`). PSTB-2735 turns an unobserved
  // draft into a pasted one, so this keeps the older tests on typed prompts.
  const rawController = createController(deps)
  let observedDraft = false
  const markObserved = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    observedDraft = true
    return fn(...args)
  }
  const controller: OptimizerController = options.simulateTyping === false
    ? rawController
    : {
        ...rawController,
        observeEditInput: markObserved(rawController.observeEditInput),
        onFill: markObserved(rawController.onFill),
        onSubmit: (ports, e, ui) => {
          if (e.origin.kind === 'composer' && !observedDraft) {
            rawController.observeEditInput({ key: { key: 'a' }, inputText: '' })
          }
          observedDraft = false
          return rawController.onSubmit(ports, e, ui)
        },
      }

  return {
    controller,
    ports: engine as unknown as EnginePorts,
    queue,
    notices,
    changes,
    calls,
    fills,
    submits,
    closes,
    completes,
    signals,
    flags,
    flush,
    waitFor,
  }
}

function submit(text: string, over: Partial<PromptSubmitInput> = {}): PromptSubmitInput {
  return { text, wait: false, origin: { kind: 'composer' }, ...over }
}

/** One prompt-box edit in the engine's `prompt.edit` shape. */
function edit(over: Partial<RawEditFacts> = {}): RawEditFacts {
  const start = over.start ?? 0
  return { text: '', cursor: 0, start, end: over.end ?? start, inputText: '', ...over }
}

/** Retains callbacks after cancellation so tests can simulate a queued stale tick. */
function progressClock(h: Harness): Array<{ ms: number; tick: () => void; cancelled: boolean }> {
  const timers: Array<{ ms: number; tick: () => void; cancelled: boolean }> = []
  h.ports.clock = {
    ...fakeClock(),
    every: (ms, tick) => {
      const timer = { ms, tick, cancelled: false }
      timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    },
  }
  return timers
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('live progress', () => {
  test('reports actual work stages and elapsed time without inventing usage or more completions', async () => {
    let now = 1_000
    const messages = deferred<SessionMessage[]>()
    const instructions = deferred<string>()
    const target = deferred<string>()
    const completion = deferred<ModelCompleteResult>()
    const h = harness({
      deps: { now: () => now },
      config: { systemPromptFile: '/extra.md' },
      files: { '/extra.md': 'extra instructions' },
      read: () => instructions.promise,
      model: () => target.promise,
      complete: () => completion.promise,
    })
    h.ports.session.messages = (async () => {
      h.calls.messages += 1
      return messages.promise
    }) as EnginePorts['session']['messages']
    const timers = progressClock(h)
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    const running = h.flush()
    await h.waitFor(() => h.calls.messages === 1)

    expect(h.controller.getState().workflow?.progress).toEqual({
      stage: 'context', startedAt: 1_000, updatedAt: 1_000,
    })
    expect(timers.length).toBe(1)
    expect(timers[0]?.ms).toBe(1_000)
    const unused = h.controller.getState().usage
    now = 2_000
    timers[0]?.tick()
    expect(h.controller.getState().workflow?.progress?.updatedAt).toBe(2_000)
    expect(h.controller.getState().usage).toEqual(unused)
    expect(h.calls.complete).toBe(0)

    now = 3_000
    messages.resolve([])
    await h.waitFor(() => h.calls.fileRead === 1)
    expect(h.controller.getState().workflow?.progress).toEqual({
      stage: 'instructions', startedAt: 1_000, updatedAt: 3_000,
    })

    now = 4_000
    instructions.resolve('extra instructions')
    await h.waitFor(() => h.calls.model === 1)
    expect(h.controller.getState().workflow?.progress).toEqual({
      stage: 'target-model', startedAt: 1_000, updatedAt: 4_000,
    })

    now = 5_000
    target.resolve('claude-opus-5-5')
    await h.waitFor(() => h.calls.complete === 1)
    expect(h.controller.getState().workflow?.progress).toEqual({
      stage: 'generating', startedAt: 1_000, updatedAt: 5_000,
    })
    now = 6_000
    timers[0]?.tick()
    expect(h.controller.getState().workflow?.progress?.updatedAt).toBe(6_000)
    expect(h.controller.getState().usage).toEqual(unused)
    expect(h.calls.complete).toBe(1)

    completion.resolve(answered('개선안'))
    await running
    expect(timers[0]?.cancelled).toBe(true)
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
    expect(h.controller.getState().usage.calls).toBe(1)
    expect(h.controller.getState().usage.output).toBe(USAGE.output_tokens)
    const settled = h.controller.getState()
    const repaints = h.changes.length
    now = 7_000
    timers[0]?.tick()
    expect(h.controller.getState()).toBe(settled)
    expect(h.changes.length).toBe(repaints)
    expect(h.calls.complete).toBe(1)
  })

  for (const action of ['refine', 'retry'] as const) {
    test(`${action} starts a fresh elapsed clock and ignores the previous round's tick`, async () => {
      let now = 1_000
      const completion = deferred<ModelCompleteResult>()
      const h = harness({
        deps: { now: () => now },
        complete: async (_request, _signal, call) => call === 1 ? answered('첫 초안') : completion.promise,
      })
      const timers = progressClock(h)
      h.controller.onSessionStart('sess-1')
      await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
      await h.flush()
      expect(timers[0]?.cancelled).toBe(true)

      now = 10_000
      const running = action === 'refine'
        ? h.controller.refine(h.ports, '더 짧게')
        : h.controller.retry(h.ports)
      await h.waitFor(() => h.calls.complete === 2)
      expect(timers.length).toBe(2)
      expect(h.controller.getState().workflow?.progress).toEqual({
        stage: 'generating', startedAt: 10_000, updatedAt: 10_000,
      })
      const current = h.controller.getState()
      now = 11_000
      timers[0]?.tick()
      expect(h.controller.getState()).toBe(current)
      timers[1]?.tick()
      expect(h.controller.getState().workflow?.progress?.updatedAt).toBe(11_000)
      expect(h.controller.getState().usage).toEqual(current.usage)
      expect(h.calls.messages).toBe(1)
      expect(h.calls.complete).toBe(2)

      completion.resolve(answered('보완한 초안'))
      await running
      expect(timers[1]?.cancelled).toBe(true)
      expect(h.controller.getState().usage.calls).toBe(2)
    })
  }

  for (const stage of ['context', 'generating'] as const) {
    test(`cancel during ${stage} stops progress and cannot repaint a replacement run`, async () => {
      let now = 1_000
      const messages = deferred<SessionMessage[]>()
      const completion = deferred<ModelCompleteResult>()
      const h = harness({ deps: { now: () => now }, complete: () => completion.promise })
      if (stage === 'context') {
        h.ports.session.messages = (async () => {
          h.calls.messages += 1
          return h.calls.messages === 1 ? messages.promise : []
        }) as EnginePorts['session']['messages']
      }
      const timers = progressClock(h)
      h.controller.onSessionStart('sess-1')
      await h.controller.onSubmit(h.ports, submit('이전 요청'), 'pane')
      const running = h.flush()
      await h.waitFor(() => stage === 'context' ? h.calls.messages === 1 : h.calls.complete === 1)

      await h.controller.cancel(h.ports)
      expect(timers[0]?.cancelled).toBe(true)
      const cancelled = h.controller.getState()
      now = 2_000
      timers[0]?.tick()
      expect(h.controller.getState()).toBe(cancelled)

      now = 3_000
      await h.controller.onSubmit(h.ports, submit('새 요청'), 'pane')
      const replacement = h.flush()
      await h.waitFor(() => timers.length === 2 && h.controller.getState().workflow?.progress?.stage === 'generating')
      const current = h.controller.getState()
      now = 4_000
      timers[0]?.tick()
      expect(h.controller.getState()).toBe(current)
      timers[1]?.tick()
      expect(h.controller.getState().workflow?.progress?.updatedAt).toBe(4_000)

      messages.resolve([])
      completion.resolve(answered('응답'))
      await Promise.all([running, replacement])
      expect(h.controller.getState().workflow?.original).toBe('새 요청')
      expect(h.controller.getState().workflow?.phase).toBe('reviewing')
      expect(timers[1]?.cancelled).toBe(true)
    })
  }

  for (const transition of ['start', 'end'] as const) {
    test(`session ${transition} stops progress and ignores late ticks`, async () => {
      let now = 1_000
      const completion = deferred<ModelCompleteResult>()
      const h = harness({ deps: { now: () => now }, complete: () => completion.promise })
      const timers = progressClock(h)
      h.controller.onSessionStart('sess-1')
      await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
      const running = h.flush()
      await h.waitFor(() => h.calls.complete === 1)

      if (transition === 'start') h.controller.onSessionStart('sess-2')
      else h.controller.onSessionEnd()
      expect(timers[0]?.cancelled).toBe(true)
      expect(h.signals[0]?.aborted).toBe(true)
      const reset = h.controller.getState()
      now = 2_000
      timers[0]?.tick()
      expect(h.controller.getState()).toBe(reset)
      completion.resolve(answered('늦은 응답'))
      await running
      expect(h.controller.getState().workflow).toBeNull()
    })
  }

  test('a failed completion stops the timer before restoring the original', async () => {
    const h = harness({ complete: async () => apiError() })
    const timers = progressClock(h)
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(timers[0]?.cancelled).toBe(true)
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.fills[0]?.text).toBe('원문')
    const settled = h.controller.getState()
    timers[0]?.tick()
    expect(h.controller.getState()).toBe(settled)
  })

  test('an unexpected repaint failure releases the progress timer', async () => {
    const messages = deferred<SessionMessage[]>()
    const h = harness()
    h.ports.session.messages = (async () => {
      h.calls.messages += 1
      return messages.promise
    }) as EnginePorts['session']['messages']
    const timers = progressClock(h)
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    const running = h.flush()
    await h.waitFor(() => h.calls.messages === 1)
    h.flags.throwOnRepaint = true
    messages.resolve([])
    await running

    expect(timers[0]?.cancelled).toBe(true)
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.calls.complete).toBe(0)
    expect(h.notices).toContain('개선 중 예기치 않은 오류가 발생했습니다: repaint failed')
  })

  for (const failure of ['start', 'cancel'] as const) {
    test(`a timer ${failure} failure does not prevent a completed optimization`, async () => {
      const h = harness()
      h.ports.clock = {
        ...fakeClock(),
        every: () => {
          if (failure === 'start') throw new Error('timer unavailable')
          return { cancel: () => { throw new Error('timer cancellation failed') } }
        },
      }
      h.controller.onSessionStart('sess-1')
      await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
      await h.flush()

      expect(h.controller.getState().workflow?.phase).toBe('reviewing')
      expect(h.controller.getState().workflow?.draft).toBe('개선된 요청')
      expect(h.calls.complete).toBe(1)
      expect(h.controller.getState().usage.calls).toBe(1)
    })
  }
})

describe('onSubmit — intercepts one submission', () => {
  test('drops it, then runs exactly one collect and one completion from the queue', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const outcome = await h.controller.onSubmit(h.ports, submit('로그인 오류를 고쳐줘'), 'pane')

    expect(outcome).toEqual({ action: 'drop', reason: '프롬프트를 다듬는 중입니다.' })
    expect(h.calls.complete).toBe(0)
    expect(h.calls.submit).toBe(0)
    expect(h.calls.fork).toBe(0)

    await h.flush()

    expect(h.calls.messages).toBe(1)
    expect(h.calls.complete).toBe(1)
    expect(h.calls.submit).toBe(0)
    expect(h.calls.fork).toBe(0)
    const workflow = h.controller.getState().workflow
    expect(workflow?.phase).toBe('reviewing')
    expect(workflow?.original).toBe('로그인 오류를 고쳐줘')
    expect(workflow?.draft).toBe('개선된 요청')
    expect(workflow?.rounds).toBe(1)
  })

  test('passes a non-composer submission straight through', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const outcome = await h.controller.onSubmit(
      h.ports,
      { text: 'sdk prompt', wait: false, origin: { kind: 'sdk' } },
      'pane',
    )

    expect(outcome).toEqual({ action: 'next', text: 'sdk prompt' })
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('continues improvement when the consumed composer cannot be read', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.ports.prompt.read = async () => { throw new Error('composer unavailable') }

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(h.calls.fill).toBe(0)
    expect(h.calls.complete).toBe(1)
    expect(h.controller.getState().workflow?.draft).toBe('개선된 요청')
  })

  for (const interruption of ['cancel', 'session'] as const) {
    test(`a ${interruption} while reading the consumed composer prevents a late clear`, async () => {
      const h = harness({ box: '원문' })
      h.controller.onSessionStart('sess-1')
      const read = h.ports.prompt.read
      let reading = false
      let finishRead: (box: { text: string; cursor: number }) => void = () => undefined
      const pendingRead = new Promise<{ text: string; cursor: number }>(resolve => { finishRead = resolve })
      h.ports.prompt.read = async () => {
        if (reading) return read()
        reading = true
        return pendingRead
      }

      await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
      const pending = h.flush()
      await h.waitFor(() => reading)
      if (interruption === 'cancel') await h.controller.cancel(h.ports)
      else {
        h.controller.onSessionEnd()
        h.controller.onSessionStart('sess-2')
      }
      const fillsBefore = h.fills.length
      finishRead({ text: '원문', cursor: 2 })
      await pending

      expect(h.fills).toHaveLength(fillsBefore)
      expect(h.calls.complete).toBe(0)
      expect(h.controller.getState().workflow).toBeNull()
    })
  }

  test('sends an armed raw submission as typed and clears the mode', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))
    expect(h.controller.getState().rawMode).not.toBeNull()

    const outcome = await h.controller.onSubmit(h.ports, submit('>> 그냥 보내기'), 'pane')

    expect(outcome).toEqual({ action: 'next', text: '>> 그냥 보내기' })
    expect(h.controller.getState().rawMode).toBeNull()
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.calls.complete).toBe(0)
  })

  test('the mode is one-shot: the next ordinary submission is optimized', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    expect(await h.controller.onSubmit(h.ports, submit('그대로'), 'pane')).toEqual({
      action: 'next',
      text: '그대로',
    })
    expect(h.controller.getState().rawMode).toBeNull()

    const optimized = await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    expect(optimized.action).toBe('drop')
    expect(h.controller.getState().workflow?.original).toBe('원문')
  })

  test('drops a raw decision whose remainder is blank', async () => {
    // Prefix mode hands back an empty raw decision for a bare trigger; the
    // controller drops it rather than forwarding the bare trigger.
    const h = harness({ config: { triggerMode: 'prefix' } })
    h.controller.onSessionStart('sess-1')

    const dropped = await h.controller.onSubmit(h.ports, submit('?? '), 'pane')

    expect(dropped).toEqual({ action: 'drop', reason: '보낼 내용이 없습니다.' })
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('drops a second submission while a run is active', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('첫 요청'), 'pane')

    const outcome = await h.controller.onSubmit(h.ports, submit('둘째 요청'), 'pane')

    expect(outcome).toEqual({
      action: 'drop',
      reason: '프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.',
    })
  })

  test('treats a composer submission as a refinement answer', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'composer')
    await h.flush()

    const outcome = await h.controller.onSubmit(h.ports, submit('더 짧게'), 'composer')

    expect(outcome).toEqual({ action: 'drop', reason: '보완 요청을 옵티마이저에 전달했습니다.' })
    await h.flush()
    expect(h.calls.complete).toBe(2)
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
  })

  test('passes the original through when classification cannot run', async () => {
    const h = harness({
      deps: {
        getConfig: () => {
          throw new Error('bad config')
        },
      },
    })
    h.controller.onSessionStart('sess-1')

    const outcome = await h.controller.onSubmit(h.ports, submit('원문'), 'pane')

    expect(outcome).toEqual({ action: 'next', text: '원문' })
  })

  test('passes the original through and leaves no run when scheduling fails', async () => {
    const h = harness({
      deps: {
        schedule: () => {
          throw new Error('no clock')
        },
      },
    })
    h.controller.onSessionStart('sess-1')

    const outcome = await h.controller.onSubmit(h.ports, submit('원문'), 'pane')

    expect(outcome).toEqual({ action: 'next', text: '원문' })
    expect(h.controller.getState().workflow).toBeNull()
  })
})

describe('onComposerEdit — the optimizer-off mode', () => {
  test('arms when the marker is typed and consumes the edit', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const box = h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    expect(box).toEqual({ text: '', cursor: 0 })
    expect(h.controller.getState().rawMode).toEqual({ sessionId: 'sess-1', draft: '' })
  })

  test('arms over existing text, keeping the text and moving the caret', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const box = h.controller.onComposerEdit(
      edit({ text: '>>abc', cursor: 2, start: 2, inputText: ' ', key: { key: ' ' } }),
    )

    expect(box).toEqual({ text: 'abc', cursor: 0 })
    expect(h.controller.getState().rawMode?.draft).toBe('abc')
  })

  test('ctrl+u releases the mode, consuming the edit and keeping the box', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(
      edit({ text: '>>본문', cursor: 2, start: 2, inputText: ' ', key: { key: ' ' } }),
    )
    expect(h.controller.getState().rawMode?.draft).toBe('본문')

    const box = h.controller.onComposerEdit(
      edit({ text: '본문', cursor: 2, key: { key: 'u', ctrl: true } }),
    )

    expect(box).toEqual({ text: '본문', cursor: 2 })
    expect(h.controller.getState().rawMode).toBeNull()
  })

  test('any other edit passes while armed and keeps the mode', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    const box = h.controller.onComposerEdit(
      edit({ text: '', cursor: 0, start: 0, inputText: 'a', key: { key: 'a' } }),
    )

    expect(box).toBeNull()
    expect(h.controller.getState().rawMode).not.toBeNull()
  })

  test('a box changed out of sight first clears the stale mode', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    // The remembered draft is '', but the reported pre-edit box is not.
    const box = h.controller.onComposerEdit(edit({ text: '몰래 바뀐 상자', cursor: 7 }))

    expect(box).toBeNull()
    expect(h.controller.getState().rawMode).toBeNull()
  })

  test('an active workflow blocks arming', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    expect(h.controller.getState().workflow).not.toBeNull()

    const box = h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    expect(box).toBeNull()
    expect(h.controller.getState().rawMode).toBeNull()
  })
})

describe('onPromptEdit — the optimizer-off mode', () => {
  test('follows the box text while armed', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    h.controller.onPromptEdit('새로 쓴 내용')

    expect(h.controller.getState().rawMode?.draft).toBe('새로 쓴 내용')
  })

  test('does nothing without the mode or a permit', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    h.controller.onPromptEdit('내용')

    expect(h.controller.getState().rawMode).toBeNull()
    expect(h.controller.getState().bypass).toBeNull()
  })
})

describe('composition — a paste-only draft reaches the classifier', () => {
  test('an ordinary typed submission is still optimized', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const outcome = await h.controller.onSubmit(h.ports, submit('로그인 오류를 고쳐줘'), 'pane')

    expect(outcome).toEqual({ action: 'drop', reason: '프롬프트를 다듬는 중입니다.' })
    expect(h.controller.getState().workflow?.original).toBe('로그인 오류를 고쳐줘')
  })

  test('a key-less paste of eight or more characters passes the original through', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '붙여넣은 여러 줄 텍스트' })

    expect(h.controller.submissionFacts('붙여넣은 여러 줄 텍스트')).toEqual({
      pasted: true,
      reason: 'keyless-long-insert',
    })
    expect(await h.controller.onSubmit(h.ports, submit('붙여넣은 여러 줄 텍스트'), 'pane')).toEqual({
      action: 'next',
      text: '붙여넣은 여러 줄 텍스트',
    })
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.calls.complete).toBe(0)
  })

  test('a placeholder seen only by autocomplete passes the expanded original through', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeComposer('[Pasted text #1 +3 lines]')

    expect(await h.controller.onSubmit(h.ports, submit('펼쳐진 붙여넣기 원문'), 'pane')).toEqual({
      action: 'next',
      text: '펼쳐진 붙여넣기 원문',
    })
    expect(h.calls.complete).toBe(0)
  })

  test('a submission with no observed event passes as pasted', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')

    expect(await h.controller.onSubmit(h.ports, submit('이벤트 없이 도착한 원문'), 'pane')).toEqual({
      action: 'next',
      text: '이벤트 없이 도착한 원문',
    })
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.calls.complete).toBe(0)
  })

  test('one typed key mixed into a paste keeps the draft optimizable', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '붙여넣은 여러 줄 텍스트' })
    h.controller.observeEditInput({ key: { key: 'x' }, inputText: 'x' })

    expect(h.controller.submissionFacts('붙여넣은 여러 줄 텍스트x')).toEqual({ pasted: false, reason: 'typed' })
    const outcome = await h.controller.onSubmit(h.ports, submit('붙여넣은 여러 줄 텍스트x'), 'pane')
    expect(outcome.action).toBe('drop')
    expect(h.controller.getState().workflow?.original).toBe('붙여넣은 여러 줄 텍스트x')
  })

  test('pasteBypass off optimizes a paste-only draft', async () => {
    const h = harness({ simulateTyping: false, config: { pasteBypass: false } })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '붙여넣은 여러 줄 텍스트' })

    const outcome = await h.controller.onSubmit(h.ports, submit('붙여넣은 여러 줄 텍스트'), 'pane')
    expect(outcome.action).toBe('drop')
    expect(h.controller.getState().workflow?.original).toBe('붙여넣은 여러 줄 텍스트')
  })

  test('a submission consumes the draft composition it classified', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '타이핑한 초안' })
    expect(h.controller.submissionFacts('타이핑한 초안')).toEqual({ pasted: false, reason: 'typed' })

    // Arm the optimizer-off mode so the submission passes without a run.
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))
    expect(await h.controller.onSubmit(h.ports, submit('타이핑한 초안'), 'pane')).toEqual({
      action: 'next',
      text: '타이핑한 초안',
    })
    // The typed draft left with the submission; the next one is fresh, so a
    // text this session never submitted is pasted again.
    expect(h.controller.submissionFacts('새 초안')).toEqual({ pasted: true, reason: 'no-input-events' })

    h.controller.observeEditInput({ key: { key: 'b' }, inputText: '다음 타이핑 초안' })
    expect((await h.controller.onSubmit(h.ports, submit('다음 타이핑 초안'), 'pane')).action).toBe('drop')
    expect(h.controller.getState().workflow?.original).toBe('다음 타이핑 초안')
  })

  test('a plugin fill of non-empty text is optimized on a later Enter', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.onFill(false)
    expect(h.controller.submissionFacts('플러그인이 넣은 초안')).toEqual({
      pasted: false,
      reason: 'observed-other',
    })

    const outcome = await h.controller.onSubmit(h.ports, submit('플러그인이 넣은 초안'), 'pane')
    expect(outcome.action).toBe('drop')
    expect(h.controller.getState().workflow?.original).toBe('플러그인이 넣은 초안')
  })

  test('an emptied plugin fill starts the draft over', () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '타이핑한 초안' })

    h.controller.onFill(true)
    expect(h.controller.submissionFacts('타이핑한 초안')).toEqual({ pasted: true, reason: 'no-input-events' })

    h.controller.onFill(false)
    expect(h.controller.submissionFacts('타이핑한 초안')).toEqual({ pasted: false, reason: 'observed-other' })
  })

  test('a paste while a composer dialogue is reviewing is still a reply', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('첫 원문'), 'composer')
    await h.flush()
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')

    h.controller.observeEditInput({ inputText: '도중에 붙여넣은 보완 내용' })
    const outcome = await h.controller.onSubmit(h.ports, submit('도중에 붙여넣은 보완 내용'), 'composer')

    expect(outcome).toEqual({ action: 'drop', reason: '보완 요청을 옵티마이저에 전달했습니다.' })
    expect(h.controller.getState().workflow?.original).toBe('첫 원문')
  })

  test('a restored draft’s bypass ticket still outranks a paste fact', async () => {
    const original = '처음 작성한 원문 요청'
    const h = harness({ box: original })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit(original), 'pane')
    await h.flush()
    await h.controller.cancel(h.ports)
    expect(h.controller.getState().bypass?.text).toBe(original)

    h.controller.observeEditInput({ inputText: '전혀 다른 붙여넣기 내용' })
    expect(await h.controller.onSubmit(h.ports, submit(original), 'pane')).toEqual({
      action: 'next',
      text: original,
    })
    // The ticket, not rule 12, was the reason: a pass never consumes it.
    expect(h.controller.getState().bypass).toBeNull()
    expect(h.calls.complete).toBe(1)
  })

  test('onSessionEnd starts the next draft over', () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '타이핑한 초안' })
    expect(h.controller.submissionFacts('타이핑한 초안')).toEqual({ pasted: false, reason: 'typed' })

    h.controller.onSessionEnd()
    expect(h.controller.submissionFacts('타이핑한 초안')).toEqual({ pasted: true, reason: 'no-input-events' })
  })
})

describe('composition — a recalled prompt keeps its verdict', () => {
  test('a recalled typed prompt is still optimized', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })

    expect((await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')).action).toBe('drop')

    // ↑ recall re-submits the same text with no edit or autocomplete event; the
    // remembered typed verdict keeps it optimizable.
    h.controller.onSessionStart('sess-2')
    expect(await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')).toEqual({
      action: 'drop',
      reason: '프롬프트를 다듬는 중입니다.',
    })
    expect(h.controller.getState().workflow?.original).toBe('직접 쓴 프롬프트')
  })

  test('a recalled pasted prompt passes through again', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '붙여넣기만 한 프롬프트' })

    expect(await h.controller.onSubmit(h.ports, submit('붙여넣기만 한 프롬프트'), 'pane')).toEqual({
      action: 'next',
      text: '붙여넣기만 한 프롬프트',
    })

    expect(await h.controller.onSubmit(h.ports, submit('붙여넣기만 한 프롬프트'), 'pane')).toEqual({
      action: 'next',
      text: '붙여넣기만 한 프롬프트',
    })
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.calls.complete).toBe(0)
  })

  test('an observed edit still follows the composition over the memory', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '관찰이 기억보다 먼저다' })
    await h.controller.onSubmit(h.ports, submit('관찰이 기억보다 먼저다'), 'pane')

    // The same text was remembered as typed, but this draft was pasted: the
    // observed composition wins over the memory.
    h.controller.onSessionStart('sess-2')
    h.controller.observeEditInput({ inputText: '관찰이 기억보다 먼저다' })
    expect(h.controller.submissionFacts('관찰이 기억보다 먼저다')).toEqual({
      pasted: true,
      reason: 'keyless-long-insert',
    })

    // And the reverse: a text remembered as pasted is typed over, so it is
    // optimizable even though the memory says otherwise.
    h.controller.onSessionStart('sess-3')
    h.controller.observeEditInput({ inputText: '붙여넣었다가 고친 원문' })
    await h.controller.onSubmit(h.ports, submit('붙여넣었다가 고친 원문'), 'pane')
    h.controller.onSessionStart('sess-4')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '붙여넣었다가 고친 원문' })
    expect(h.controller.submissionFacts('붙여넣었다가 고친 원문')).toEqual({ pasted: false, reason: 'typed' })
  })

  test('a text this session never saw with no event is still pasted', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')

    expect(h.controller.submissionFacts('한 번도 보내지 않은 원문')).toEqual({
      pasted: true,
      reason: 'no-input-events',
    })
    expect(await h.controller.onSubmit(h.ports, submit('한 번도 보내지 않은 원문'), 'pane')).toEqual({
      action: 'next',
      text: '한 번도 보내지 않은 원문',
    })
  })

  test('the hundred most recent texts are kept, oldest dropped', async () => {
    const h = harness({ simulateTyping: false, config: { enabled: false } })
    h.controller.onSessionStart('sess-1')
    for (let i = 1; i <= 101; i += 1) {
      const text = `타이핑한 초안 ${i}`
      h.controller.observeEditInput({ key: { key: 'a' }, inputText: text })
      await h.controller.onSubmit(h.ports, submit(text), 'pane')
    }

    expect(h.controller.submissionFacts('타이핑한 초안 101')).toEqual({
      pasted: false,
      reason: 'history',
      previousReason: 'typed',
    })
    // The oldest entry fell out, so its no-event draft is pasted again.
    expect(h.controller.submissionFacts('타이핑한 초안 1')).toEqual({ pasted: true, reason: 'no-input-events' })
  })

  test('a recalled verdict keeps its pasted judgment and its base reason', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    h.controller.observeEditInput({ inputText: '붙여넣기만 한 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('붙여넣기만 한 프롬프트'), 'pane')

    h.controller.onSessionStart('sess-2')
    expect(h.controller.submissionFacts('직접 쓴 프롬프트')).toEqual({
      pasted: false,
      reason: 'history',
      previousReason: 'typed',
    })
    expect(h.controller.submissionFacts('붙여넣기만 한 프롬프트')).toEqual({
      pasted: true,
      reason: 'history',
      previousReason: 'keyless-long-insert',
    })
  })

  test('the recall memory is keyed by the trimmed text', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '  여백 있는 초안  ' })
    await h.controller.onSubmit(h.ports, submit('  여백 있는 초안  '), 'pane')

    h.controller.onSessionStart('sess-2')
    expect(h.controller.submissionFacts('여백 있는 초안')).toEqual({
      pasted: false,
      reason: 'history',
      previousReason: 'typed',
    })
  })

  test('repeated recalls never nest the history reason', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')

    // First recall: history over the typed base. Submitting it again must
    // remember the flattened base, not the history verdict itself.
    h.controller.onSessionStart('sess-2')
    expect(h.controller.submissionFacts('직접 쓴 프롬프트')).toEqual({
      pasted: false,
      reason: 'history',
      previousReason: 'typed',
    })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')

    h.controller.onSessionStart('sess-3')
    expect(h.controller.submissionFacts('직접 쓴 프롬프트')).toEqual({
      pasted: false,
      reason: 'history',
      previousReason: 'typed',
    })
  })
})

describe('the last-submission diagnostic for /optimize status', () => {
  test('a typed optimize submission records its trigger and composition', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')

    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'optimize',
      trigger: 'auto',
      composition: { pasted: false, reason: 'typed' },
    })
  })

  test('a no-event submission records the pasted pass with its reason', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('이벤트 없이 도착한 원문'), 'pane')

    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'pass',
      passReason: 'pasted',
      composition: { pasted: true, reason: 'no-input-events' },
    })
  })

  test('a paste with bypass off records an optimize decision, not a pass', async () => {
    const h = harness({ simulateTyping: false, config: { pasteBypass: false } })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '붙여넣은 여러 줄 텍스트' })
    await h.controller.onSubmit(h.ports, submit('붙여넣은 여러 줄 텍스트'), 'pane')

    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'optimize',
      trigger: 'auto',
      composition: { pasted: true, reason: 'keyless-long-insert' },
    })
  })

  test('a reply over a pasted draft records the reply decision', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('첫 원문'), 'composer')
    await h.flush()
    h.controller.observeEditInput({ inputText: '도중에 붙여넣은 보완 내용' })
    await h.controller.onSubmit(h.ports, submit('도중에 붙여넣은 보완 내용'), 'composer')

    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'reply',
      composition: { pasted: true, reason: 'keyless-long-insert' },
    })
  })

  test('a restored draft submitted over its ticket records the bypass decision', async () => {
    const original = '처음 작성한 원문 요청'
    const h = harness({ box: original })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit(original), 'pane')
    await h.flush()
    await h.controller.cancel(h.ports)

    await h.controller.onSubmit(h.ports, submit(original), 'pane')
    expect(h.controller.getSubmissionStatus()?.kind).toBe('bypass')
  })

  test('a raw-mode submission records the raw decision', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '타이핑한 초안' })
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))
    await h.controller.onSubmit(h.ports, submit('타이핑한 초안'), 'pane')

    expect(h.controller.getSubmissionStatus()?.kind).toBe('raw')
  })

  test('a slash or shell submission never replaces the diagnostic', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    const before = h.controller.getSubmissionStatus()

    await h.controller.onSubmit(h.ports, submit('/optimize status'), 'pane')
    await h.controller.onSubmit(h.ports, submit('!ls'), 'pane')
    expect(h.controller.getSubmissionStatus()).toBe(before)
  })

  test('a non-composer origin never replaces the diagnostic', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    const before = h.controller.getSubmissionStatus()

    await h.controller.onSubmit(h.ports, submit('외부에서 온 제출', { origin: { kind: 'sdk' } }), 'pane')
    expect(h.controller.getSubmissionStatus()).toBe(before)
  })

  test('the diagnostic never carries the submission text', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '고유한비밀원문내용12345' })
    await h.controller.onSubmit(h.ports, submit('고유한비밀원문내용12345'), 'pane')

    const status = h.controller.getSubmissionStatus()
    expect(status).not.toBeNull()
    expect(JSON.stringify(status)).not.toContain('고유한비밀원문내용')
  })

  test('reading the diagnostic has no side effects', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')

    const first = h.controller.getSubmissionStatus()
    const second = h.controller.getSubmissionStatus()
    expect(second).toBe(first)
    // The composition is not consumed by the reads: the next no-event text is
    // still classified from the live draft, unchanged by the getter.
    expect(h.controller.submissionFacts('다른 초안')).toEqual({ pasted: true, reason: 'no-input-events' })
  })

  test('a session start clears the diagnostic but keeps the recall memory', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '붙여넣은 여러 줄 텍스트' })
    await h.controller.onSubmit(h.ports, submit('붙여넣은 여러 줄 텍스트'), 'pane')
    expect(h.controller.getSubmissionStatus()).not.toBeNull()

    h.controller.onSessionStart('sess-2')
    expect(h.controller.getSubmissionStatus()).toBeNull()
    expect(h.controller.submissionFacts('붙여넣은 여러 줄 텍스트')).toEqual({
      pasted: true,
      reason: 'history',
      previousReason: 'keyless-long-insert',
    })
  })

  test('a fresh controller has neither diagnostic nor recall memory', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')

    const fresh = harness({ simulateTyping: false })
    fresh.controller.onSessionStart('sess-1')
    expect(fresh.controller.getSubmissionStatus()).toBeNull()
    expect(fresh.controller.submissionFacts('직접 쓴 프롬프트')).toEqual({
      pasted: true,
      reason: 'no-input-events',
    })
  })

  test('a classification failure clears the diagnostic but keeps the recall memory', async () => {
    let fail = false
    const h = harness({
      simulateTyping: false,
      deps: {
        getConfig: () => {
          if (fail) throw new Error('config unreadable')
          return { ...DEFAULT_CONFIG }
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'optimize',
      trigger: 'auto',
      composition: { pasted: false, reason: 'typed' },
    })

    // The next classification throws: the diagnostic must fall back to null
    // instead of keeping the previous submission's verdict, while the
    // person's text still passes through unchanged.
    fail = true
    h.controller.observeEditInput({ inputText: '분류가 실패한 원문' })
    const outcome = await h.controller.onSubmit(h.ports, submit('분류가 실패한 원문'), 'pane')
    expect(outcome).toEqual({ action: 'next', text: '분류가 실패한 원문' })
    expect(h.controller.getSubmissionStatus()).toBeNull()

    // The verdict was remembered before the failure, so a later recall of the
    // same text still reuses it.
    h.controller.onSessionStart('sess-2')
    expect(h.controller.submissionFacts('분류가 실패한 원문')).toEqual({
      pasted: true,
      reason: 'history',
      previousReason: 'keyless-long-insert',
    })
  })

  test('a non-composer classification failure never clears the diagnostic', async () => {
    let fail = false
    const h = harness({
      simulateTyping: false,
      deps: {
        getConfig: () => {
          if (fail) throw new Error('config unreadable')
          return { ...DEFAULT_CONFIG }
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    const before = h.controller.getSubmissionStatus()
    expect(before).not.toBeNull()

    // A submission of another origin was never recorded, so its failure must
    // not wipe the composer diagnostic either.
    fail = true
    const outcome = await h.controller.onSubmit(h.ports, submit('외부에서 온 제출', { origin: { kind: 'sdk' } }), 'pane')
    expect(outcome).toEqual({ action: 'next', text: '외부에서 온 제출' })
    expect(h.controller.getSubmissionStatus()).toBe(before)
  })

  test('a recalled submission records the history reason with its base verdict', async () => {
    const h = harness({ simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '직접 쓴 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    h.controller.observeEditInput({ inputText: '붙여넣기만 한 프롬프트' })
    await h.controller.onSubmit(h.ports, submit('붙여넣기만 한 프롬프트'), 'pane')

    // A ↑ recall has no events of its own; the diagnostic shows the history
    // reason together with the verdict the text got when it was first sent.
    h.controller.onSessionStart('sess-2')
    await h.controller.onSubmit(h.ports, submit('직접 쓴 프롬프트'), 'pane')
    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'optimize',
      trigger: 'auto',
      composition: { pasted: false, reason: 'history', previousReason: 'typed' },
    })

    h.controller.onSessionStart('sess-3')
    await h.controller.onSubmit(h.ports, submit('붙여넣기만 한 프롬프트'), 'pane')
    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'pass',
      passReason: 'pasted',
      composition: { pasted: true, reason: 'history', previousReason: 'keyless-long-insert' },
    })
  })
})

describe('smart trigger — the opt-in approval pass-through', () => {
  test('an observed typed approval submits the exact original and schedules nothing', async () => {
    const h = harness({ config: { triggerMode: 'smart' }, simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '  응  ' })

    const outcome = await h.controller.onSubmit(h.ports, submit('  응  '), 'pane')

    expect(outcome).toEqual({ action: 'next', text: '  응  ' })
    expect(h.controller.getState().workflow).toBeNull()
    await h.flush()
    expect(h.calls.complete).toBe(0)
    expect(h.calls.submit).toBe(0)
    expect(h.calls.promptRead).toBe(0)
    // The diagnostic keeps the smart verdict with the typed input source.
    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'pass',
      passReason: 'smart-continuation',
      composition: { pasted: false, reason: 'typed' },
    })
  })

  test('the same approval as an active dialogue answer refines that workflow', async () => {
    const h = harness({ config: { triggerMode: 'smart' } })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('첫 원문'), 'composer')
    await h.flush()
    expect(h.controller.getState().workflow?.rounds).toBe(1)

    const outcome = await h.controller.onSubmit(h.ports, submit('응'), 'composer')

    expect(outcome).toEqual({ action: 'drop', reason: '보완 요청을 옵티마이저에 전달했습니다.' })
    await h.flush()
    expect(h.calls.complete).toBe(2)
    expect(h.controller.getState().workflow?.dialogue.at(-2)).toEqual({ role: 'user', text: '응', decisionId: 'd1' })
  })

  test('a recalled typed approval passes through again under smart mode', async () => {
    const h = harness({ config: { triggerMode: 'smart' }, simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '계속' })
    await h.controller.onSubmit(h.ports, submit('계속'), 'pane')

    // ↑ recall re-submits the same text with no event; the remembered typed
    // verdict feeds the same smart pass.
    h.controller.onSessionStart('sess-2')
    expect(await h.controller.onSubmit(h.ports, submit('계속'), 'pane')).toEqual({
      action: 'next',
      text: '계속',
    })
    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'pass',
      passReason: 'smart-continuation',
      composition: { pasted: false, reason: 'history', previousReason: 'typed' },
    })
  })

  test('an explicit /optimize start is not smart-filtered', async () => {
    const h = harness({ config: { triggerMode: 'smart' } })
    h.controller.onSessionStart('sess-1')

    await h.controller.startExplicit(h.ports, '응', 'pane')
    await h.flush()

    expect(h.controller.getState().workflow?.original).toBe('응')
    expect(h.calls.complete).toBe(1)
  })

  test('the smart prefix starts despite a pasted classification', async () => {
    const h = harness({ config: { triggerMode: 'smart' }, simulateTyping: false })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ inputText: '?? 운영 DB 스키마를 정리해줘' })

    const outcome = await h.controller.onSubmit(h.ports, submit('?? 운영 DB 스키마를 정리해줘'), 'pane')

    expect(outcome).toEqual({ action: 'drop', reason: '프롬프트를 다듬는 중입니다.' })
    await h.flush()
    expect(h.calls.complete).toBe(1)
    expect(h.controller.getState().workflow?.original).toBe('운영 DB 스키마를 정리해줘')
    expect(h.controller.getSubmissionStatus()).toEqual({
      kind: 'optimize',
      trigger: 'prefix',
      composition: { pasted: true, reason: 'keyless-long-insert' },
    })
  })

  test('unknown, negative and mixed-approval texts still optimize', async () => {
    const h = harness({ config: { triggerMode: 'smart' } })
    h.controller.onSessionStart('sess-1')

    for (const text of ['운영 DB 삭제해', '아니', '응, 대신 DB 구조도 바꿔줘']) {
      expect(await h.controller.onSubmit(h.ports, submit(text), 'pane')).toEqual({
        action: 'drop',
        reason: '프롬프트를 다듬는 중입니다.',
      })
      await h.flush()
      expect(h.calls.complete).toBe(1)
      expect(h.controller.getState().workflow?.original).toBe(text)
      await h.controller.cancel(h.ports)
      h.calls.complete = 0
    }
  })

  test('a classification failure under smart mode still passes the exact original', async () => {
    const h = harness({
      config: { triggerMode: 'smart' },
      simulateTyping: false,
      deps: {
        getConfig: () => {
          throw new Error('config unreadable')
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    h.controller.observeEditInput({ key: { key: 'a' }, inputText: '응' })

    expect(await h.controller.onSubmit(h.ports, submit('응'), 'pane')).toEqual({
      action: 'next',
      text: '응',
    })
    expect(h.calls.complete).toBe(0)
    expect(h.controller.getSubmissionStatus()).toBeNull()
  })
})

describe('clearRawMode and startExplicit', () => {
  test('clearRawMode drops an armed mode and is a no-op otherwise', () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    h.controller.clearRawMode()
    expect(h.controller.getState().rawMode).toBeNull()

    h.controller.clearRawMode()
    expect(h.controller.getState().rawMode).toBeNull()
  })

  test('startExplicit clears an armed mode', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    h.controller.onComposerEdit(edit({ inputText: '>> ' }))

    await h.controller.startExplicit(h.ports, '원문', 'pane')

    expect(h.controller.getState().rawMode).toBeNull()
    expect(h.controller.getState().workflow?.original).toBe('원문')
  })
})

describe('refine — the improvement dialogue', () => {
  test('carries the image baseline question and answer into a standalone requirements draft', async () => {
    const original = '노드별 현재 property와 기존 image의 diff API, 내부 swagger와 MCP를 추가해줘'
    const firstDraft = '목표: 노드별 property와 image diff를 API·문서·MCP에 제공. 미결정: 비교 기준.'
    const question = '기존 image는 1) 변화 이력의 직전 값 2) 배포 기준 중 무엇인가요?'
    const finalDraft = '목표: 노드별 property와 image diff 제공. 합의: 변화 이력의 직전 값과 비교. 완료 기준: API·문서·MCP 응답 일치. 미결정: 이력 없음 처리.'
    const h = harness({ complete: async (_request, _signal, call) => call === 1
      ? answered(firstDraft, '비교 기준을 구체화합니다.', question)
      : answered(finalDraft, '직전 이력 기준을 반영했습니다.') })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit(original), 'composer')
    await h.flush()
    await h.controller.refine(h.ports, '1번')

    expect(h.completes[1]?.prompt).toContain(question)
    expect(h.completes[1]?.prompt).toContain('user: 1번')
    expect(h.completes[1]?.prompt).toContain(firstDraft)
    expect(h.controller.getState().workflow?.draft).toBe(finalDraft)
    expect(h.calls.submit).toBe(0)
    expect(h.calls.fork).toBe(0)
  })

  test('keeps a last-round question as an open decision until more rounds are approved', async () => {
    const h = harness({
      config: { maxRounds: 1 },
      complete: async () => answered('노드 image diff API를 추가해주세요.', '초안 작성', '비교 기준은 무엇인가요?'),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('image diff API 추가'), 'composer')
    await h.flush()

    expect(h.completes[0]?.prompt).toContain('remaining: 0')
    expect(h.controller.getState().workflow?.draft).toContain('미확정 사항 (구현 전 확인):\n비교 기준은 무엇인가요?')
    expect(h.controller.getState().workflow?.question).toBe('비교 기준은 무엇인가요?')
    await h.controller.refine(h.ports, '직전 이력')
    await h.controller.retry(h.ports, '배포 기준')
    expect(h.calls.complete).toBe(1)
    expect(h.calls.submit).toBe(0)
    expect(h.controller.getState().workflow?.question).toBe('비교 기준은 무엇인가요?')
  })

  test('notifies a question with its choice count', async () => {
    const h = harness({
      complete: async () => answered('초안 요청', '요약', '어느 쪽인가요?', ['1번', '2번']),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'composer')
    await h.flush()

    expect(h.notices).toContain('질문: 어느 쪽인가요? (선택지 2개)')
    expect(h.controller.getState().workflow?.options).toEqual(['1번', '2번'])
  })

  test('folds a last-round question into the draft while keeping its choices for an approved extension', async () => {
    const h = harness({
      config: { maxRounds: 1 },
      complete: async () => answered('초안 요청', '초안 작성', '어느 쪽인가요?', ['1번', '2번']),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'composer')
    await h.flush()

    const workflow = h.controller.getState().workflow
    expect(workflow?.draft).toContain('미확정 사항 (구현 전 확인):\n어느 쪽인가요?\n- 선택지: 1번 / 2번')
    expect(workflow?.question).toBe('어느 쪽인가요?')
    expect(workflow?.options).toEqual(['1번', '2번'])
  })

  test('collects context once and completes once per round, keeping the transcript intact', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.refine(h.ports, '더 짧게')
    await h.controller.refine(h.ports, '한국어를 유지해')

    expect(h.calls.messages).toBe(1)
    expect(h.calls.complete).toBe(3)
    expect(h.calls.fork).toBe(0)
    expect(h.calls.submit).toBe(0)

    const workflow = h.controller.getState().workflow
    expect(workflow?.rounds).toBe(3)
    expect(workflow?.dialogue.filter(message => message.role === 'user')).toHaveLength(2)
    expect(workflow?.dialogue.filter(message => message.role === 'optimizer')).toHaveLength(3)
  })

  test('stops at maxRounds without another completion', async () => {
    const h = harness({ config: { maxRounds: 1 } })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    expect(h.calls.complete).toBe(1)

    await h.controller.refine(h.ports, '더')

    expect(h.calls.complete).toBe(1)
    expect(h.notices).toContain('개선 횟수 한도에 도달했습니다')
  })

  test('does not duplicate a refinement instruction in <instruction>', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.refine(h.ports, '더 짧게')

    const refined = requestText(h.completes.at(-1)?.prompt)
    // The supplement is rendered in the decision evidence and the dialogue;
    // the request must not also repeat it in an `<instruction>` section.
    expect(refined.split('더 짧게')).toHaveLength(3)
    expect(refined).not.toContain('<instruction>')

    await h.controller.retry(h.ports, '조금 더')

    const retried = requestText(h.completes.at(-1)?.prompt)
    expect(retried.split('조금 더')).toHaveLength(3)
    expect(retried).not.toContain('<instruction>')
  })

  test('reports a failed system prompt read once per run', async () => {
    const h = harness({ config: { systemPromptFile: '/missing/prompt.md' } })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const warned = (): Array<string | undefined> =>
      h.notices.filter(notice => notice?.includes('시스템 프롬프트 파일을 읽지 못해'))
    expect(warned()).toHaveLength(1)
    expect(warned()[0]).toContain('/missing/prompt.md')

    // The prompt is cached for the run, so a later round does not warn again.
    await h.controller.refine(h.ports, '더 짧게')
    expect(warned()).toHaveLength(1)
  })

  test('reports a truncated system prompt file as guidance, not a fallback', async () => {
    const h = harness({
      config: { systemPromptFile: '/long/prompt.md' },
      files: { '/long/prompt.md': 'x'.repeat(4001) },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    // The file was read (only its tail dropped), so this must not claim the
    // built-in prompt was used.
    const guidance = h.notices.filter(notice => notice?.includes('시스템 프롬프트 파일 안내'))
    expect(guidance).toHaveLength(1)
    expect(guidance[0]).toContain('/long/prompt.md')
    expect(h.notices.some(notice => notice?.includes('읽지 못해 기본 프롬프트를 사용합니다'))).toBe(
      false,
    )
  })

  test('a bare retry does not repeat the last supplement in <instruction>', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.refine(h.ports, '더 짧게')
    await h.controller.retry(h.ports)

    // The supplement is already in the decision evidence and the dialogue; a
    // bare retry must not also re-render it as the `<instruction>` section.
    const retried = requestText(h.completes.at(-1)?.prompt)
    expect(retried.split('더 짧게')).toHaveLength(3)
    expect(retried).not.toContain('<instruction>')
  })
})


describe('preflight request budget', () => {
  test('a first refusal keeps the run, spends nothing and never restores the original', async () => {
    const h = harness()
    const timers = progressClock(h)
    h.controller.onSessionStart('sess-1')
    const original = 'O'.repeat(17500)
    await h.controller.startExplicit(h.ports, original, 'pane')
    await h.flush()

    expect(h.calls.complete).toBe(0)
    expect(h.calls.fork).toBe(0)
    const state = h.controller.getState()
    expect(state.usage.calls).toBe(0)
    expect(state.workflow?.rounds).toBe(0)
    expect(state.workflow?.phase).toBe('failed')
    expect(state.workflow?.lastError).toBe(REQUEST_BUDGET_NOTICE)
    expect(state.workflow?.budgetError?.limitChars).toBe(MAX_REQUEST_CHARS)
    expect(state.workflow?.budgetError?.requiredChars).toBeGreaterThan(MAX_REQUEST_CHARS)
    expect(state.workflow?.decisions?.entries).toHaveLength(0)
    expect(h.notices).toContain(REQUEST_BUDGET_NOTICE)
    // The first-failure restore path did not run.
    expect(h.fills).toHaveLength(0)
    expect(timers.every(timer => timer.cancelled)).toBe(true)

    // Retrying the unchanged protected content refuses again, still at no cost.
    await h.controller.retry(h.ports)
    expect(h.calls.complete).toBe(0)
    expect(h.controller.getState().workflow?.rounds).toBe(0)

    // Cancel stays available and restores the original through the normal path.
    const cancelled = await h.controller.cancel(h.ports)
    expect(cancelled.ok).toBe(true)
    expect(h.fills.at(-1)?.text).toBe(original)
  })

  test('a later refusal keeps the draft, counters and guidance and leaves accept available', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    const before = h.controller.getState()
    const guidance = h.controller.getGuidanceStatus()
    const timers = progressClock(h)

    const huge = 'X'.repeat(17000)
    await h.controller.refine(h.ports, huge)
    const after = h.controller.getState()

    expect(h.calls.complete).toBe(1)
    expect(h.calls.fork).toBe(0)
    expect(after.usage).toEqual(before.usage)
    expect(after.workflow?.usage).toEqual(before.workflow?.usage)
    expect(after.workflow?.rounds).toBe(before.workflow?.rounds)
    expect(after.workflow?.roundLimit).toBe(before.workflow?.roundLimit)
    expect(after.workflow?.draft).toBe(before.workflow?.draft)
    expect(after.workflow?.phase).toBe('failed')
    expect(after.workflow?.decisions?.entries).toHaveLength(1)
    expect(after.workflow?.decisions?.entries[0]?.text).toBe(huge)
    expect(after.workflow?.budgetError?.decisionIds).toEqual(['d1'])
    expect(h.controller.getGuidanceStatus()).toBe(guidance)
    expect(h.notices).toContain(REQUEST_BUDGET_NOTICE)
    expect(h.fills).toHaveLength(0)
    expect(timers.every(timer => timer.cancelled)).toBe(true)

    const accepted = await h.controller.accept(h.ports)
    expect(accepted.ok).toBe(true)
    expect(h.fills.at(-1)?.text).toBe(before.workflow?.draft)
  })

  test('a budget refusal still allows the oversized decision to be corrected, and retry applies it', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, 'X'.repeat(17000))
    expect(h.controller.getState().workflow?.phase).toBe('failed')
    expect(h.controller.getState().workflow?.budgetError?.decisionIds).toEqual(['d1'])
    const before = h.calls.complete

    const corrected = h.controller.correctDecision('d1', '짧은 결정')
    expect(corrected).toEqual({ ok: true })
    expect(h.calls.complete).toBe(before)
    expect(h.controller.getState().workflow?.decisions?.entries.map(entry => entry.id)).toEqual(['d1', 'd2'])

    await h.controller.retry(h.ports)
    expect(h.calls.complete).toBe(before + 1)
    const prompt = requestText(h.completes.at(-1)?.prompt)
    expect(prompt).toContain('짧은 결정')
    expect(prompt).not.toContain('X'.repeat(1000))
  })
})

describe('failure handling', () => {
  test('restores the original and permits one bypass when the first round fails', async () => {
    const h = harness({ complete: async () => apiError() })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')

    await h.flush()

    expect(h.calls.fill).toBe(1)
    expect(h.fills[0]?.text).toBe('원문 요청')
    const state = h.controller.getState()
    expect(state.workflow).toBeNull()
    expect(state.bypass?.text).toBe('원문 요청')
  })

  test('keeps the last draft when a later round fails', async () => {
    let call = 0
    const h = harness({
      complete: async () => {
        call += 1
        return call === 1 ? answered('첫 초안') : apiError()
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.refine(h.ports, '보완')

    const workflow = h.controller.getState().workflow
    expect(workflow?.phase).toBe('failed')
    expect(workflow?.draft).toBe('첫 초안')
    expect(h.calls.fill).toBe(0)
  })

  test('re-runs a failed round on retry', async () => {
    let call = 0
    const h = harness({
      complete: async () => {
        call += 1
        if (call === 2) return apiError()
        return answered(`초안${call}`)
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, '보완')
    expect(h.controller.getState().workflow?.phase).toBe('failed')

    await h.controller.retry(h.ports)

    expect(h.calls.complete).toBe(3)
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
    expect(h.controller.getState().workflow?.draft).toBe('초안3')
  })
})

describe('accept and send', () => {
  test('accept fills once, permits a bypass, and consumes it on resubmit', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.accept(h.ports)

    expect(h.calls.fill).toBe(1)
    expect(h.closes).toContain(PANE_ID)
    const afterAccept = h.controller.getState()
    expect(afterAccept.workflow).toBeNull()
    expect(afterAccept.bypass?.text).toBe('개선된 요청')

    const asIs = await h.controller.onSubmit(h.ports, submit('개선된 요청'), 'pane')
    expect(asIs).toEqual({ action: 'next', text: '개선된 요청' })
    expect(h.controller.getState().bypass).toBeNull()

    const changed = await h.controller.onSubmit(h.ports, submit('다른 요청'), 'pane')
    expect(changed.action).toBe('drop')
    expect(h.controller.getState().workflow?.original).toBe('다른 요청')
  })

  test('accept double-press fills only once', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await Promise.all([h.controller.accept(h.ports), h.controller.accept(h.ports)])

    expect(h.calls.fill).toBe(1)
  })

  test('accept follows the edited draft and revokes on an emptied box', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.accept(h.ports)

    h.controller.onPromptEdit('개선된 요청을 고침')
    expect(h.controller.getState().bypass?.text).toBe('개선된 요청을 고침')

    h.controller.onPromptEdit('   ')
    expect(h.controller.getState().bypass).toBeNull()
  })

  test('accept refuses to overwrite the person’s own text', async () => {
    const h = harness({ box: '내가 새로 쓴 내용' })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.accept(h.ports)

    expect(h.calls.fill).toBe(0)
    const state = h.controller.getState()
    expect(state.workflow?.phase).toBe('reviewing')
    expect(state.bypass).toBeNull()
    expect(h.notices).toContain('입력창에 새로 작성한 내용이 있어 덮어쓰지 않았습니다')
  })

  test('sendDraft submits once and dismisses the run', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.sendDraft(h.ports)

    expect(h.calls.submit).toBe(1)
    expect(h.submits[0]?.text).toBe('개선된 요청')
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('sendDraft double-press submits only once', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await Promise.all([h.controller.sendDraft(h.ports), h.controller.sendDraft(h.ports)])

    expect(h.calls.submit).toBe(1)
  })

  test('sendOriginal submits the stored original', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.sendOriginal(h.ports)

    expect(h.submits[0]?.text).toBe('원문')
  })

  test('sendDraft sends when the captured workflow id still matches', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    const id = h.controller.getState().workflow?.id
    expect(id).toBeDefined()

    const result = await h.controller.sendDraft(h.ports, id)

    expect(result).toEqual({ ok: true })
    expect(h.calls.submit).toBe(1)
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('sendDraft refuses a run that replaced the captured workflow id', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const result = await h.controller.sendDraft(h.ports, 'wf-stale')

    expect(result).toEqual({ ok: false, reason: '개선 작업이 바뀌어 전송하지 않았습니다.' })
    expect(h.calls.submit).toBe(0)
    expect(h.notices.filter(n => n === '개선 작업이 바뀌어 전송하지 않았습니다.')).toHaveLength(1)
    // The current run is untouched, so the person can still act on it.
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
  })

  test('sendOriginal refuses a replaced workflow id too', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const result = await h.controller.sendOriginal(h.ports, 'wf-stale')

    expect(result).toEqual({ ok: false, reason: '개선 작업이 바뀌어 전송하지 않았습니다.' })
    expect(h.calls.submit).toBe(0)
  })

  test('sendDraft without a workflow id keeps the previous behavior', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(await h.controller.sendDraft(h.ports)).toEqual({ ok: true })
    expect(h.calls.submit).toBe(1)
  })

  test('a dropped send returns to review with a notice', async () => {
    const h = harness({ submit: () => ({ drop: 'blocked' }) })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.sendDraft(h.ports)

    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
    expect(h.notices).toContain('전송이 차단되었습니다: blocked')
  })
})

describe('cancel', () => {
  test('restores the saved original after clearing the consumed composer and bypasses exactly once', async () => {
    const original = '처음 작성한 원문 요청'
    const h = harness({ box: original })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit(original), 'pane')
    await h.flush()
    expect(h.fills.map(fill => fill.text)).toEqual([''])
    expect((await h.ports.prompt.read()).text).toBe('')
    expect(h.controller.getState().workflow?.original).toBe(original)

    expect(await h.controller.cancel(h.ports)).toEqual({ ok: true })
    expect((await h.ports.prompt.read()).text).toBe(original)
    expect(h.fills.map(fill => fill.text)).toEqual(['', original])
    expect(h.controller.getState().workflow).toBeNull()
    expect(await h.controller.onSubmit(h.ports, submit(original), 'pane')).toEqual({ action: 'next', text: original })
    expect((await h.controller.onSubmit(h.ports, submit(original), 'pane')).action).toBe('drop')
    expect(h.calls.complete).toBe(1)
    expect(h.calls.submit).toBe(0)
  })

  test('restores the first original after the composer supplement has also been consumed and cleared', async () => {
    const original = '처음 작성한 원문 요청'
    const supplement = '이 보완 내용도 반영해줘'
    let box = original
    const h = harness({ fill: input => {
      box = input.text
      return { isFilled: true, text: box, cursor: box.length }
    } })
    h.ports.prompt.read = async () => ({ text: box, cursor: box.length })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit(original), 'composer')
    await h.flush()
    box = supplement
    await h.controller.onSubmit(h.ports, submit(supplement), 'composer')
    await h.flush()
    expect(box).toBe('')
    expect(h.controller.getState().workflow?.original).toBe(original)
    expect(h.controller.getState().workflow?.dialogue.some(m => m.text === supplement)).toBe(true)

    expect(await h.controller.cancel(h.ports)).toEqual({ ok: true })
    expect(box).toBe(original)
    expect(h.fills.map(fill => fill.text)).toEqual(['', '', original])
    expect(h.controller.getState().bypass?.text).toBe(original)
    expect(h.calls.complete).toBe(2)
    expect(h.calls.submit).toBe(0)
  })

  for (const timing of ['before', 'after'] as const) {
    test(`restores the saved expanded original when a paste placeholder returns ${timing} the clear timer`, async () => {
      const placeholder = '[Pasted text #1 +3 lines]'
      const original = '<pasted_content>\n첫 번째 원문 줄\n두 번째 원문 줄\n세 번째 원문 줄\n</pasted_content>'
      let box = ''
      const h = harness({ fill: input => {
        box = input.text
        return { isFilled: true, text: box, cursor: box.length }
      } })
      h.ports.prompt.read = async () => ({ text: box, cursor: box.length })
      h.controller.onSessionStart('sess-1')
      h.controller.observeComposer(placeholder)
      await h.controller.onSubmit(h.ports, submit(original), 'pane')
      if (timing === 'before') box = placeholder
      await h.flush()
      expect(box).toBe('')
      if (timing === 'after') box = placeholder

      expect(await h.controller.cancel(h.ports)).toEqual({ ok: true })
      expect(box).toBe(original)
      expect(h.fills.map(fill => fill.text)).toEqual(timing === 'before' ? ['', original] : [original])
      expect(h.controller.getState().bypass?.text).toBe(original)
      expect(h.calls.complete).toBe(1)
      expect(h.calls.submit).toBe(0)
    })
  }

  test('preserves a new composer draft when cancellation cannot safely restore the saved original', async () => {
    const original = '처음 작성한 원문 요청'
    const fresh = '별도로 새로 작성한 요청'
    let box = original
    const h = harness({ fill: input => {
      box = input.text
      return { isFilled: true, text: box, cursor: box.length }
    } })
    h.ports.prompt.read = async () => ({ text: box, cursor: box.length })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit(original), 'pane')
    await h.flush()
    box = fresh
    h.controller.onPromptEdit(fresh)

    const outcome = await h.controller.cancel(h.ports)
    expect(outcome.ok).toBe(false)
    expect(box).toBe(fresh)
    expect(h.fills.map(fill => fill.text)).toEqual([''])
    expect(h.controller.getState().bypass).toBeNull()
    expect(h.calls.complete).toBe(1)
    expect(h.calls.submit).toBe(0)
  })

  test('aborts the call, restores the original with a permit, and ignores the late reply', async () => {
    let resolveComplete: ((result: ModelCompleteResult) => void) | undefined
    const h = harness({
      complete: () =>
        new Promise<ModelCompleteResult>(resolve => {
          resolveComplete = resolve
        }),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')

    const queued = h.queue.shift()
    expect(queued).toBeDefined()
    const running = (queued as () => Promise<void>)()
    await h.waitFor(() => h.calls.complete === 1)
    expect(h.signals[0]?.aborted).toBe(false)

    await h.controller.cancel(h.ports)

    expect(h.signals[0]?.aborted).toBe(true)
    const afterCancel = h.controller.getState()
    expect(afterCancel.workflow).toBeNull()
    expect(afterCancel.bypass?.text).toBe('원문')

    resolveComplete?.(answered('늦은 응답'))
    await running

    const afterLate = h.controller.getState()
    expect(afterLate.workflow).toBeNull()
    expect(afterLate.bypass?.text).toBe('원문')
    expect(afterLate.usage.calls).toBe(1)
  })

  test('notices when nothing is running', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    await h.controller.cancel(h.ports)

    expect(h.notices).toContain('진행 중인 개선 작업이 없습니다.')
  })

  test('ignores cancel while the draft is being moved to the box', async () => {
    let releaseFill: (() => void) | undefined
    const h = harness({
      fill: input =>
        new Promise<PromptFilled>(resolve => {
          releaseFill = () =>
            resolve({ isFilled: true, text: input.text, cursor: input.text.length })
        }),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const accepting = h.controller.accept(h.ports)
    await h.waitFor(() => h.controller.getState().workflow?.phase === 'transferring')

    await h.controller.cancel(h.ports)

    expect(h.notices).toContain('입력창으로 옮기는 중이라 취소할 수 없습니다')
    expect(h.fills).toHaveLength(1)
    expect(h.controller.getState().workflow?.phase).toBe('transferring')

    releaseFill?.()
    await accepting

    expect(h.controller.getState().workflow).toBeNull()
    expect(h.fills).toHaveLength(1)
  })

  test('ignores cancel while a draft is being sent', async () => {
    let releaseSubmit: (() => void) | undefined
    const h = harness({
      submit: input =>
        new Promise<PromptSubmitResult>(resolve => {
          releaseSubmit = () => resolve({ text: input.text })
        }),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const sending = h.controller.sendDraft(h.ports)
    await h.waitFor(() => h.controller.getState().workflow?.phase === 'sending')

    await h.controller.cancel(h.ports)

    expect(h.notices).toContain('전송 중이라 취소할 수 없습니다')
    expect(h.submits).toHaveLength(1)

    releaseSubmit?.()
    await sending

    expect(h.controller.getState().workflow).toBeNull()
    expect(h.submits).toHaveLength(1)
  })
})

describe('action results', () => {
  test('cancel without a run reports the reason', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    expect(await h.controller.cancel(h.ports)).toEqual({
      ok: false,
      reason: '진행 중인 개선 작업이 없습니다.',
    })
  })

  test('a successful accept reports ok', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(await h.controller.accept(h.ports)).toEqual({ ok: true })
  })

  test('a refused accept carries the refusal line', async () => {
    const h = harness({ box: '내가 새로 쓴 내용' })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(await h.controller.accept(h.ports)).toEqual({
      ok: false,
      reason: '입력창에 새로 작성한 내용이 있어 덮어쓰지 않았습니다',
    })
  })

  test('a successful send reports ok', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(await h.controller.sendDraft(h.ports)).toEqual({ ok: true })
  })

  test('a dropped send carries the drop line', async () => {
    const h = harness({ submit: () => ({ drop: 'blocked' }) })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(await h.controller.sendDraft(h.ports)).toEqual({
      ok: false,
      reason: '전송이 차단되었습니다: blocked',
    })
  })

  test('a cancel refused mid-transfer reports the phase line', async () => {
    let releaseFill: (() => void) | undefined
    const h = harness({
      fill: input =>
        new Promise<PromptFilled>(resolve => {
          releaseFill = () => resolve({ isFilled: true, text: input.text, cursor: input.text.length })
        }),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const accepting = h.controller.accept(h.ports)
    await h.waitFor(() => h.controller.getState().workflow?.phase === 'transferring')

    expect(await h.controller.cancel(h.ports)).toEqual({
      ok: false,
      reason: '입력창으로 옮기는 중이라 취소할 수 없습니다',
    })

    releaseFill?.()
    await accepting
  })
})

describe('startExplicit and lifecycle', () => {
  test('improves the current draft when no text is given', async () => {
    const h = harness({ box: '창에 있던 초안' })
    h.controller.onSessionStart('sess-1')

    await h.controller.startExplicit(h.ports, undefined, 'pane')

    expect(h.calls.promptRead).toBe(1)
    await h.flush()
    const workflow = h.controller.getState().workflow
    expect(workflow?.original).toBe('창에 있던 초안')
    expect(workflow?.phase).toBe('reviewing')
  })

  test('says so while a run is already active', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('첫'), 'pane')

    await h.controller.startExplicit(h.ports, '둘째', 'pane')

    expect(h.notices).toContain('이미 개선 작업이 진행 중입니다.')
    expect(h.calls.complete).toBe(0)
    expect(h.controller.getState().workflow?.original).toBe('첫')
  })

  test('rolls a failed explicit start back and frees the next submission', async () => {
    const draft = '창에 있던 초안'
    const h = harness({
      box: draft,
      deps: {
        schedule: () => {
          throw new Error('clock unavailable')
        },
      },
    })
    h.controller.onSessionStart('sess-1')

    await h.controller.startExplicit(h.ports, '원문', 'pane')

    expect(h.controller.getState().workflow).toBeNull()
    expect(h.notices).toContain('개선을 시작하지 못했습니다: clock unavailable')
    expect(h.calls.complete).toBe(0)
    expect(h.calls.submit).toBe(0)
    expect(h.fills).toEqual([])
    expect(await h.ports.prompt.read()).toEqual({ text: draft, cursor: draft.length })
    const outcome = await h.controller.onSubmit(h.ports, submit('다음 요청'), 'composer')
    expect(outcome).toEqual({ action: 'next', text: '다음 요청' })
  })

  test('still reports the failure when the rollback repaint throws', async () => {
    const notices: Array<string | undefined> = []
    let armed = false
    const h = harness({
      deps: {
        schedule: () => {
          armed = true
          throw new Error('clock unavailable')
        },
        onChange: (state, notice) => {
          notices.push(notice)
          if (armed && state.workflow === null && notice === undefined) {
            armed = false
            throw new Error('repaint failed')
          }
        },
      },
    })
    h.controller.onSessionStart('sess-1')

    await h.controller.startExplicit(h.ports, '원문', 'pane')

    expect(h.controller.getState().workflow).toBeNull()
    expect(notices).toContain('개선을 시작하지 못했습니다: clock unavailable')
  })

  test('an explicit retry after a failed start is not refused as busy', async () => {
    const h = harness({
      deps: {
        schedule: () => {
          throw new Error('clock unavailable')
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.startExplicit(h.ports, '원문', 'pane')

    await h.controller.startExplicit(h.ports, '다시 시도', 'pane')

    expect(h.notices).not.toContain('이미 개선 작업이 진행 중입니다.')
    expect(h.notices.filter(n => n === '개선을 시작하지 못했습니다: clock unavailable')).toHaveLength(2)
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('a scheduled explicit start still creates and runs the workflow', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    await h.controller.startExplicit(h.ports, '원문', 'pane')
    await h.flush()

    expect(h.controller.getState().workflow?.original).toBe('원문')
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
    expect(h.calls.complete).toBe(1)
  })

  test('clears the run and permit on session end', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.accept(h.ports)
    await h.controller.onSubmit(h.ports, submit('새 요청'), 'pane')
    expect(h.controller.getState().workflow).not.toBeNull()
    expect(h.controller.getState().bypass).not.toBeNull()

    h.controller.onSessionEnd()

    const state = h.controller.getState()
    expect(state.workflow).toBeNull()
    expect(state.bypass).toBeNull()
  })
})

describe('isolation invariants', () => {
  test('never forks and never submits the main session before approval', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, '보완')

    expect(h.calls.complete).toBe(2)
    expect(h.calls.fork).toBe(0)
    expect(h.calls.submit).toBe(0)
    expect(h.controller.getState().usage.calls).toBe(2)
  })
})

describe('usage — session attribution', () => {
  test('a late aborted completion after a session switch leaves the new session usage at zero', async () => {
    // The mock honours the abort, but its response still carries the usage the
    // host had already spent (issue #33).
    const h = harness({
      complete: (_request, signal) =>
        new Promise<ModelCompleteResult>(resolve => {
          signal?.addEventListener('abort', () => resolve({
            isAnswered: false,
            reason: 'aborted',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 1,
              cache_creation_input_tokens: 2,
            },
          }), { once: true })
        }),
    })
    h.controller.onSessionStart('old')
    await h.controller.onSubmit(h.ports, submit('이전 세션의 요청'), 'pane')
    const queued = h.queue.shift()
    const running = (queued as () => Promise<void>)()
    await h.waitFor(() => h.calls.complete === 1)

    // The switch aborts the in-flight call and resets the state first; the old
    // round's continuation settles only afterwards.
    h.controller.onSessionStart('new')
    await running

    const state = h.controller.getState()
    expect(state.sessionId).toBe('new')
    expect(state.workflow).toBeNull()
    expect(state.usage).toEqual({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, updatedAt: 0 })
  })

  test('a late answered reply after a session switch leaves the new session usage and draft untouched', async () => {
    // The completion is still in flight when the session switches, and it
    // settles as a normal answered reply carrying usage afterwards.
    let release: ((result: ModelCompleteResult) => void) | undefined
    const h = harness({
      complete: () =>
        new Promise<ModelCompleteResult>(resolve => {
          release = resolve
        }),
    })
    h.controller.onSessionStart('old')
    await h.controller.onSubmit(h.ports, submit('이전 세션의 요청'), 'pane')
    const queued = h.queue.shift()
    const running = (queued as () => Promise<void>)()
    await h.waitFor(() => h.calls.complete === 1)

    // The switch resets the state and aborts the old round; the old session's
    // answered reply lands only afterwards and must not fold into the new one.
    h.controller.onSessionStart('new')
    release?.(answered('이전 세션의 결과'))
    await running

    const state = h.controller.getState()
    expect(state.sessionId).toBe('new')
    expect(state.workflow).toBeNull()
    expect(state.usage).toEqual({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, updatedAt: 0 })
  })
})

describe('scheduled work', () => {
  test('turns a failed scheduled refine into a notice, never a rejection', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'composer')
    await h.flush()

    h.flags.throwOnRepaint = true
    const outcome = await h.controller.onSubmit(h.ports, submit('더 짧게'), 'composer')
    expect(outcome).toEqual({ action: 'drop', reason: '보완 요청을 옵티마이저에 전달했습니다.' })

    // `flush` awaits the scheduled callback's promise: the wrapper must keep it
    // from rejecting and report the fault as a notice instead.
    await h.flush()

    expect(h.notices).toContain('보완 요청을 처리하지 못했습니다: repaint failed')
  })
})

describe('prompt caching by engine version', () => {
  test('uses the cached block request at 2.1.292', async () => {
    const h = harness({ version: async () => ({ version: '2.1.292' }) })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const request = h.completes[0]
    expect(Array.isArray(request?.prompt)).toBe(true)
    expect((request?.prompt as readonly ModelTextBlock[]).every(block => block.text !== '')).toBe(true)
    expect(request?.system).toEqual([{ text: expect.any(String), cache: true }])
    expect(h.calls.version).toBe(1)
  })

  test('uses the plain string request below 2.1.292', async () => {
    const h = harness({ version: async () => ({ version: '2.1.291' }) })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(typeof h.completes[0]?.prompt).toBe('string')
    expect(typeof h.completes[0]?.system).toBe('string')
  })

  test('falls back to the string request with no version getter or a throwing one', async () => {
    const none = harness()
    none.controller.onSessionStart('sess-1')
    await none.controller.onSubmit(none.ports, submit('원문'), 'pane')
    await none.flush()
    expect(typeof none.completes[0]?.prompt).toBe('string')
    expect(none.notices.some(notice => notice?.includes('개선에 실패'))).toBe(false)

    const broken = harness({
      version: async () => {
        throw new Error('no version available')
      },
    })
    broken.controller.onSessionStart('sess-1')
    await broken.controller.onSubmit(broken.ports, submit('원문'), 'pane')
    await broken.flush()
    expect(typeof broken.completes[0]?.prompt).toBe('string')
    expect(broken.notices.some(notice => notice?.includes('개선에 실패'))).toBe(false)
  })

  test('reads the version once and reuses it across rounds', async () => {
    const h = harness({ version: async () => ({ version: '2.1.292' }) })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, '더 짧게')

    expect(h.calls.version).toBe(1)
    expect(Array.isArray(h.completes[1]?.prompt)).toBe(true)
  })

  test('notices once below 2.1.292 and stays silent on a supported version', async () => {
    const old = harness({ version: async () => ({ version: '2.1.291' }) })
    old.controller.onSessionStart('sess-1')
    await old.controller.onSubmit(old.ports, submit('원문'), 'pane')
    await old.flush()
    await old.controller.refine(old.ports, '더 짧게')

    const warnings = old.notices.filter(notice => notice?.includes('프롬프트 캐시 없이 동작'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2.1.291')

    const current = harness({ version: async () => ({ version: '2.1.292' }) })
    current.controller.onSessionStart('sess-1')
    await current.controller.onSubmit(current.ports, submit('원문'), 'pane')
    await current.flush()
    expect(current.notices.filter(notice => notice?.includes('프롬프트 캐시 없이 동작'))).toHaveLength(0)
  })

  test('notices that the version could not be read with no getter', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const warnings = h.notices.filter(notice => notice?.includes('버전을 확인할 수 없어'))
    expect(warnings).toHaveLength(1)
  })

  test('a cancel during the version read holds the notice for the next live round', async () => {
    let releaseVersion: ((info: SessionVersion) => void) | undefined
    const h = harness({
      model: () => 'claude-opus-5-5',
      version: () =>
        new Promise<SessionVersion>(resolve => {
          releaseVersion = resolve
        }),
    })
    h.controller.onSessionStart('sess-1')

    // Run A reaches the version read and hangs there.
    await h.controller.onSubmit(h.ports, submit('첫 요청'), 'pane')
    const queued = h.queue.shift()
    const running = (queued as () => Promise<void>)()
    await h.waitFor(() => h.calls.version === 1)

    // The person cancels while the read is still in flight.
    await h.controller.cancel(h.ports)
    releaseVersion?.({ version: '2.1.291' })
    await running

    // The run they already left shows nothing.
    expect(h.notices.filter(notice => notice?.includes('프롬프트 캐시 없이 동작'))).toHaveLength(0)

    // The next live round shows the held notice exactly once, and the answer is
    // memoized so the version is not read again.
    await h.controller.onSubmit(h.ports, submit('둘째 요청'), 'pane')
    await h.flush()
    const warnings = h.notices.filter(notice => notice?.includes('프롬프트 캐시 없이 동작'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2.1.291')
    expect(h.calls.version).toBe(1)
  })
})

describe('model-aware guidance', () => {
  test('reads the main model once per round and applies its profile block', async () => {
    const h = harness({ model: () => 'claude-opus-5-5' })
    h.controller.onSessionStart('sess-1')

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, '더 짧게')
    await h.controller.retry(h.ports)

    expect(h.calls.model).toBe(3)
    expect(h.calls.complete).toBe(3)
    for (const request of h.completes) {
      expect(request.system).toContain('[대상 모델 편집 지침: opus-5-5]')
    }
  })

  test('re-reads the model each round so a mid-run switch changes the system prompt', async () => {
    let call = 0
    const h = harness({
      model: () => {
        call += 1
        return call === 1 ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
      },
    })
    h.controller.onSessionStart('sess-1')

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, '더 짧게')

    expect(h.calls.model).toBe(2)
    expect(h.completes[0]?.system).toContain('[대상 모델 편집 지침: opus-5-5]')
    expect(h.completes[0]?.system).not.toContain('sonnet-5-5')
    expect(h.completes[1]?.system).toContain('[대상 모델 편집 지침: sonnet-5-5]')
    expect(h.completes[1]?.system).not.toContain('opus-5-5')
  })

  test('reads the extra prompt file once per run across many rounds', async () => {
    const h = harness({
      model: () => 'claude-opus-5-5',
      config: { systemPromptFile: '/extra.md' },
      files: { '/extra.md': '파일 추가 지침' },
    })
    h.controller.onSessionStart('sess-1')

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
    await h.controller.refine(h.ports, '더 짧게')
    await h.controller.retry(h.ports)

    expect(h.calls.fileRead).toBe(1)
    expect(h.calls.complete).toBe(3)
    for (const request of h.completes) {
      expect(request.system).toContain('파일 추가 지침')
    }
  })

  test('a disabled toggle skips the getter and applies common guidance', async () => {
    const h = harness({ model: () => 'claude-opus-5-5', config: { modelGuidance: false } })
    h.controller.onSessionStart('sess-1')

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(h.calls.model).toBe(0)
    expect(h.calls.complete).toBe(1)
    expect(h.completes[0]?.system).not.toContain('[대상 모델 편집 지침')
    expect(h.controller.getGuidanceStatus()).toMatchObject({
      workflowId: 'wf-1',
      round: 1,
      target: { profile: 'common', reason: 'disabled' },
    })
  })

  test('a rejected getter falls back to common and still completes once', async () => {
    const h = harness({ model: () => Promise.reject(new Error('getter failed')) })
    h.controller.onSessionStart('sess-1')

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(h.calls.model).toBe(1)
    expect(h.calls.complete).toBe(1)
    expect(h.completes[0]?.system).not.toContain('[대상 모델 편집 지침')
    expect(h.controller.getGuidanceStatus()?.target).toMatchObject({
      profile: 'common',
      reason: 'error',
    })
  })

  test('a host without the model port falls back to common and still completes once', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(h.calls.model).toBe(0)
    expect(h.calls.complete).toBe(1)
    expect(h.completes[0]?.system).not.toContain('[대상 모델 편집 지침')
    expect(h.controller.getGuidanceStatus()?.target).toMatchObject({
      profile: 'common',
      reason: 'unavailable',
    })
  })

  test('a cancel during detection completes nothing and records no status', async () => {
    const h = harness({ model: () => new Promise<string>(() => {}) })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')

    const queued = h.queue.shift()
    const running = (queued as () => Promise<void>)()
    await h.waitFor(() => h.calls.model === 1)

    await h.controller.cancel(h.ports)
    await running

    expect(h.calls.complete).toBe(0)
    expect(h.controller.getGuidanceStatus()).toBeNull()
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('a cancelled run’s late extra read cannot overwrite the next run', async () => {
    let readCalls = 0
    let releaseFirst: ((text: string) => void) | undefined
    const h = harness({
      model: () => 'claude-opus-5-5',
      config: { systemPromptFile: '/extra.md' },
      files: { '/extra.md': 'placeholder' },
      read: () => {
        readCalls += 1
        if (readCalls === 1) {
          return new Promise<string>(resolve => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve('새 실행 지침')
      },
    })
    h.controller.onSessionStart('sess-1')

    // Run A starts and hangs on its extra-file read.
    await h.controller.onSubmit(h.ports, submit('첫 요청'), 'pane')
    const queued = h.queue.shift()
    const running = (queued as () => Promise<void>)()
    await h.waitFor(() => readCalls === 1)

    // Cancel A, then start run B; B reads its own extra and completes.
    await h.controller.cancel(h.ports)
    await h.controller.onSubmit(h.ports, submit('둘째 요청'), 'pane')
    await h.flush()

    // A's read finally lands; it must not touch B's cache.
    releaseFirst?.('이전 실행 지침')
    await running

    const latest = h.completes.at(-1)
    expect(latest?.system).toContain('새 실행 지침')
    expect(latest?.system).not.toContain('이전 실행 지침')
  })

  test('getGuidanceStatus stores the last request and resets with the session', async () => {
    const h = harness({ model: () => 'claude-opus-5-5[1m]' })
    h.controller.onSessionStart('sess-1')
    expect(h.controller.getGuidanceStatus()).toBeNull()

    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const status = h.controller.getGuidanceStatus()
    expect(status).not.toBeNull()
    expect(status).toMatchObject({
      workflowId: 'wf-1',
      round: 1,
      target: {
        raw: 'claude-opus-5-5[1m]',
        normalizedId: 'claude-opus-5-5',
        profile: 'opus-5-5',
        reason: 'matched',
      },
    })

    // Reading the status must not touch the model getter.
    const before = h.calls.model
    h.controller.getGuidanceStatus()
    expect(h.calls.model).toBe(before)

    // The next round bumps the recorded round number.
    await h.controller.refine(h.ports, '더')
    expect(h.controller.getGuidanceStatus()).toMatchObject({ workflowId: 'wf-1', round: 2 })

    h.controller.onSessionEnd()
    expect(h.controller.getGuidanceStatus()).toBeNull()

    h.controller.onSessionStart('sess-2')
    expect(h.controller.getGuidanceStatus()).toBeNull()
  })
})

/** An engine dialog held open without holding the scheduled round open. */
function questionDialog() {
  let resolve!: (answer: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  const calls: Array<{ question: string; options: unknown }> = []
  const ask: NonNullable<EnginePorts['ui']['ask']> = (question, options) => {
    calls.push({ question, options })
    return promise
  }
  return { ask, calls, resolve, reject }
}

const ASK_QUESTION = '대상 독자는 누구인가요?'
const ASK_OPTIONS = ['경영진', '개발팀']
const questionReply = () => answered('개선안', '독자를 확인합니다', ASK_QUESTION, ASK_OPTIONS)

async function startQuestion(h: Harness, ui: 'pane' | 'composer' = 'pane') {
  h.controller.onSessionStart('sess-ask')
  await h.controller.onSubmit(h.ports, submit('요청을 개선해 주세요'), ui)
  await h.flush()
}


describe('explicit decision correction', () => {
  test('replaces an active decision without a call and the retry request uses only the new text', async () => {
    const h = harness({
      complete: async (_request, _signal, call) => call === 1 ? questionReply() : answered(`개선안 ${call}`),
    })
    await startQuestion(h)
    await h.controller.refine(h.ports, '외부 서비스 사용')
    const before = h.calls.complete

    const corrected = h.controller.correctDecision('d1', '로컬에서만 처리')
    expect(corrected).toEqual({ ok: true })
    expect(h.calls.complete).toBe(before)
    const workflow = h.controller.getState().workflow
    expect(workflow?.rounds).toBe(2)
    expect(workflow?.draft).toBe('개선안 2')
    expect(workflow?.decisions?.entries.map(entry => entry.id)).toEqual(['d1', 'd2'])
    expect(workflow?.decisions?.entries[1]?.text).toBe('로컬에서만 처리')
    expect(workflow?.decisions?.entries[1]?.supersedes).toBe('d1')
    expect(workflow?.decisions?.entries[1]?.source).toBe(workflow?.decisions?.entries[0]?.source)
    expect(h.notices).toContain('결정을 정정했습니다. /optimize retry로 개선안에 반영하세요.')

    await h.controller.retry(h.ports)
    const prompt = requestText(h.completes.at(-1)?.prompt)
    expect(prompt).toContain('로컬에서만 처리')
    expect(prompt).not.toContain('외부 서비스 사용')
  })

  test('a second correction cuts the retry dialogue that reasoned from the replaced value', async () => {
    const h = harness({
      complete: async (_request, _signal, call) => {
        if (call === 1) return answered('개선안 1', 'R1-QUESTION', ASK_QUESTION, ASK_OPTIONS)
        if (call === 2) return answered('개선안 2', 'R2-INTERMEDIATE')
        if (call === 3) return answered('개선안 3', 'R3-FOR-D2')
        return answered('개선안 4', 'R4-FINAL')
      },
    })
    await startQuestion(h)
    await h.controller.refine(h.ports, '외부 서비스 사용')
    expect(h.controller.correctDecision('d1', '로컬에서만 처리').ok).toBe(true)
    await h.controller.retry(h.ports)
    expect(h.controller.correctDecision('d2', '로컬 전용, 외부 호출 금지').ok).toBe(true)

    await h.controller.retry(h.ports)
    const prompt = requestText(h.completes.at(-1)?.prompt)
    expect(prompt).toContain('로컬 전용, 외부 호출 금지')
    for (const stale of ['R1-QUESTION', 'R2-INTERMEDIATE', 'R3-FOR-D2']) {
      expect(prompt).not.toContain(stale)
    }
    expect(prompt).not.toContain('user: 로컬에서만 처리')
    expect(prompt).not.toContain('"id":"d2"')
  })

  test('a correction is allowed at the exhausted round limit and leaves unrelated decisions active', async () => {
    const h = harness({
      config: { maxRounds: 3 },
      complete: async (_request, _signal, call) => call === 1 ? questionReply() : answered(`개선안 ${call}`),
    })
    await startQuestion(h)
    await h.controller.refine(h.ports, '첫 결정')
    await h.controller.refine(h.ports, '둘째 결정')
    const before = h.calls.complete
    expect(h.controller.getState().workflow?.rounds).toBe(3)

    const corrected = h.controller.correctDecision('d1', '첫 결정 정정')
    expect(corrected.ok).toBe(true)
    expect(h.calls.complete).toBe(before)
    expect(h.controller.getState().workflow?.rounds).toBe(3)
    const active = activeDecisions(h.controller.getState().workflow?.decisions ?? { entries: [], nextId: 1 })
    expect(active.map(entry => entry.text)).toEqual(['둘째 결정', '첫 결정 정정'])
    // At the limit the notice names the approval step; the bare retry below
    // cannot apply the correction until /optimize more approves a round.
    expect(h.notices).toContain(
      '결정을 정정했습니다. 라운드 한도에 도달했으니 /optimize more 로 승인한 뒤 /optimize retry 로 반영하세요.',
    )
    await h.controller.retry(h.ports)
    expect(h.calls.complete).toBe(before)

    expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
    expect(h.controller.getState().workflow?.roundLimit).toBe(8)
    await h.controller.retry(h.ports)
    expect(h.calls.complete).toBe(before + 1)
    expect(hasPendingCorrection(h.controller.getState().workflow)).toBe(false)
    const prompt = requestText(h.completes.at(-1)?.prompt)
    expect(prompt).toContain('첫 결정 정정')
    expect(prompt).not.toContain('"id":"d1"')
  })

  test('an open host choice dialog blocks correction instead of clearing its marker', async () => {
    const dialog = questionDialog()
    const h = harness({ ui: { ask: dialog.ask }, complete: async () => questionReply() })
    await startQuestion(h)
    expect(h.controller.getState().workflow?.questionAsk).toBe('pending')

    const corrected = h.controller.correctDecision('d1', '로컬')
    expect(corrected.ok).toBe(false)
    expect(corrected.reason).toBe('열린 선택 창을 먼저 닫아 주세요.')
    expect(h.notices).toContain('열린 선택 창을 먼저 닫아 주세요.')
    expect(h.calls.complete).toBe(1)
    expect(h.controller.getState().workflow?.decisions?.entries).toHaveLength(0)
  })

  test('missing, blank, replaced and no-workflow corrections fail without a call', async () => {
    const empty = harness()
    empty.controller.onSessionStart('sess-1')
    expect(empty.controller.correctDecision('d1', 'x').reason).toBe('진행 중인 개선 작업이 없습니다.')

    const h = harness({ complete: async (_request, _signal, call) => call === 1 ? questionReply() : answered('개선안') })
    await startQuestion(h)
    await h.controller.refine(h.ports, '첫 결정')
    const before = h.calls.complete
    expect(h.controller.correctDecision('d9', 'x').ok).toBe(false)
    expect(h.controller.correctDecision('d1', '   ').ok).toBe(false)
    expect(h.controller.correctDecision('d1', '정정 결정').ok).toBe(true)
    expect(h.controller.correctDecision('d1', '다시 정정').ok).toBe(false)
    expect(h.calls.complete).toBe(before)
  })

  test('a failed later generation keeps the correction and still accepts another', async () => {
    let call = 0
    const h = harness({
      complete: async () => {
        call += 1
        if (call === 1) return questionReply()
        if (call === 2) return answered('두 번째 개선안')
        return apiError()
      },
    })
    await startQuestion(h)
    await h.controller.refine(h.ports, '첫 결정')
    expect(h.controller.correctDecision('d1', '정정 결정').ok).toBe(true)

    await h.controller.retry(h.ports)
    const failed = h.controller.getState().workflow
    expect(failed?.phase).toBe('failed')
    expect(failed?.decisions?.entries.map(entry => entry.id)).toEqual(['d1', 'd2'])
    expect(failed?.decisions?.entries[1]?.text).toBe('정정 결정')
    expect(h.controller.correctDecision('d2', '실패 뒤 재정정').ok).toBe(true)
    expect(h.controller.getState().workflow?.decisions?.entries.map(entry => entry.id)).toEqual(['d1', 'd2', 'd3'])
  })
})

describe('undo — state-only restore', () => {
  /** Two successes (the first with a question), then a failed attempt. */
  function undoHarness(): Harness {
    return harness({
      complete: async (_request, _signal, call) => {
        if (call === 1) return answered('개선안 1', '첫 메모', '질문 1?', ['로컬', '외부'])
        if (call === 2) return answered('개선안 2', '둘째 메모')
        if (call === 3) return apiError()
        return answered('개선안 4', '넷째 메모')
      },
    })
  }

  async function started(h: Harness): Promise<void> {
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()
  }

  test('undoes to the preceding success after a later failure without any call or composer IO', async () => {
    const h = undoHarness()
    await started(h)
    await h.controller.refine(h.ports, '외부 서비스 사용')
    expect(h.controller.getState().workflow?.currentRevisionId).toBe('r2')
    await h.controller.retry(h.ports)
    const before = h.controller.getState()
    expect(before.workflow?.phase).toBe('failed')
    const io = { complete: h.calls.complete, fill: h.calls.fill, promptRead: h.calls.promptRead, submit: h.calls.submit }

    const result = h.controller.undo()
    expect(result).toEqual({ ok: true })
    const after = h.controller.getState().workflow
    expect(after?.phase).toBe('reviewing')
    expect(after?.generation).toBe((before.workflow?.generation ?? 0) + 1)
    expect(after?.draft).toBe('개선안 1')
    expect(after?.message).toBe('첫 메모')
    expect(after?.question).toBe('질문 1?')
    expect(after?.options).toEqual(['로컬', '외부'])
    // Rounds, usage and allowance stay exactly as they were.
    expect(after?.rounds).toBe(before.workflow?.rounds)
    expect(after?.usage).toEqual(before.workflow?.usage)
    expect(h.controller.getState().usage).toEqual(before.usage)
    expect(h.calls.complete).toBe(io.complete)
    expect(h.calls.fill).toBe(io.fill)
    expect(h.calls.promptRead).toBe(io.promptRead)
    expect(h.calls.submit).toBe(io.submit)
    expect(h.notices).toContain('이전 성공 라운드로 되돌렸습니다. 사용량과 라운드 한도는 유지됩니다.')
  })

  test('refuses when there is no earlier success and leaves the state object alone', async () => {
    const h = undoHarness()
    await started(h)
    const before = h.controller.getState()
    const result = h.controller.undo()
    expect(result).toEqual({ ok: false, reason: '되돌릴 이전 성공 라운드가 없습니다.' })
    expect(h.notices).toContain('되돌릴 이전 성공 라운드가 없습니다.')
    expect(h.controller.getState()).toBe(before)
  })

  test('consecutive undos walk back successes; a later refine branches forward with fresh ids', async () => {
    const h = harness({ complete: async (_request, _signal, call) => answered(`개선안 ${call}`, `${call}번째 메모`) })
    await started(h)
    await h.controller.refine(h.ports, '첫 보완')
    await h.controller.refine(h.ports, '둘째 보완')
    expect(h.controller.getState().workflow?.revisions?.map(revision => revision.id)).toEqual(['r1', 'r2', 'r3'])

    expect(h.controller.undo().ok).toBe(true)
    expect(h.controller.getState().workflow?.currentRevisionId).toBe('r2')
    expect(h.controller.getState().workflow?.draft).toBe('개선안 2')
    expect(h.controller.undo().ok).toBe(true)
    expect(h.controller.getState().workflow?.currentRevisionId).toBe('r1')
    expect(h.controller.undo().ok).toBe(false)

    await h.controller.refine(h.ports, '다시 보완')
    const wf = h.controller.getState().workflow
    expect(wf?.revisions?.map(revision => revision.id)).toEqual(['r1', 'r4'])
    expect(wf?.currentRevisionId).toBe('r4')
  })

  test('the next request uses the restored ledger, and decision ids are never recycled', async () => {
    const h = undoHarness()
    await started(h)
    // The answer to round 1's question is captured as d1 before round 2 succeeds.
    await h.controller.refine(h.ports, '로컬')
    expect(h.controller.getState().workflow?.decisions?.entries.map(entry => entry.id)).toEqual(['d1'])

    expect(h.controller.undo().ok).toBe(true)
    // The snapshot's entries are restored, but the id counter keeps its mark.
    expect(h.controller.getState().workflow?.decisions).toEqual({ entries: [], nextId: 2 })
    await h.controller.refine(h.ports, '외부 서비스 사용')
    expect(h.controller.getState().workflow?.decisions?.entries.map(entry => entry.id)).toEqual(['d2'])
    const prompt = requestText(h.completes.at(-1)?.prompt)
    expect(prompt).toContain('외부 서비스 사용')
    expect(prompt).toContain('"id":"d2"')
    // The restored question and choices ride along as the pending question too.
    expect(prompt).toContain('"question":"질문 1?"')
    expect(prompt).toContain('"options":["로컬","외부"]')
  })

  test('a scheduled supplement captured before the undo cannot run a round', async () => {
    const h = undoHarness()
    await started(h)
    await h.controller.refine(h.ports, '첫 보완')
    const before = h.calls.complete
    // The refinement is queued, not yet run; undo wins the race.
    await h.controller.onSubmit(h.ports, submit('더 줄여줘'), 'pane')
    expect(h.controller.undo().ok).toBe(true)
    await h.flush()
    expect(h.calls.complete).toBe(before)
    expect(h.controller.getState().workflow?.draft).toBe('개선안 1')
  })

  test('a pre-undo reply flow can neither complete nor speak after the undo', async () => {
    const dialog = questionDialog()
    const h = harness({
      ui: { ask: dialog.ask },
      complete: async (_request, _signal, call) => {
        if (call === 1) return answered('개선안 1', '첫 메모')
        if (call === 2) return answered('개선안 2', '둘째 메모')
        // What the captured supplement would get if its round wrongly ran.
        return answered('개선안 3', '늦은 메모', '늦은 질문?', ['A', 'B'])
      },
    })
    await started(h)
    await h.controller.refine(h.ports, '첫 보완')
    const spoken = h.notices.filter(notice => notice !== undefined).length
    const generationBefore = h.controller.getState().workflow?.generation ?? 0
    await h.controller.onSubmit(h.ports, submit('더 줄여줘'), 'pane')
    expect(h.controller.undo().ok).toBe(true)
    await h.flush()

    // The stale generation produced no completion, no new notice and no dialog:
    // the restored revision stands exactly as the undo left it.
    expect(h.calls.complete).toBe(2)
    expect(h.notices.filter(notice => notice !== undefined)).toHaveLength(spoken + 1)
    expect(h.notices).toContain('이전 성공 라운드로 되돌렸습니다. 사용량과 라운드 한도는 유지됩니다.')
    expect(h.notices).not.toContain('늦은 메모')
    expect(dialog.calls).toHaveLength(0)
    const restored = h.controller.getState().workflow
    expect(restored?.phase).toBe('reviewing')
    expect(restored?.draft).toBe('개선안 1')
    expect(restored?.generation).toBe(generationBefore + 1)
  })

  test('undo is refused while generating and unavailable before any success', async () => {
    const completion = deferred<ModelCompleteResult>()
    const h = harness({ complete: () => completion.promise })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    const running = h.flush()
    await h.waitFor(() => h.calls.complete === 1)
    expect(h.controller.getState().workflow?.phase).toBe('generating')
    expect(h.controller.undo()).toEqual({ ok: false, reason: IN_FLIGHT_REASON })
    completion.resolve(answered('개선안'))
    await running
    expect(h.controller.undo().reason).toBe('되돌릴 이전 성공 라운드가 없습니다.')
  })

  test('an open choice dialog refuses undo without clearing its pending marker', async () => {
    const dialog = questionDialog()
    const h = harness({ ui: { ask: dialog.ask }, complete: async () => questionReply() })
    await startQuestion(h)
    expect(h.controller.getState().workflow?.questionAsk).toBe('pending')
    const result = h.controller.undo()
    expect(result).toEqual({ ok: false, reason: '열린 선택 창을 먼저 닫아 주세요.' })
    expect(h.controller.getState().workflow?.questionAsk).toBe('pending')
    dialog.resolve(ASK_OPTIONS[0] as string)
    expect(h.controller.getState().workflow?.questionAsk).toBe('pending')
  })

  test('undo keeps the approved round limit and clears the spent dialog markers', async () => {
    const h = harness({
      config: { maxRounds: 2 },
      complete: async (_request, _signal, call) => {
        if (call === 1) return answered('개선안 1', '', '질문 1?', ['로컬', '외부'])
        return answered(`개선안 ${call}`, '', `질문 ${call}?`, ['A', 'B'])
      },
    })
    await started(h)
    await h.controller.refine(h.ports, '보완')
    expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
    expect(h.controller.getState().workflow?.roundLimit).toBe(7)
    expect(h.controller.undo().ok).toBe(true)
    const wf = h.controller.getState().workflow
    expect(wf?.roundLimit).toBe(7)
    expect(wf?.rounds).toBe(2)
    expect(wf?.limitAsk).toBeUndefined()
  })

  test('accept after undo fills the restored draft and dismisses the run', async () => {
    const h = undoHarness()
    await started(h)
    await h.controller.refine(h.ports, '첫 보완')
    expect(h.controller.undo().ok).toBe(true)
    const result = await h.controller.accept(h.ports)
    expect(result).toEqual({ ok: true })
    expect(h.fills.at(-1)?.text).toBe('개선안 1')
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.controller.undo().reason).toBe('진행 중인 개선 작업이 없습니다.')
  })
})

describe('round extensions — explicit approval and workflow isolation', () => {
  test('the default fifth round asks for approval before preserving and asking its unresolved question', async () => {
    const approval = questionDialog()
    const followup = questionDialog()
    const config = { ...DEFAULT_CONFIG }
    const h = harness({
      deps: { getConfig: () => config },
      ui: { ask: (q, o) => (o && 'header' in o && o.header === '라운드 연장' ? approval : followup).ask(q, o) },
      complete: async (_r, _s, n) => n === 5 ? questionReply() : answered(`개선안 ${n}`),
    })
    await startQuestion(h)
    for (let n = 2; n <= 5; n += 1) await h.controller.refine(h.ports, `보완 ${n}`)

    const before = h.controller.getState().workflow!
    expect(before.rounds).toBe(5)
    expect(before.limitAsk).toBe('pending')
    expect(before.question).toBe(ASK_QUESTION)
    expect(before.options).toEqual(ASK_OPTIONS)
    expect(approval.calls).toHaveLength(1)
    expect(approval.calls[0]?.question).toContain('5회')
    expect(approval.calls[0]?.options).toEqual({ options: ['추가 5회 허용', '현재 개선안 유지'], header: '라운드 연장' })
    expect(followup.calls).toHaveLength(0)

    await h.controller.refine(h.ports, '승인 전 보완')
    await h.controller.retry(h.ports, '승인 전 재시도')
    expect((await h.controller.extendRounds(h.ports)).ok).toBe(false)
    expect(h.calls.complete).toBe(5)
    expect(h.controller.getState().workflow?.question).toBe(ASK_QUESTION)
    expect(h.controller.getState().workflow?.dialogue).toEqual(before.dialogue)
    expect(approval.calls).toHaveLength(1)

    approval.resolve('추가 5회 허용')
    await h.waitFor(() => h.controller.getState().workflow?.roundLimit === 10 && followup.calls.length === 1)
    expect(config.maxRounds).toBe(5)
    expect(h.calls.complete).toBe(5)
    expect(followup.calls).toEqual([{ question: ASK_QUESTION, options: { options: ASK_OPTIONS, header: '보완 질문' } }])
    followup.resolve('개발팀')
    await h.waitFor(() => h.controller.getState().workflow?.rounds === 6)
    expect(h.calls.complete).toBe(6)
    expect(requestText(h.completes[5]?.prompt)).toContain('remaining: 4')
    expect(h.controller.getState().workflow?.dialogue.some(m => m.role === 'user' && m.text === '추가 5회 허용')).toBe(false)
  })

  test('approving an open question keeps it visible until a user supplies a refinement', async () => {
    const approval = questionDialog()
    const h = harness({
      config: { maxRounds: 1 },
      ui: { ask: approval.ask },
      complete: async (_r, _s, n) => n === 1 ? answered('개선안', '', ASK_QUESTION, []) : answered('최종안'),
    })
    await startQuestion(h, 'composer')
    approval.resolve('추가 5회 허용')
    await h.waitFor(() => h.controller.getState().workflow?.roundLimit === 6)
    expect(approval.calls).toHaveLength(1)
    expect(h.calls.complete).toBe(1)
    expect(h.controller.getState().workflow?.question).toBe(ASK_QUESTION)
    await h.controller.refine(h.ports, '개발팀')
    expect(h.calls.complete).toBe(2)
    expect(requestText(h.completes[1]?.prompt)).toContain(ASK_QUESTION)
  })

  for (const disposition of ['decline', 'escape', 'throw'] as const) {
    test(`${disposition} preserves the draft and question at the limit, while a later explicit approval can extend`, async () => {
      const approval = questionDialog()
      const followup = questionDialog()
      const h = harness({
        config: { maxRounds: 1 },
        ui: { ask: (q, o) => {
          if (!o || !('header' in o) || o.header !== '라운드 연장') return followup.ask(q, o)
          if (disposition === 'throw') throw new Error('dialog unavailable')
          return approval.ask(q, o)
        } },
        complete: async () => questionReply(),
      })
      await startQuestion(h)
      const before = h.controller.getState().workflow!
      if (disposition === 'decline') approval.resolve('현재 개선안 유지')
      if (disposition === 'escape') approval.reject(new Error('Esc'))
      await h.waitFor(() => h.controller.getState().workflow?.limitAsk === (disposition === 'decline' ? 'declined' : 'closed'))
      if (disposition === 'decline') {
        expect(h.notices).toContain('추가 호출 없이 현재 개선안과 미해결 질문을 유지합니다.')
      }

      await h.controller.refine(h.ports, '승인 없이 계속')
      await h.controller.retry(h.ports, '승인 없이 재시도')
      const current = h.controller.getState().workflow!
      expect(Math.max(1, current.roundLimit ?? 0)).toBe(1)
      expect(current.original).toBe(before.original)
      expect(current.draft).toBe(before.draft)
      expect(current.question).toBe(ASK_QUESTION)
      expect(current.options).toEqual(ASK_OPTIONS)
      expect(current.dialogue).toEqual(before.dialogue)
      expect(h.calls.complete).toBe(1)
      expect(approval.calls).toHaveLength(disposition === 'throw' ? 0 : 1)

      expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
      expect(h.controller.getState().workflow?.roundLimit).toBe(6)
      expect(h.calls.complete).toBe(1)
      expect(followup.calls).toHaveLength(1)
    })
  }

  test('declining a correction-only extension keeps the correction and names the approval path', async () => {
    const approval = questionDialog()
    const h = harness({
      config: { maxRounds: 2 },
      ui: { ask: approval.ask },
      // One choice keeps the question dialog closed so the only ask below is
      // the correction-only round-extension dialog.
      complete: async (_r, _s, n) => n === 1 ? answered('개선안', '독자를 확인합니다', ASK_QUESTION) : answered('개선안 2'),
    })
    await startQuestion(h)
    await h.controller.refine(h.ports, '첫 결정')
    const atLimit = h.controller.getState().workflow!
    expect(atLimit.rounds).toBe(2)
    expect(atLimit.question).toBeNull()
    expect(h.controller.correctDecision('d1', '정정 결정').ok).toBe(true)
    expect(hasPendingCorrection(h.controller.getState().workflow)).toBe(true)

    await h.controller.retry(h.ports)
    expect(approval.calls).toHaveLength(1)
    expect(approval.calls[0]?.question).toContain('정정한 결정이 아직 반영되지 않았습니다')
    expect(approval.calls[0]?.question).not.toContain('미해결 질문')
    approval.resolve('현재 개선안 유지')
    await h.waitFor(() => h.controller.getState().workflow?.limitAsk === 'declined')

    expect(h.notices).toContain(
      '추가 라운드를 승인하지 않았습니다. 정정한 결정은 유지되며 /optimize more 로 다시 승인할 수 있습니다.',
    )
    expect(h.notices).not.toContain('추가 호출 없이 현재 개선안과 미해결 질문을 유지합니다.')
    const after = h.controller.getState().workflow!
    expect(after.question).toBeNull()
    expect(after.draft).toBe('개선안 2')
    expect(hasPendingCorrection(after)).toBe(true)
    expect(h.calls.complete).toBe(2)
  })

  test('refuses an extension at the limit with no question or pending correction', async () => {
    const h = harness({ config: { maxRounds: 1 }, complete: async () => answered('개선안') })
    await startQuestion(h)
    const before = h.controller.getState().workflow!
    expect(before.rounds).toBe(1)
    expect(before.question).toBeNull()
    expect(hasPendingCorrection(before)).toBe(false)

    expect(await h.controller.extendRounds(h.ports)).toEqual({
      ok: false,
      reason: '한도에 도달하고 미해결 질문이나 반영할 정정이 남아 있을 때만 연장할 수 있습니다.',
    })
    expect(h.controller.getState().workflow?.roundLimit).toBeUndefined()
    expect(h.calls.complete).toBe(1)
  })

  test('clears a stale extension dialog after the configured limit changes and it is dismissed', async () => {
    const approval = questionDialog()
    const config = { ...DEFAULT_CONFIG, maxRounds: 1 }
    const h = harness({
      deps: { getConfig: () => config },
      ui: { ask: approval.ask },
      complete: async () => answered('개선안', '', ASK_QUESTION, []),
    })
    await startQuestion(h)
    expect(h.controller.getState().workflow?.limitAsk).toBe('pending')
    const draft = h.controller.getState().workflow?.draft

    config.maxRounds = 2
    approval.reject(new Error('Esc after configuration changed'))
    await h.waitFor(() => h.controller.getState().workflow?.limitAsk === 'closed')
    config.maxRounds = 1

    expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
    expect(h.controller.getState().workflow?.roundLimit).toBe(6)
    expect(h.controller.getState().workflow?.draft).toBe(draft)
    expect(h.controller.getState().workflow?.question).toBe(ASK_QUESTION)
    expect(config.maxRounds).toBe(1)
    expect(approval.calls).toHaveLength(1)
    expect(h.calls.complete).toBe(1)
  })

  test('clears a stale extension dialog dismissed during an accept whose pending fill is refused', async () => {
    const approval = questionDialog()
    const pendingFill = deferred<PromptFilled>()
    const h = harness({
      config: { maxRounds: 1 },
      ui: { ask: approval.ask },
      complete: async () => answered('개선안', '', ASK_QUESTION, []),
      fill: () => pendingFill.promise,
    })
    await startQuestion(h)
    const before = h.controller.getState().workflow!
    expect(before.limitAsk).toBe('pending')

    const accepting = h.controller.accept(h.ports)
    await h.waitFor(() => h.calls.fill === 1)
    expect(h.controller.getState().workflow?.phase).toBe('transferring')
    approval.reject(new Error('dialog dismissed while accepting'))
    await h.waitFor(() => h.controller.getState().workflow?.limitAsk === 'closed')
    expect(h.controller.getState().workflow?.phase).toBe('transferring')

    pendingFill.resolve({ text: '', cursor: 0, isFilled: false, refusal: 'dialog' })
    expect((await accepting).ok).toBe(false)
    expect(h.controller.getState().workflow?.phase).toBe('reviewing')
    expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
    expect(h.controller.getState().workflow?.roundLimit).toBe(6)
    expect(h.controller.getState().workflow?.original).toBe(before.original)
    expect(h.controller.getState().workflow?.draft).toBe(before.draft)
    expect(h.controller.getState().workflow?.question).toBe(ASK_QUESTION)
    expect(approval.calls).toHaveLength(1)
    expect(h.calls.complete).toBe(1)
    expect(h.calls.submit).toBe(0)
  })

  for (const action of ['cancel', 'session', 'replacement', 'accept', 'newer-round'] as const) {
    test(`ignores a late extension approval after ${action}`, async () => {
      const approval = questionDialog()
      const currentDialog = questionDialog()
      const debug: string[] = []
      const config = { ...DEFAULT_CONFIG, maxRounds: 1 }
      let asks = 0
      const h = harness({
        deps: { getConfig: () => config },
        ui: {
          ask: (q, o) => (++asks === 1 ? approval : currentDialog).ask(q, o),
          log: text => { debug.push(text) },
        },
        complete: async () => answered('개선안', '', ASK_QUESTION, []),
      })
      await startQuestion(h)
      if (action === 'cancel' || action === 'replacement') await h.controller.cancel(h.ports)
      if (action === 'session') h.controller.onSessionStart('next-session')
      if (action === 'replacement') {
        await h.controller.startExplicit(h.ports, '대체 요청', 'pane')
        await h.flush()
      }
      if (action === 'accept') expect((await h.controller.accept(h.ports)).ok).toBe(true)
      if (action === 'newer-round') {
        config.maxRounds = 2
        await h.controller.retry(h.ports)
        expect(h.controller.getState().workflow?.rounds).toBe(2)
      }
      const completeBefore = h.calls.complete
      const roundLimitBefore = h.controller.getState().workflow?.roundLimit
      approval.resolve('추가 5회 허용')
      await h.waitFor(() => debug.some(line => line.includes('ignored a stale round-extension answer')))

      expect(h.calls.complete).toBe(completeBefore)
      expect(h.controller.getState().workflow?.roundLimit).toBe(roundLimitBefore)
      expect(config.maxRounds).toBe(action === 'newer-round' ? 2 : 1)
    })
  }

  test('reaching an approved limit asks again and blocks the next completion until another approval', async () => {
    const first = questionDialog()
    const second = questionDialog()
    let asks = 0
    const h = harness({
      config: { maxRounds: 1 },
      ui: { ask: (q, o) => (++asks === 1 ? first : second).ask(q, o) },
      complete: async () => answered('개선안', '', ASK_QUESTION, []),
    })
    await startQuestion(h)
    first.resolve('추가 5회 허용')
    await h.waitFor(() => h.controller.getState().workflow?.roundLimit === 6)
    for (let n = 2; n <= 6; n += 1) await h.controller.refine(h.ports, `보완 ${n}`)
    expect(h.calls.complete).toBe(6)
    expect(second.calls).toHaveLength(1)
    expect(h.controller.getState().workflow?.limitAsk).toBe('pending')
    await h.controller.retry(h.ports)
    expect(h.calls.complete).toBe(6)

    second.resolve('추가 5회 허용')
    await h.waitFor(() => h.controller.getState().workflow?.roundLimit === 11)
    expect(h.calls.complete).toBe(6)
    await h.controller.refine(h.ports, '일곱 번째 보완')
    expect(h.calls.complete).toBe(7)
  })

  test('an explicit extension works without dialogs, stays local, and does not carry into a new workflow', async () => {
    const config = { ...DEFAULT_CONFIG, maxRounds: 1 }
    const h = harness({
      deps: { getConfig: () => config },
      complete: async () => answered('개선안', '', ASK_QUESTION, []),
    })
    await startQuestion(h)
    expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
    expect(h.controller.getState().workflow?.roundLimit).toBe(6)
    expect(config.maxRounds).toBe(1)
    expect(h.calls.complete).toBe(1)
    // The current run is no longer at its limit; duplicate approval adds none.
    expect((await h.controller.extendRounds(h.ports)).ok).toBe(false)
    expect(h.controller.getState().workflow?.roundLimit).toBe(6)

    await h.controller.cancel(h.ports)
    await h.controller.startExplicit(h.ports, '새 요청', 'composer')
    await h.flush()
    expect(h.controller.getState().workflow?.original).toBe('새 요청')
    expect(Math.max(config.maxRounds, h.controller.getState().workflow?.roundLimit ?? 0)).toBe(1)
    await h.controller.refine(h.ports, '추가 승인 없는 보완')
    expect(h.calls.complete).toBe(2)
    expect(config.maxRounds).toBe(1)
  })

  test('an extension adds five to the effective current limit when configuration grows', async () => {
    const config = { ...DEFAULT_CONFIG, maxRounds: 1 }
    const h = harness({
      deps: { getConfig: () => config },
      complete: async () => answered('개선안', '', ASK_QUESTION, []),
    })
    await startQuestion(h)
    await h.controller.extendRounds(h.ports)
    config.maxRounds = 8
    for (let n = 2; n <= 8; n += 1) await h.controller.refine(h.ports, `보완 ${n}`)
    expect(h.calls.complete).toBe(8)
    expect(await h.controller.extendRounds(h.ports)).toEqual({ ok: true })
    expect(h.controller.getState().workflow?.roundLimit).toBe(13)
    expect(config.maxRounds).toBe(8)
    expect(h.calls.complete).toBe(8)
  })
})

describe('ui.ask — detached questions and pane fallback', () => {
  for (const transition of ['start', 'end'] as const) {
    test(`session ${transition} releases an unsettled ask and ignores its late answer`, async () => {
      const old = questionDialog()
      const current = questionDialog()
      const debug: string[] = []
      let asks = 0
      const h = harness({
        // Reuse every workflow identity field on start to isolate sessionId's
        // stale guard; end retains the session id and uses fresh workflow ids.
        deps: transition === 'start' ? { newId: () => 'reused-id' } : {},
        ui: { ask: (q, o) => (++asks === 1 ? old : current).ask(q, o), log: text => { debug.push(text) } },
        complete: async () => questionReply(),
      })
      await startQuestion(h)
      expect(old.calls).toHaveLength(1)
      if (transition === 'end') h.controller.onSessionEnd()
      else h.controller.onSessionStart('next-session')
      // No settlement of the old promise is needed to ask in the new session.
      await h.controller.onSubmit(h.ports, submit('새 세션의 요청'), 'pane')
      await h.flush()
      expect(current.calls).toHaveLength(1)
      const calls = h.calls.complete
      old.resolve('이전 세션의 늦은 답')
      await h.waitFor(() => debug.length === 1)
      expect(h.calls.complete).toBe(calls)
      expect(h.controller.getState().workflow?.questionAsk).toBe('pending')
      expect(h.controller.getState().workflow?.dialogue.some(m => m.text === '이전 세션의 늦은 답')).toBe(false)
      // The old settlement must not release the new dialog's slot.
      await h.controller.refine(h.ports, '패널에서 다음 라운드')
      expect(current.calls).toHaveLength(1)
      current.reject(new Error('close test dialog'))
    })
  }

  for (const answer of ['개발팀', '외부 기술 담당자']) {
    test(`asks once and refines once with ${answer}`, async () => {
      const dialog = questionDialog()
      const h = harness({ ui: { ask: dialog.ask }, complete: async (_r, _s, n) => n === 1 ? questionReply() : answered('최종안') })
      await startQuestion(h)
      expect(dialog.calls).toEqual([{ question: ASK_QUESTION, options: { options: ASK_OPTIONS, header: '보완 질문' } }])
      expect(h.controller.getState().workflow?.questionAsk).toBe('pending')
      dialog.resolve(answer)
      await h.waitFor(() => h.controller.getState().workflow?.rounds === 2)
      expect(h.calls.complete).toBe(2)
      expect(h.controller.getState().workflow?.dialogue.filter(m => m.role === 'user')).toEqual([
        { role: 'user', text: answer, decisionId: 'd1' },
      ])
    })
  }

  for (const options of [[], ['개발팀']]) {
    test(`does not pad ${options.length} options with engine Yes/No`, async () => {
      const dialog = questionDialog()
      const h = harness({ ui: { ask: dialog.ask }, complete: async () => answered('개선안', '', ASK_QUESTION, options) })
      await startQuestion(h)
      expect(dialog.calls).toHaveLength(0)
      expect(h.controller.getState().workflow?.questionAsk).toBeUndefined()
    })
  }

  test('does not ask without a question, including at the round limit', async () => {
    for (const maxRounds of [1, 5]) {
      const dialog = questionDialog()
      const h = harness({ config: { maxRounds }, ui: { ask: dialog.ask }, complete: async () => answered('개선안', '', null, ASK_OPTIONS) })
      await startQuestion(h)
      expect(dialog.calls).toHaveLength(0)
    }
  })

  test('reject keeps choices and typed refinement, without a notice or another ask', async () => {
    const dialog = questionDialog()
    const h = harness({ ui: { ask: dialog.ask }, complete: async () => questionReply() })
    await startQuestion(h)
    const notices = h.notices.filter(Boolean)
    dialog.reject(new Error('Esc / Chat about this / -p'))
    await h.waitFor(() => h.controller.getState().workflow?.questionAsk === 'closed')
    expect(h.notices.filter(Boolean)).toEqual(notices)
    expect(h.calls.complete).toBe(1)
    expect(h.controller.getState().workflow?.options).toEqual(ASK_OPTIONS)
    await h.controller.refine(h.ports, 'Pane 폴백 답변')
    expect(h.calls.complete).toBe(2)
  })

  test('synchronous ask failure silently keeps the pane fallback', async () => {
    const h = harness({ ui: { ask: () => { throw new Error('unavailable') } }, complete: async () => questionReply() })
    await startQuestion(h)
    expect(h.controller.getState().workflow?.questionAsk).toBe('closed')
    expect(h.calls.complete).toBe(1)
    expect(h.notices.filter(Boolean).some(n => n!.includes('unavailable'))).toBe(false)
  })

  for (const action of ['cancel', 'replacement', 'retry', 'pane', 'session', 'accept', 'question-change'] as const) {
    test(`ignores a late answer after ${action} without applying it to the current question`, async () => {
      const dialog = questionDialog()
      const currentDialog = questionDialog()
      const debug: string[] = []
      let asks = 0
      const h = harness({ ui: {
        ask: (q, o) => (++asks === 1 ? dialog : currentDialog).ask(q, o),
        log: text => { debug.push(text) },
      }, complete: async () => questionReply() })
      await startQuestion(h)
      if (action === 'cancel' || action === 'replacement') await h.controller.cancel(h.ports)
      if (action === 'replacement') {
        await h.controller.startExplicit(h.ports, '대체 요청', 'pane')
        await h.flush()
      }
      if (action === 'retry') await h.controller.retry(h.ports)
      if (action === 'pane') await h.controller.refine(h.ports, 'Pane 답변')
      if (action === 'session') h.controller.onSessionStart('next-session')
      if (action === 'accept') await h.controller.accept(h.ports)
      // Fault injection isolates the question-identity guard from the round guard.
      if (action === 'question-change') h.controller.getState().workflow!.question = '다른 질문인가요?'
      const calls = h.calls.complete
      expect(dialog.calls).toHaveLength(1)
      dialog.resolve('늦은 답변')
      await h.waitFor(() => debug.length === 1)
      expect(h.calls.complete).toBe(calls)
      expect(h.controller.getState().workflow?.dialogue.some(m => m.text === '늦은 답변') ?? false).toBe(false)
    })
  }

  test('composer workflows also ask', async () => {
    const dialog = questionDialog()
    const h = harness({ ui: { ask: dialog.ask }, complete: async () => questionReply() })
    await startQuestion(h, 'composer')
    expect(dialog.calls).toHaveLength(1)
  })

  for (const mode of ['pane', 'composer', 'draft', 'failure'] as const) {
    test(`restores pane focus after an answer: ${mode}`, async () => {
      const dialog = questionDialog()
      let focused = 0
      const h = harness({
        box: mode === 'draft' ? '사용자 작성 내용' : '',
        ui: { ask: dialog.ask },
        deps: { refocusPane: async () => { focused++; if (mode === 'failure') throw new Error('focus denied') } },
        complete: async (_r, _s, n) => n === 1 ? questionReply() : answered('최종안'),
      })
      await startQuestion(h, mode === 'composer' ? 'composer' : 'pane')
      dialog.resolve('개발팀')
      await h.waitFor(() => h.controller.getState().workflow?.rounds === 2)
      expect(focused).toBe(mode === 'composer' || mode === 'draft' ? 0 : 1)
      expect(h.calls.complete).toBe(2)
    })
  }
})

describe('restore — a submission racing the fill', () => {
  /** A controller whose every fill stays pending until the test resolves it. */
  function heldFill(): {
    h: Harness
    pending: { promise: Promise<PromptFilled>; resolve: (value: PromptFilled) => void }
  } {
    const pending = deferred<PromptFilled>()
    return { h: harness({ fill: () => pending.promise }), pending }
  }

  test('a submission racing a cancel restore bypasses the original instead of optimizing it again', async () => {
    const { h, pending } = heldFill()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')
    await h.flush()
    expect(h.calls.complete).toBe(1)

    const cancelling = h.controller.cancel(h.ports)
    await h.waitFor(() => h.calls.fill === 1)
    // The tentative permit is already live, before the fill settles and long
    // before the old code issued its ticket.
    expect(h.controller.getState().bypass?.text).toBe('원문 요청')

    const raced = await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')
    expect(raced).toEqual({ action: 'next', text: '원문 요청' })
    expect(h.controller.getState().bypass).toBeNull()
    // No second optimization ran: the text was released, not re-improved.
    expect(h.calls.complete).toBe(1)

    pending.resolve({ isFilled: true, text: '원문 요청', cursor: 4 })
    expect(await cancelling).toEqual({ ok: true })
    // The consumed permit must not be resurrected by the late fill.
    expect(h.controller.getState().bypass).toBeNull()
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('a submission racing a cancel restore with other text is still classified normally', async () => {
    const { h, pending } = heldFill()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')
    await h.flush()

    const cancelling = h.controller.cancel(h.ports)
    await h.waitFor(() => h.calls.fill === 1)
    expect(h.controller.getState().bypass?.text).toBe('원문 요청')

    const raced = await h.controller.onSubmit(h.ports, submit('다른 요청'), 'pane')
    expect(raced).toEqual({ action: 'drop', reason: '프롬프트를 다듬는 중입니다.' })
    expect(h.controller.getState().workflow?.original).toBe('다른 요청')

    pending.resolve({ isFilled: true, text: '원문 요청', cursor: 4 })
    expect(await cancelling).toEqual({ ok: true })
    await h.flush()
    expect(h.calls.complete).toBe(2)
  })

  test('a refused restore revokes the tentative permit', async () => {
    const { h, pending } = heldFill()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')
    await h.flush()

    const cancelling = h.controller.cancel(h.ports)
    await h.waitFor(() => h.calls.fill === 1)
    expect(h.controller.getState().bypass?.text).toBe('원문 요청')

    pending.resolve({ isFilled: false, refusal: 'dialog', text: '', cursor: 0 })
    expect((await cancelling).ok).toBe(false)
    expect(h.controller.getState().bypass).toBeNull()
  })

  test('a person edit during the restore keeps the edited permit', async () => {
    const { h, pending } = heldFill()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')
    await h.flush()

    const cancelling = h.controller.cancel(h.ports)
    await h.waitFor(() => h.calls.fill === 1)

    // A real edit moves the live permit onto the person's own correction.
    h.controller.onPromptEdit('사람이 고친 원문')
    expect(h.controller.getState().bypass?.text).toBe('사람이 고친 원문')

    pending.resolve({ isFilled: true, text: '원문 요청', cursor: 4 })
    await cancelling
    // The fill's own text must not overwrite the person's edit.
    expect(h.controller.getState().bypass?.text).toBe('사람이 고친 원문')
  })

  test('an uncontested restore adopts the fill’s own text as the permit', async () => {
    const h = harness({
      fill: input => ({ isFilled: true, text: `${input.text} (엔진 정리)`, cursor: 0 }),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')
    await h.flush()

    await h.controller.cancel(h.ports)

    expect(h.controller.getState().bypass?.text).toBe('원문 요청 (엔진 정리)')
  })

  test('a submission racing an accept transfer bypasses the draft and the run still dismisses', async () => {
    const { h, pending } = heldFill()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    const accepting = h.controller.accept(h.ports)
    await h.waitFor(() => h.calls.fill === 1)
    expect(h.controller.getState().workflow?.phase).toBe('transferring')
    expect(h.controller.getState().bypass?.text).toBe('개선된 요청')

    expect(await h.controller.onSubmit(h.ports, submit('개선된 요청'), 'pane')).toEqual({
      action: 'next',
      text: '개선된 요청',
    })
    // The running workflow stays transferring; only the permit was spent.
    expect(h.controller.getState().workflow?.phase).toBe('transferring')
    expect(h.controller.getState().bypass).toBeNull()

    pending.resolve({ isFilled: true, text: '개선된 요청', cursor: 6 })
    expect(await accepting).toEqual({ ok: true })
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.controller.getState().bypass).toBeNull()
    expect(h.calls.submit).toBe(0)
  })

  test('a submission racing a failed-round restore bypasses the original', async () => {
    const pending = deferred<PromptFilled>()
    const h = harness({ complete: async () => apiError(), fill: () => pending.promise })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')

    const running = h.flush()
    await h.waitFor(() => h.calls.fill === 1)
    expect(h.controller.getState().workflow?.phase).toBe('failed')
    expect(h.controller.getState().bypass?.text).toBe('원문 요청')

    expect(await h.controller.onSubmit(h.ports, submit('원문 요청'), 'pane')).toEqual({
      action: 'next',
      text: '원문 요청',
    })
    expect(h.controller.getState().bypass).toBeNull()

    pending.resolve({ isFilled: true, text: '원문 요청', cursor: 4 })
    await running
    expect(h.controller.getState().workflow).toBeNull()
    expect(h.controller.getState().bypass).toBeNull()
    expect(h.calls.complete).toBe(1)
  })
})

describe('refinement levels — controller selection', () => {
  const LEVELS: readonly RefinementLevel[] = ['quick', 'standard', 'deep']

  for (const level of LEVELS) {
    test(`${level} reaches the captured model request`, async () => {
      const h = harness({ model: () => 'claude-opus-5-5', config: { refinementLevel: level } })
      h.controller.onSessionStart('sess-1')

      await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
      await h.flush()

      expect(h.calls.complete).toBe(1)
      const system = requestText(h.completes[0]?.system)
      if (level === 'deep') {
        expect(system).not.toContain('[보완 수준:')
        expect(system).toContain('remaining이 0보다 크면 사용자가 정할 미결정을')
      } else {
        expect(system).toContain(`[보완 수준: ${level}]`)
        expect(system).not.toContain('remaining이 0보다 크면 사용자가 정할 미결정을')
      }
      expect(system).toContain('[고정 계약]')
    })
  }

  test('levels change only the policy, not the model, caps, timeout, effort, or rounds', async () => {
    for (const level of LEVELS) {
      const h = harness({ config: { refinementLevel: level } })
      h.controller.onSessionStart('sess-1')
      await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
      await h.flush()

      const request = h.completes[0]!
      expect(request.model).toBe('sonnet')
      expect(request.maxTokens).toBe(2048)
      expect(request.timeoutMs).toBe(30000)
      expect(request.effort).toBe('low')
      expect(requestText(request.prompt)).toContain('max: 5')
    }
  })

  test('a mid-flight level change keeps the current request and applies to the next round', async () => {
    let config: OptimizerConfig = { ...DEFAULT_CONFIG, refinementLevel: 'quick' }
    const firstCompletion = deferred<ModelCompleteResult>()
    let completions = 0
    const h = harness({
      model: () => 'claude-opus-5-5',
      deps: { getConfig: () => config },
      complete: () => {
        completions += 1
        return completions === 1
          ? firstCompletion.promise
          : Promise.resolve(answered('두 번째 개선안', '다듬었습니다'))
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    const running = h.flush()
    await h.waitFor(() => h.calls.complete === 1)

    expect(requestText(h.completes[0]?.system)).toContain('[보완 수준: quick]')
    config = { ...config, refinementLevel: 'standard' }
    firstCompletion.resolve(answered('첫 번째 개선안', '다듬었습니다'))
    await running

    // The captured round-start snapshot still owns the first request.
    expect(requestText(h.completes[0]?.system)).toContain('[보완 수준: quick]')
    expect(requestText(h.completes[0]?.system)).not.toContain('[보완 수준: standard]')

    await h.controller.refine(h.ports, '조금 더 짧게')
    expect(h.calls.complete).toBe(2)
    expect(requestText(h.completes[1]?.system)).toContain('[보완 수준: standard]')
    expect(requestText(h.completes[1]?.system)).not.toContain('[보완 수준: quick]')
  })

  test('quick keeps the unresolved-question approval and manual accept path', async () => {
    const approval = questionDialog()
    const h = harness({
      config: { refinementLevel: 'quick', maxRounds: 1 },
      ui: { ask: approval.ask },
      complete: async () => questionReply(),
    })
    await startQuestion(h)

    expect(h.controller.getState().workflow?.limitAsk).toBe('pending')
    expect(approval.calls).toHaveLength(1)
    expect(approval.calls[0]?.question).toContain('5회')
    expect(h.submits).toHaveLength(0)

    approval.reject(new Error('dismissed'))
    await h.waitFor(() => h.controller.getState().workflow?.limitAsk === 'closed')
    expect((await h.controller.accept(h.ports)).ok).toBe(true)
    expect(h.fills).toHaveLength(1)
    expect(h.submits).toHaveLength(0)
    expect(h.calls.complete).toBe(1)
  })
})
