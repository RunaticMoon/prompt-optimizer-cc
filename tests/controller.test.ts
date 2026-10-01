import type {
  ModelCompleteRequest,
  ModelCompleteResult,
  PromptFillArgs,
  PromptFilled,
  PromptSubmitArgs,
  PromptSubmitInput,
  PromptSubmitResult,
  SessionMessage,
} from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { EnginePorts, ModelUsage, OptimizerConfig, RuntimeState } from '../hooks/contracts'
import { DEFAULT_CONFIG } from '../hooks/contracts'
import {
  createController,
  PANE_ID,
  type ControllerDeps,
  type OptimizerController,
} from '../hooks/controller'

const USAGE: ModelUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1,
  cache_creation_input_tokens: 2,
}

/** An answered completion carrying the fixed JSON contract. */
function answered(draft: string, message = '', question: string | null = null): ModelCompleteResult {
  return { isAnswered: true, text: JSON.stringify({ draft, message, question }), usage: USAGE }
}

/** A failed completion, the API-error arm. */
function apiError(): ModelCompleteResult {
  return { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE }
}

/** One engine call each, counted so a test can assert what ran and how often. */
interface Calls {
  messages: number
  cwd: number
  root: number
  repo: number
  stat: number
  fileRead: number
  complete: number
  fork: number
  promptRead: number
  fill: number
  submit: number
  close: number
}

interface HarnessOptions {
  config?: Partial<OptimizerConfig>
  /** Overrides for individual dependencies (e.g. a throwing `getConfig`). */
  deps?: Partial<ControllerDeps>
  /** Box texts returned by successive `prompt.read()` calls; '' when absent. */
  box?: string | readonly string[]
  messages?: readonly SessionMessage[]
  files?: Readonly<Record<string, string>>
  complete?: (
    request: ModelCompleteRequest,
    signal: AbortSignal | undefined,
    call: number,
  ) => Promise<ModelCompleteResult>
  fill?: (input: PromptFillArgs) => PromptFilled | Promise<PromptFilled>
  submit?: (input: PromptSubmitArgs) => PromptSubmitResult | Promise<PromptSubmitResult>
  now?: number
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

  const queue: Array<() => unknown> = []
  const notices: Array<string | undefined> = []
  const changes: RuntimeState[] = []
  const calls: Calls = {
    messages: 0,
    cwd: 0,
    root: 0,
    repo: 0,
    stat: 0,
    fileRead: 0,
    complete: 0,
    fork: 0,
    promptRead: 0,
    fill: 0,
    submit: 0,
    close: 0,
  }
  const fills: PromptFillArgs[] = []
  const submits: PromptSubmitArgs[] = []
  const closes: string[] = []
  const completes: ModelCompleteRequest[] = []
  const signals: Array<AbortSignal | undefined> = []
  const flags = { throwOnRepaint: false }
  const boxes: string[] =
    options.box === undefined
      ? []
      : typeof options.box === 'string'
        ? [options.box]
        : [...options.box]
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
    },
    fs: {
      stat: async (path: string) => {
        calls.stat += 1
        const text = files[path]
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false }
      },
      read: async (path: string) => {
        calls.fileRead += 1
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
        const text = boxes.shift() ?? ''
        return { text, cursor: text.length }
      },
      fill: async (input: PromptFillArgs): Promise<PromptFilled> => {
        calls.fill += 1
        fills.push(input)
        if (options.fill !== undefined) return options.fill(input)
        return { isFilled: true, text: input.text, cursor: input.text.length }
      },
      submit: async (input: PromptSubmitArgs): Promise<PromptSubmitResult> => {
        calls.submit += 1
        submits.push(input)
        if (options.submit !== undefined) return options.submit(input)
        return { text: input.text }
      },
    },
    ui: {
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

  return {
    controller: createController(deps),
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

  test('strips the raw prefix and passes the rest through', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const outcome = await h.controller.onSubmit(h.ports, submit('::raw 그냥 보내기'), 'pane')

    expect(outcome).toEqual({ action: 'next', text: '그냥 보내기' })
    expect(h.controller.getState().workflow).toBeNull()
  })

  test('drops a raw escape whose remainder is blank', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')

    const spaces = await h.controller.onSubmit(h.ports, submit('::raw    '), 'pane')
    expect(spaces).toEqual({ action: 'drop', reason: '보낼 내용이 없습니다.' })
    expect(h.controller.getState().workflow).toBeNull()

    // A bare marker leaves an empty remainder; the classifier returns it as a
    // raw decision too (task S), and the trim guard drops it rather than
    // forwarding the marker to the main session.
    const empty = await h.controller.onSubmit(h.ports, submit('::raw '), 'pane')
    expect(empty).toEqual({ action: 'drop', reason: '보낼 내용이 없습니다.' })
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

describe('refine — the improvement dialogue', () => {
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

  test('puts a refinement instruction in the request exactly once', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.refine(h.ports, '더 짧게')

    const refined = h.completes.at(-1)?.prompt ?? ''
    // The supplement is rendered once, in the dialogue; the request must not
    // also repeat it in an `<instruction>` section.
    expect(refined.split('더 짧게')).toHaveLength(2)
    expect(refined).not.toContain('<instruction>')

    await h.controller.retry(h.ports, '조금 더')

    const retried = h.completes.at(-1)?.prompt ?? ''
    expect(retried.split('조금 더')).toHaveLength(2)
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

    // The supplement is already in the dialogue; a bare retry must not also
    // re-render it as the `<instruction>` section.
    const retried = h.completes.at(-1)?.prompt ?? ''
    expect(retried.split('더 짧게')).toHaveLength(2)
    expect(retried).not.toContain('<instruction>')
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

describe('readMemory — long-term memory folded into the snapshot', () => {
  test('reads the rendered memory once per run and folds it into the first snapshot', async () => {
    let reads = 0
    const h = harness({
      deps: {
        readMemory: () => {
          reads += 1
          return '### Injected at session start\n세션 기억'
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(reads).toBe(1)
    const context = h.controller.getState().workflow?.context
    expect(context?.memory).toContain('세션 기억')
    expect(context?.text).toContain('## Long-term memory')
    expect(context?.text).toContain('세션 기억')
    expect(h.completes[0]?.prompt).toContain('## Long-term memory')
    expect(h.completes[0]?.prompt).toContain('세션 기억')

    // The snapshot is read once: a later round reuses it, never re-reads.
    await h.controller.refine(h.ports, '더 짧게')
    expect(reads).toBe(1)
  })

  test('omits the memory when memoryContext is off', async () => {
    let reads = 0
    const h = harness({
      config: { memoryContext: false },
      deps: {
        readMemory: () => {
          reads += 1
          return '숨겨야 할 기억'
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(reads).toBe(1)
    expect(h.controller.getState().workflow?.context?.memory).toBe('')
    expect(h.completes[0]?.prompt).not.toContain('숨겨야 할 기억')
    expect(h.completes[0]?.prompt).not.toContain('## Long-term memory')
  })

  test('treats a throwing reader as no memory and keeps the round going', async () => {
    const h = harness({
      deps: {
        readMemory: () => {
          throw new Error('memory unavailable')
        },
      },
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(h.calls.messages).toBe(1)
    expect(h.calls.complete).toBe(1)
    const workflow = h.controller.getState().workflow
    expect(workflow?.phase).toBe('reviewing')
    expect(workflow?.context?.memory).toBe('')
  })

  test('an absent reader leaves the memory section off the snapshot', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    expect(h.controller.getState().workflow?.context?.memory).toBe('')
    expect(h.completes[0]?.prompt).not.toContain('## Long-term memory')
  })
})
