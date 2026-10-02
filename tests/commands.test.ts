import type { CommandRunResult, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import type {
  GuidanceStatus,
  OptimizerConfig,
  RuntimeState,
  TargetModelSnapshot,
  Workflow,
} from '../hooks/contracts'
import { DEFAULT_CONFIG } from '../hooks/contracts'
import type { ActionResult } from '../hooks/controller'
import {
  OPTIMIZE_COMMAND,
  formatStatus,
  parseOptimizeArgs,
  registerCommands,
  type CommandController,
  type CommandDeps,
  type SettingsPort,
} from '../hooks/commands'

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as const

function config(over: Partial<OptimizerConfig> = {}): OptimizerConfig {
  return { ...DEFAULT_CONFIG, ...over }
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    sessionId: 'sess-1',
    generation: 1,
    phase: 'reviewing',
    original: '원본 요청',
    originalContext: [],
    draft: '초안 요청',
    context: null,
    dialogue: [],
    rounds: 1,
    ui: 'pane',
    usage: ZERO_USAGE,
    ...over,
  }
}

function liveState(over: Partial<RuntimeState> = {}): RuntimeState {
  return {
    sessionId: 'sess-1',
    workflow: workflow(),
    bypass: null,
    rawMode: null,
    usage: {
      calls: 2,
      input: 300,
      output: 150,
      cacheRead: 10,
      cacheWrite: 5,
      updatedAt: 0,
    },
    ...over,
  }
}

/** One last-applied guidance snapshot, with a matched model unless overridden. */
function guidance(
  target: Partial<TargetModelSnapshot> = {},
  over: Partial<Pick<GuidanceStatus, 'workflowId' | 'round'>> = {},
): GuidanceStatus {
  return {
    workflowId: over.workflowId ?? 'wf-1',
    round: over.round ?? 1,
    target: {
      raw: 'claude-opus-5-5[1m]',
      normalizedId: 'claude-opus-5-5',
      profile: 'opus-5-5',
      reason: 'matched',
      ...target,
    },
  }
}

describe('parseOptimizeArgs', () => {
  test('an empty argument starts from the composer draft', () => {
    expect(parseOptimizeArgs('')).toEqual({ kind: 'start' })
    expect(parseOptimizeArgs('   ')).toEqual({ kind: 'start' })
  })

  test('a plain sentence becomes the optimization text, trimmed', () => {
    expect(parseOptimizeArgs('  로그인 오류를 고쳐줘  ')).toEqual({ kind: 'start', text: '로그인 오류를 고쳐줘' })
    // The whole argument stays, not just the first token.
    expect(parseOptimizeArgs('버그를 찾아줘 그리고 테스트도')).toEqual({
      kind: 'start',
      text: '버그를 찾아줘 그리고 테스트도',
    })
  })

  test('a reserved first word selects its command, case-insensitively', () => {
    expect(parseOptimizeArgs('on')).toEqual({ kind: 'on' })
    expect(parseOptimizeArgs('OFF')).toEqual({ kind: 'off' })
    expect(parseOptimizeArgs('Accept')).toEqual({ kind: 'accept' })
    expect(parseOptimizeArgs('send')).toEqual({ kind: 'send' })
    expect(parseOptimizeArgs('RAW')).toEqual({ kind: 'raw' })
    expect(parseOptimizeArgs('Cancel')).toEqual({ kind: 'cancel' })
    expect(parseOptimizeArgs('status')).toEqual({ kind: 'status' })
    expect(parseOptimizeArgs('HELP')).toEqual({ kind: 'help' })
  })

  test('retry carries its optional instruction', () => {
    expect(parseOptimizeArgs('retry')).toEqual({ kind: 'retry' })
    expect(parseOptimizeArgs('retry  조금 더 짧게')).toEqual({ kind: 'retry', instruction: '조금 더 짧게' })
  })

  test('model needs a value', () => {
    expect(parseOptimizeArgs('model')).toEqual({
      kind: 'error',
      message: '모델 이름이 필요합니다. 예: /optimize model haiku',
    })
    expect(parseOptimizeArgs('model   ')).toEqual({
      kind: 'error',
      message: '모델 이름이 필요합니다. 예: /optimize model haiku',
    })
    expect(parseOptimizeArgs('model sonnet')).toEqual({ kind: 'model', model: 'sonnet' })
    expect(parseOptimizeArgs('MODEL claude-3-5-haiku')).toEqual({ kind: 'model', model: 'claude-3-5-haiku' })
  })

  test('a reserved word with a trailing sentence still selects the command', () => {
    // Escaping is what `--` is for.
    expect(parseOptimizeArgs('status 페이지를 고쳐줘')).toEqual({ kind: 'status' })
    expect(parseOptimizeArgs('on 하고 나서 뭐하지')).toEqual({ kind: 'on' })
  })

  test('the `--` escape always starts an optimization', () => {
    expect(parseOptimizeArgs('-- status 명령을 설명해줘')).toEqual({ kind: 'start', text: 'status 명령을 설명해줘' })
    expect(parseOptimizeArgs('--  raw  ')).toEqual({ kind: 'start', text: 'raw' })
    expect(parseOptimizeArgs('--')).toEqual({ kind: 'start' })
    // A longer token that merely begins with `--` is not the escape.
    expect(parseOptimizeArgs('--status')).toEqual({ kind: 'start', text: '--status' })
  })
})

describe('formatStatus', () => {
  test('summarizes the settings, the active run and the usage', () => {
    const text = formatStatus(
      config({ enabled: false, triggerMode: 'prefix', model: 'sonnet', systemPromptFile: '~/p.md' }),
      liveState(),
    )
    expect(text).toContain('꺼짐')
    expect(text).toContain('접두어 "?? "')
    expect(text).toContain('옵티마이저 모델: sonnet')
    expect(text).toContain('시스템 프롬프트 파일: ~/p.md')
    expect(text).toContain('그대로 보내기: 접두어 ">> " · ctrl+x enter')
    expect(text).toContain('장기 기억 문맥: 켬')
    expect(text).toContain('진행 중인 개선 작업: wf-1')
    expect(text).toContain('단계 reviewing')
    expect(text).toContain('1/3회')
    expect(text).toContain('이 세션 사용량: 2회')
    expect(text).toContain('입력 300')
    expect(text).toContain('출력 150')
  })

  test('shows the as-is send shortcut without a prefix when rawPrefix is empty', () => {
    const text = formatStatus(config({ rawPrefix: '' }), liveState())
    expect(text).toContain('그대로 보내기: ctrl+x enter')
    expect(text).not.toContain('그대로 보내기: 접두어')
  })

  test('says so when no run is active and names the last error when failed', () => {
    expect(formatStatus(config(), liveState({ workflow: null }))).toContain('진행 중인 개선 작업: 없음')
    const failed = formatStatus(config(), liveState({ workflow: workflow({ phase: 'failed', lastError: '타임아웃' }) }))
    expect(failed).toContain('단계 failed')
    expect(failed).toContain('마지막 오류: 타임아웃')
  })

  test('reports always mode and an empty system prompt file without a line for it', () => {
    const text = formatStatus(config(), liveState({ workflow: null }))
    expect(text).toContain('트리거: 항상')
    expect(text).not.toContain('시스템 프롬프트 파일')
    expect(formatStatus(config({ memoryContext: false }), liveState({ workflow: null }))).toContain('장기 기억 문맥: 끔')
  })

  test('separates the optimizer model from the model-guidance toggle', () => {
    const on = formatStatus(config({ model: 'haiku', modelGuidance: true }), liveState())
    expect(on).toContain('옵티마이저 모델: haiku · 최대 토큰')
    expect(on).toContain('모델별 지침: 켜짐')

    const off = formatStatus(config({ modelGuidance: false }), liveState())
    expect(off).toContain('모델별 지침: 꺼짐(공통 지침만 사용)')
  })

  test('reads no target before the first detection or after a reset', () => {
    expect(formatStatus(config(), liveState(), null)).toContain('마지막 최적화 대상: 아직 감지하지 않음')
    // An omitted third argument (a legacy caller) reads the same way.
    expect(formatStatus(config(), liveState())).toContain('마지막 최적화 대상: 아직 감지하지 않음')
  })

  test('shows a matched model and the applied profile', () => {
    const text = formatStatus(config(), liveState(), guidance())
    expect(text).toContain('마지막 최적화 대상: claude-opus-5-5[1m] · 적용: opus-5-5')
  })

  test('shows common and its reason for an unlisted model', () => {
    const text = formatStatus(
      config(),
      liveState(),
      guidance({ raw: 'claude-haiku-4-5-20251001', normalizedId: 'claude-haiku-4-5', profile: 'common', reason: 'unlisted' }),
    )
    expect(text).toContain('마지막 최적화 대상: claude-haiku-4-5-20251001 · 적용: common (unlisted)')
  })

  test('shows common and its reason for a bare alias', () => {
    const text = formatStatus(
      config(),
      liveState(),
      guidance({ raw: 'opus', normalizedId: null, profile: 'common', reason: 'alias' }),
    )
    expect(text).toContain('마지막 최적화 대상: opus · 적용: common (alias)')
  })

  test('shows a skipped detection when guidance was off', () => {
    const text = formatStatus(
      config({ modelGuidance: false }),
      liveState(),
      guidance({ raw: null, normalizedId: null, profile: 'common', reason: 'disabled' }),
    )
    expect(text).toContain('마지막 최적화 대상: 감지 생략 · 적용: common (disabled)')
  })

  test('shows a failed detection as unconfirmed with its reason', () => {
    const text = formatStatus(
      config(),
      liveState(),
      guidance({ raw: null, normalizedId: null, profile: 'common', reason: 'timeout' }),
    )
    expect(text).toContain('마지막 최적화 대상: 미확인 · 적용: common (timeout)')
  })

  test('treats a stored blank raw as unconfirmed, not as a model name', () => {
    const text = formatStatus(
      config(),
      liveState(),
      guidance({ raw: '   ', normalizedId: null, profile: 'common', reason: 'empty' }),
    )
    expect(text).toContain('마지막 최적화 대상: 미확인 · 적용: common (empty)')
  })

  test('flattens control characters and caps a long raw at 100 chars plus an ellipsis', () => {
    const raw = `${'a'.repeat(50)}\n${'b'.repeat(149)}`
    const text = formatStatus(
      config(),
      liveState(),
      guidance({ raw, profile: 'common', reason: 'unknown' }),
    )
    const shown = `${'a'.repeat(50)} ${'b'.repeat(49)}…`
    expect(text).toContain(`마지막 최적화 대상: ${shown} · 적용: common (unknown)`)
    // The raw newline never splits the status line.
    expect(text.split('\n').filter(line => line.startsWith('마지막 최적화 대상:'))).toHaveLength(1)
  })
})

/** Records what the command called, so each intent can be asserted once. */
interface Rig {
  deps: CommandDeps
  calls: string[]
  sets: Array<[string, unknown]>
  /** Every `$.config.set` the hook made: `[key, value]`, one per persisted row. */
  configSets: Array<[string, unknown]>
  ui: Array<'pane' | 'composer'>
  /** Which UI choice `chooseUi` answers with. */
  uiChoice: 'pane' | 'composer'
  /** What each controller action returns; success unless a test overrides one. */
  results: Record<'accept' | 'sendDraft' | 'sendOriginal' | 'cancel', ActionResult>
  /** Callbacks the deferred `$.clock.after` captured, in order. */
  scheduled: Array<() => void>
  /** Every `ui.toast` the hook made. */
  toasts: string[]
  /** Each deferred send's controller call, with the id it carried. */
  sendCalls: Array<{ method: 'draft' | 'original'; workflowId: string | undefined }>
  /** When set, the fake `ui.toast` throws, to probe the deferred catch. */
  toastThrows: boolean
  /** When set, the fake `$.config.set` resolves to it. */
  configSetResult: { value?: unknown; deny?: string } | null
  /** When set, the fake `$.config.set` throws it. */
  configSetError: unknown
}

function rig(
  opts: {
    current?: Readonly<RuntimeState>
    config?: OptimizerConfig
    setResult?: { ok: false; error: string }
    configSetResult?: { value?: unknown; deny?: string }
    configSetError?: unknown
    results?: Partial<Record<'accept' | 'sendDraft' | 'sendOriginal' | 'cancel', ActionResult>>
    /**
     * When the key is present, the controller exposes `getGuidanceStatus`
     * (returning this value); when absent, the controller is the legacy facade.
     */
    guidance?: Readonly<GuidanceStatus> | null
  } = {},
): Rig {
  const calls: string[] = []
  const sets: Array<[string, unknown]> = []
  const configSets: Array<[string, unknown]> = []
  const ui: Array<'pane' | 'composer'> = []
  const scheduled: Array<() => void> = []
  const toasts: string[] = []
  const sendCalls: Array<{ method: 'draft' | 'original'; workflowId: string | undefined }> = []
  const current = opts.current ?? liveState()
  const currentConfig = opts.config ?? config()
  const results: Record<'accept' | 'sendDraft' | 'sendOriginal' | 'cancel', ActionResult> = {
    accept: { ok: true },
    sendDraft: { ok: true },
    sendOriginal: { ok: true },
    cancel: { ok: true },
    ...opts.results,
  }

  const controller: CommandController = {
    getState: () => current,
    startExplicit: async (_ports, text, choice) => {
      calls.push(`startExplicit(${text ?? ''},${choice})`)
    },
    refine: async (_ports, instruction) => {
      calls.push(`refine(${instruction})`)
    },
    retry: async (_ports, instruction) => {
      calls.push(instruction === undefined ? 'retry()' : `retry(${instruction})`)
    },
    accept: async () => {
      calls.push('accept')
      return results.accept
    },
    sendDraft: async (_ports, workflowId) => {
      calls.push('sendDraft')
      sendCalls.push({ method: 'draft', workflowId })
      return results.sendDraft
    },
    sendOriginal: async (_ports, workflowId) => {
      calls.push('sendOriginal')
      sendCalls.push({ method: 'original', workflowId })
      return results.sendOriginal
    },
    cancel: async () => {
      calls.push('cancel')
      return results.cancel
    },
  }
  if ('guidance' in opts) {
    const stored = opts.guidance ?? null
    controller.getGuidanceStatus = () => {
      calls.push('getGuidanceStatus')
      return stored
    }
  }

  const settings: SettingsPort = {
    get: () => currentConfig,
    set: async (key, value) => {
      sets.push([key, value])
      return opts.setResult ?? { ok: true }
    },
  }

  const self: Rig = {
    calls,
    sets,
    configSets,
    ui,
    uiChoice: 'pane',
    results,
    scheduled,
    toasts,
    sendCalls,
    toastThrows: false,
    configSetResult: opts.configSetResult ?? null,
    configSetError: opts.configSetError,
    deps: {
      controller,
      settings,
      chooseUi: async () => {
        ui.push(self.uiChoice)
        return self.uiChoice
      },
    },
  }
  return self
}

/**
 * The `command.run` hook `registerCommands` registers, captured so the test
 * drives it directly. Since task L wires the same event from the loaded plugin
 * (whose hooks sit above the test's own), dispatching through `$.command.run`
 * would answer with the plugin's real handler, not this rig; capturing keeps
 * the unit isolated.
 */
let wired: ((args: string) => Promise<{ text: string }>) | null = null

/**
 * Registers the `/optimize` hook into a capturer and a base `command.run`
 * beneath it (kept for the pass-through test, which goes through the engine).
 *
 * The hook is driven with a stub `$` carrying only `config.set`, the one member
 * the hook itself reaches; the ports it builds are lazy, so the stubbed
 * controller never reads the rest.
 */
function wire(on: On, r: Rig): void {
  let hook: ((...args: unknown[]) => unknown) | undefined
  const capturing = ((_event: string, ...rest: unknown[]) => {
    hook = rest[rest.length - 1] as (...args: unknown[]) => unknown
    return { catch: () => undefined }
  }) as unknown as On
  registerCommands(capturing, r.deps)

  wired = async args => {
    const e = {
      command: OPTIMIZE_COMMAND.name,
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    }
    const stub = {
      config: {
        set: async (input: { key: string; value: unknown }) => {
          r.configSets.push([input.key, input.value])
          if (r.configSetError !== undefined) throw r.configSetError
          return r.configSetResult ?? { value: input.value }
        },
      },
      // Spies that would record a port read if `status` (or any intent) made
      // one. `status` must answer without touching the model ports.
      session: {
        model: () => {
          r.calls.push('session.model')
          return 'spy-model'
        },
      },
      model: {
        complete: () => {
          r.calls.push('model.complete')
          return Promise.resolve({})
        },
      },
      // The deferred send path reads these; a callback is queued, never run,
      // until the test flushes it, so ordering against the command return is
      // observable.
      clock: {
        after: (_ms: number, fn: () => void) => {
          r.scheduled.push(fn)
          return { cancel: () => undefined }
        },
      },
      ui: {
        toast: (text: string) => {
          if (r.toastThrows) throw new Error('toast failed')
          r.toasts.push(text)
        },
      },
    }
    return (await hook?.(stub, e)) as { text: string }
  }

  on('command.run', (_$, e) => ({ text: `base:${e.command}` }))
}

/** Runs every callback a deferred send queued, letting its promise settle. */
async function flushScheduled(r: Rig): Promise<void> {
  while (r.scheduled.length > 0) {
    const fn = r.scheduled.shift() as () => void
    fn()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
}

/** Runs `/optimize <args>` through the captured hook. */
function run(_$: Engine, args: string): Promise<CommandRunResult> {
  return wired!(args) as unknown as Promise<CommandRunResult>
}

describe('registerCommands — settings intents', () => {
  test('on writes the enabled flag and persists the row', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, 'on')
    expect(result.text).toBe('자동 가로채기를 켰습니다.\n설정에 저장했습니다.')
    expect(r.sets).toEqual([['enabled', true]])
    expect(r.configSets).toEqual([['prompt-optimizer.enabled', true]])
  })

  test('off clears the enabled flag and persists the row', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, 'off')
    expect(result.text).toBe('자동 가로채기를 껐습니다.\n설정에 저장했습니다.')
    expect(r.sets).toEqual([['enabled', false]])
    expect(r.configSets).toEqual([['prompt-optimizer.enabled', false]])
  })

  test('model writes the trimmed value and persists it', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, 'model  sonnet ')
    expect(r.sets).toEqual([['model', 'sonnet']])
    expect(r.configSets).toEqual([['prompt-optimizer.model', 'sonnet']])
    expect(result.text).toBe('옵티마이저 모델을 "sonnet"로 설정했습니다.\n설정에 저장했습니다.')
  })

  test('model reports a refused write and persists nothing', async ($, on) => {
    const r = rig({ setResult: { ok: false, error: 'unknown model' } })
    wire(on, r)
    const result = await run($, 'model nope')
    expect(r.sets).toEqual([['model', 'nope']])
    expect(r.configSets).toEqual([])
    expect(result.text).toBe('모델을 바꾸지 못했습니다: unknown model')
  })

  test('a denied persistent write notes the setting is session-only', async ($, on) => {
    const r = rig({ configSetResult: { deny: 'managed by policy' } })
    wire(on, r)
    const result = await run($, 'off')
    expect(r.configSets).toEqual([['prompt-optimizer.enabled', false]])
    expect(result.text).toBe('자동 가로채기를 껐습니다.\n이번 세션에만 적용됨(managed by policy)')
  })

  test('a thrown persistent write is reported as session-only, never escaping', async ($, on) => {
    const r = rig({ configSetError: new Error('settings are read-only') })
    wire(on, r)
    const result = await run($, 'model sonnet')
    expect(r.configSets).toEqual([['prompt-optimizer.model', 'sonnet']])
    expect(result.text).toBe(
      '옵티마이저 모델을 "sonnet"로 설정했습니다.\n이번 세션에만 적용됨(settings are read-only)',
    )
  })

  test('a persistent write carrying deny: undefined still counts as saved', async ($, on) => {
    // The engine may resolve a write as `{ value, deny: undefined }`; only a
    // string `deny` is a refusal, so this must not read as session-only.
    const r = rig({ configSetResult: { value: true, deny: undefined } })
    wire(on, r)
    const result = await run($, 'on')
    expect(result.text).toBe('자동 가로채기를 켰습니다.\n설정에 저장했습니다.')
    expect(r.configSets).toEqual([['prompt-optimizer.enabled', true]])
  })

  test('model without a value never writes and returns the usage error', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, 'model')
    expect(r.sets).toEqual([])
    expect(result.text).toContain('사용법 오류')
    expect(result.text).toContain('모델 이름이 필요합니다')
  })

  test('status reads the settings and controller state without a model call', async ($, on) => {
    const r = rig({ config: config({ model: 'sonnet' }) })
    wire(on, r)
    const result = await run($, 'status')
    expect(result.text).toContain('옵티마이저 모델: sonnet')
    expect(result.text).toContain('진행 중인 개선 작업: wf-1')
    expect(result.text).toContain('마지막 최적화 대상: 아직 감지하지 않음')
    expect(r.sets).toEqual([])
    // A controller without `getGuidanceStatus` (the legacy facade) still works.
    expect(r.calls).toEqual([])
  })

  test('status shows the last applied target from the stored guidance', async ($, on) => {
    const r = rig({ guidance: guidance() })
    wire(on, r)
    const result = await run($, 'status')
    expect(result.text).toContain('마지막 최적화 대상: claude-opus-5-5[1m] · 적용: opus-5-5')
    expect(r.sets).toEqual([])
    // One stored-state read; no session.model or model.complete call.
    expect(r.calls).toEqual(['getGuidanceStatus'])
  })

  test('status shows a skipped detection when the stored snapshot is disabled', async ($, on) => {
    const r = rig({
      config: config({ modelGuidance: false }),
      guidance: guidance({ raw: null, normalizedId: null, profile: 'common', reason: 'disabled' }),
    })
    wire(on, r)
    const result = await run($, 'status')
    expect(result.text).toContain('모델별 지침: 꺼짐(공통 지침만 사용)')
    expect(result.text).toContain('마지막 최적화 대상: 감지 생략 · 적용: common (disabled)')
    expect(r.calls).toEqual(['getGuidanceStatus'])
  })

  test('status treats a null stored guidance as not yet detected', async ($, on) => {
    const r = rig({ guidance: null })
    wire(on, r)
    const result = await run($, 'status')
    expect(result.text).toContain('마지막 최적화 대상: 아직 감지하지 않음')
    expect(r.calls).toEqual(['getGuidanceStatus'])
  })

  test('help lists the commands without touching controller or settings', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, 'help')
    expect(result.text).toContain('/optimize accept')
    expect(result.text).toContain('/optimize model <id>')
    expect(r.sets).toEqual([])
    expect(r.calls).toEqual([])
  })
})

describe('registerCommands — controller intents', () => {
  test('a plain sentence starts an explicit run with the chosen UI', async ($, on) => {
    const r = rig()
    r.uiChoice = 'composer'
    wire(on, r)
    const result = await run($, '로그인 오류를 고쳐줘')
    expect(r.calls).toEqual(['startExplicit(로그인 오류를 고쳐줘,composer)'])
    expect(r.ui).toEqual(['composer'])
    expect(result.text).toBe('입력한 텍스트로 개선을 시작합니다.')
  })

  test('a bare command starts from the composer draft', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, '')
    expect(r.calls).toEqual(['startExplicit(,pane)'])
    expect(result.text).toBe('현재 입력창 초안으로 개선을 시작합니다.')
  })

  test('accept, send, raw and cancel each call their controller method once', async ($, on) => {
    const r = rig()
    wire(on, r)
    await run($, 'accept')
    await run($, 'send')
    await flushScheduled(r)
    await run($, 'raw')
    await flushScheduled(r)
    await run($, 'cancel')
    expect(r.calls).toEqual(['accept', 'sendDraft', 'sendOriginal', 'cancel'])
  })

  test('send and raw defer the controller call until after the command returns', async ($, on) => {
    const r = rig()
    wire(on, r)

    const sent = await run($, 'send')
    expect(sent.text).toBe('개선안 전송을 예약했습니다.')
    // Nothing yet: a submit made inside `command.run` would be refused.
    expect(r.calls).toEqual([])
    await flushScheduled(r)
    expect(r.calls).toEqual(['sendDraft'])

    const raw = await run($, 'raw')
    expect(raw.text).toBe('원문 전송을 예약했습니다.')
    expect(r.calls).toEqual(['sendDraft'])
    await flushScheduled(r)
    expect(r.calls).toEqual(['sendDraft', 'sendOriginal'])
  })

  test('a run mid-flight is refused synchronously and never scheduled', async ($, on) => {
    const r = rig({ current: liveState({ workflow: workflow({ phase: 'sending' }) }) })
    wire(on, r)
    for (const args of ['send', 'raw']) {
      expect((await run($, args)).text).toBe('개선 작업을 처리하는 중입니다.')
    }
    expect(r.scheduled).toEqual([])
    expect(r.calls).toEqual([])
  })

  test('an empty draft or original is refused synchronously and never scheduled', async ($, on) => {
    const emptyDraft = rig({ current: liveState({ workflow: workflow({ draft: '' }) }) })
    wire(on, emptyDraft)
    expect((await run($, 'send')).text).toBe('전송할 개선안이 없습니다.')
    expect(emptyDraft.scheduled).toEqual([])

    const emptyOriginal = rig({ current: liveState({ workflow: workflow({ original: '' }) }) })
    wire(on, emptyOriginal)
    expect((await run($, 'raw')).text).toBe('전송할 원문이 없습니다.')
    expect(emptyOriginal.scheduled).toEqual([])
  })

  test('a deferred controller refusal toasts only the in-flight reason', async ($, on) => {
    const inFlight = rig({ results: { sendDraft: { ok: false, reason: '개선 작업을 처리하는 중입니다.' } } })
    wire(on, inFlight)
    await run($, 'send')
    await flushScheduled(inFlight)
    expect(inFlight.toasts).toEqual(['개선 작업을 처리하는 중입니다.'])

    // Every other failure is already notified by the controller: no second toast.
    const other = rig({ results: { sendDraft: { ok: false, reason: '전송이 차단되었습니다: no target' } } })
    wire(on, other)
    await run($, 'send')
    await flushScheduled(other)
    expect(other.toasts).toEqual([])
  })

  test('a deferred send that throws toasts the failure and does not escape', async ($, on) => {
    const r = rig()
    r.deps.controller.sendDraft = async () => {
      throw new Error('boom')
    }
    wire(on, r)
    await run($, 'send')
    await flushScheduled(r)
    expect(r.toasts).toEqual(['전송에 실패했습니다: boom'])
  })

  test('a deferred send carries the workflow id captured at command time', async ($, on) => {
    const r = rig()
    wire(on, r)

    const sent = await run($, 'send')
    expect(sent.text).toBe('개선안 전송을 예약했습니다.')
    // A different run replaces the captured one before the callback runs; the
    // deferred call must still name the run the person sent from.
    r.deps.controller.getState = () => liveState({ workflow: workflow({ id: 'wf-2' }) })
    await flushScheduled(r)

    expect(r.sendCalls).toEqual([{ method: 'draft', workflowId: 'wf-1' }])
  })

  test('a throwing toast sink is contained and never becomes an unhandled rejection', async ($, on) => {
    const r = rig({ results: { sendDraft: { ok: false, reason: '개선 작업을 처리하는 중입니다.' } } })
    r.toastThrows = true
    wire(on, r)

    await run($, 'send')
    await flushScheduled(r)

    expect(r.toasts).toEqual([])
  })

  test('successful actions keep their success lines', async ($, on) => {
    const r = rig()
    wire(on, r)
    expect((await run($, 'accept')).text).toBe(
      '개선안을 입력창으로 가져왔습니다. 내용을 확인하고 Enter를 누르세요.',
    )
    expect((await run($, 'send')).text).toBe('개선안 전송을 예약했습니다.')
    await flushScheduled(r)
    expect((await run($, 'raw')).text).toBe('원문 전송을 예약했습니다.')
    await flushScheduled(r)
    expect((await run($, 'cancel')).text).toBe('개선 작업을 취소했습니다.')
  })

  test('a refused cancel answers with the controller reason, not a success', async ($, on) => {
    // A cancel during a transfer is refused by the controller; the command must
    // relay that reason instead of its blanket "취소했습니다." line.
    const r = rig({ results: { cancel: { ok: false, reason: '전송 중이라 취소할 수 없습니다' } } })
    wire(on, r)
    const result = await run($, 'cancel')
    expect(r.calls).toEqual(['cancel'])
    expect(result.text).toBe('전송 중이라 취소할 수 없습니다')
  })

  test('a refused accept answers with the controller reason; a deferred send refuses via toast', async ($, on) => {
    const r = rig({
      results: {
        accept: { ok: false, reason: '입력창이 개선안을 거부했습니다' },
        sendDraft: { ok: false, reason: '전송이 차단되었습니다: no target' },
        sendOriginal: { ok: false, reason: '전송에 실패했습니다: boom' },
      },
    })
    wire(on, r)
    expect((await run($, 'accept')).text).toBe('입력창이 개선안을 거부했습니다')
    // send/raw answer with the deferral line; a blocked send surfaces no second
    // toast because the controller already notified the reason.
    expect((await run($, 'send')).text).toBe('개선안 전송을 예약했습니다.')
    expect((await run($, 'raw')).text).toBe('원문 전송을 예약했습니다.')
    await flushScheduled(r)
    expect(r.calls).toEqual(['accept', 'sendDraft', 'sendOriginal'])
    expect(r.toasts).toEqual([])
  })

  test('retry passes the instruction, or none when absent', async ($, on) => {
    const r = rig()
    wire(on, r)
    await run($, 'retry 더 짧게')
    await run($, 'retry')
    expect(r.calls).toEqual(['retry(더 짧게)', 'retry()'])
  })

  test('an active-workflow command with no run says so and calls nothing', async ($, on) => {
    const r = rig({ current: liveState({ workflow: null }) })
    wire(on, r)
    for (const args of ['accept', 'send', 'raw', 'cancel', 'retry']) {
      const result = await run($, args)
      expect(result.text).toContain('진행 중인 개선 작업이 없습니다')
    }
    expect(r.calls).toEqual([])
    expect(r.sets).toEqual([])
  })

  test('a controller throw becomes one error line and does not escape', async ($, on) => {
    const r = rig()
    r.deps.controller.accept = async () => {
      throw new Error('controller exploded')
    }
    wire(on, r)
    const result = await run($, 'accept')
    expect(result.text).toBe('오류: controller exploded')
  })
})

describe('registerCommands — result shape and pass-through', () => {
  test('the result carries text only, never a context for the main model', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await run($, 'on')
    // `ref` is the engine's own run tag; what must never appear is `context`.
    expect(result.text).toBe('자동 가로채기를 켰습니다.\n설정에 저장했습니다.')
    expect(result.context).toBeUndefined()
    expect('context' in result).toBe(false)
  })

  test('another command passes through to the hooks beneath', async ($, on) => {
    const r = rig()
    wire(on, r)
    const result = await $.command.run({
      command: 'other',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(result.text).toBe('base:other')
    expect(r.calls).toEqual([])
    expect(r.sets).toEqual([])
  })
})
