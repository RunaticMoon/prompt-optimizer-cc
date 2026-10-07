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

import type { EnginePorts, ModelUsage, OptimizerConfig, RuntimeState } from '../hooks/contracts'
import { DEFAULT_CONFIG } from '../hooks/contracts'
import {
  createController,
  PANE_ID,
  type ControllerDeps,
  type OptimizerController,
} from '../hooks/controller'
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
  config?: Partial<OptimizerConfig>
  /** Overrides for individual dependencies (e.g. a throwing `getConfig`). */
  deps?: Partial<ControllerDeps>
  /** Box texts returned by successive `prompt.read()` calls; '' when absent. */
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

/** One prompt-box edit in the engine's `prompt.edit` shape. */
function edit(over: Partial<RawEditFacts> = {}): RawEditFacts {
  const start = over.start ?? 0
  return { text: '', cursor: 0, start, end: over.end ?? start, inputText: '', ...over }
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

  test('keeps a last-round question as an open decision without inviting an unusable answer', async () => {
    const h = harness({
      config: { maxRounds: 1 },
      complete: async () => answered('노드 image diff API를 추가해주세요.', '초안 작성', '비교 기준은 무엇인가요?'),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('image diff API 추가'), 'composer')
    await h.flush()

    expect(h.completes[0]?.prompt).toContain('remaining: 0')
    expect(h.controller.getState().workflow?.draft).toContain('미확정 사항 (구현 전 확인):\n비교 기준은 무엇인가요?')
    expect(h.notices).not.toContain('질문: 비교 기준은 무엇인가요?')
    await h.controller.refine(h.ports, '직전 이력')
    expect(h.calls.complete).toBe(1)
    expect(h.calls.submit).toBe(0)
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

  test('folds a last-round question together with its choices', async () => {
    const h = harness({
      config: { maxRounds: 1 },
      complete: async () => answered('초안 요청', '초안 작성', '어느 쪽인가요?', ['1번', '2번']),
    })
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'composer')
    await h.flush()

    const workflow = h.controller.getState().workflow
    expect(workflow?.draft).toContain('미확정 사항 (구현 전 확인):\n어느 쪽인가요?\n- 선택지: 1번 / 2번')
    expect(workflow?.question).toBeNull()
    expect(workflow?.options).toEqual([])
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

  test('puts a refinement instruction in the request exactly once', async () => {
    const h = harness()
    h.controller.onSessionStart('sess-1')
    await h.controller.onSubmit(h.ports, submit('원문'), 'pane')
    await h.flush()

    await h.controller.refine(h.ports, '더 짧게')

    const refined = requestText(h.completes.at(-1)?.prompt)
    // The supplement is rendered once, in the dialogue; the request must not
    // also repeat it in an `<instruction>` section.
    expect(refined.split('더 짧게')).toHaveLength(2)
    expect(refined).not.toContain('<instruction>')

    await h.controller.retry(h.ports, '조금 더')

    const retried = requestText(h.completes.at(-1)?.prompt)
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
    const retried = requestText(h.completes.at(-1)?.prompt)
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
