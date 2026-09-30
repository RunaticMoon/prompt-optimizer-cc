import type { CommandRunResult, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import type { OptimizerConfig, RuntimeState, Workflow } from '../hooks/contracts'
import { DEFAULT_CONFIG } from '../hooks/contracts'
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
    expect(text).toContain('모델: sonnet')
    expect(text).toContain('시스템 프롬프트 파일: ~/p.md')
    expect(text).toContain('진행 중인 개선 작업: wf-1')
    expect(text).toContain('단계 reviewing')
    expect(text).toContain('1/3회')
    expect(text).toContain('이 세션 사용량: 2회')
    expect(text).toContain('입력 300')
    expect(text).toContain('출력 150')
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
  /** When set, the fake `$.config.set` denies with this reason. */
  configSetResult: { deny: string } | null
  /** When set, the fake `$.config.set` throws it. */
  configSetError: unknown
}

function rig(
  opts: {
    current?: Readonly<RuntimeState>
    config?: OptimizerConfig
    setResult?: { ok: false; error: string }
    configSetResult?: { deny: string }
    configSetError?: unknown
  } = {},
): Rig {
  const calls: string[] = []
  const sets: Array<[string, unknown]> = []
  const configSets: Array<[string, unknown]> = []
  const ui: Array<'pane' | 'composer'> = []
  const current = opts.current ?? liveState()
  const currentConfig = opts.config ?? config()

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
    },
    sendDraft: async () => {
      calls.push('sendDraft')
    },
    sendOriginal: async () => {
      calls.push('sendOriginal')
    },
    cancel: async () => {
      calls.push('cancel')
    },
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
    }
    return (await hook?.(stub, e)) as { text: string }
  }

  on('command.run', (_$, e) => ({ text: `base:${e.command}` }))
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
    expect(result.text).toContain('모델: sonnet')
    expect(result.text).toContain('진행 중인 개선 작업: wf-1')
    expect(r.sets).toEqual([])
    expect(r.calls).toEqual([])
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
    await run($, 'raw')
    await run($, 'cancel')
    expect(r.calls).toEqual(['accept', 'sendDraft', 'sendOriginal', 'cancel'])
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
