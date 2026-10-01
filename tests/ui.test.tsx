import type { EngineInterface, On, RenderInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import type { OptimizerController } from '../hooks/controller'
import { PANE_ID } from '../hooks/controller'
import { DEFAULT_CONFIG, type RuntimeState, type Workflow } from '../hooks/contracts'
import { createPresenter } from '../hooks/ui/present'
import { handlePaneClose, registerUi } from '../hooks/ui/register'
import { paneOpenArgs, type UiPorts } from '../hooks/ui/ui-ports'

const PANE: RenderInput<'Pane', 'terminal'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PANE_ID,
  viewport: { columns: 110, rows: 40 },
  props: {
    title: '프롬프트 옵티마이저',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

function workflow(phase: Workflow['phase'] = 'reviewing'): Workflow {
  return {
    id: 'workflow-1', sessionId: 'session-1', generation: 0, phase,
    original: '원래 요청', originalContext: [], draft: '한국어로 작성한 개선안입니다.',
    context: null, dialogue: [{ role: 'optimizer', text: '추가 조건이 있나요?' }],
    rounds: 1, ui: 'pane',
    usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
  }
}

function state(item: Workflow | null): RuntimeState {
  return {
    sessionId: 'session-1', workflow: item, bypass: null,
    usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, updatedAt: 0 },
  }
}

function fakeController(current: RuntimeState) {
  const calls: string[] = []
  const controller = {
    getState: () => current,
    refine: async (_ports: unknown, text: string) => { calls.push(`refine:${text}`) },
    retry: async () => { calls.push('retry') },
    accept: async () => { calls.push('accept') },
    sendDraft: async () => { calls.push('sendDraft') },
    sendOriginal: async () => { calls.push('sendOriginal') },
    cancel: async () => { calls.push('cancel') },
  } as unknown as OptimizerController
  return { controller, calls }
}

function textOf(tree: unknown): string {
  return JSON.stringify(tree)
}

/** A hook the capturer stored, callable with the engine's `$`. */
type CapturedHook = (...args: unknown[]) => unknown

/**
 * Registers the UI into a capturer and hands back the hooks, so the test drives
 * them directly. Task L now wires the same events from the loaded plugin (whose
 * hooks sit above the test's own), so a `$.ui.render`/`press`/`input` dispatch
 * would reach the plugin's real handler; capturing keeps this unit isolated.
 *
 * `ui.render`'s hook calls `$.ui.resolve(e)`, available only on the hook-side
 * `$`; the probe session.start hook captures one so the render hook can draw.
 */
async function captureUi($: Engine, on: On, controller: OptimizerController, omittedControl?: 'Button' | 'Input'): Promise<{
  render: (e: RenderInput<'Pane'>) => Promise<unknown>
  press: (e: unknown) => Promise<unknown>
  input: (e: unknown) => Promise<unknown>
}> {
  let hook$: unknown
  on('session.start', (_$, e) => {
    hook$ = _$
    return { cwd: e.cwd }
  })
  await $.session.start({ cwd: '/tmp/prompt-optimizer-ui', surface: 'terminal', isInteractive: true })

  const hooks = new Map<string, CapturedHook>()
  const capturing = ((event: string, ...rest: unknown[]) => {
    hooks.set(event, rest[rest.length - 1] as CapturedHook)
    return { catch: () => undefined }
  }) as unknown as On
  registerUi(capturing, controller, () => 3, 'test')

  const call = (event: string, e: unknown): Promise<unknown> => {
    const hook = hooks.get(event)
    if (hook === undefined) throw new Error(`no ${event} hook was registered`)
    const engine = event === 'ui.render' && omittedControl
      ? {
          ui: {
            resolve: async (input: RenderInput<'Pane'>) => {
              const table = await (hook$ as EngineInterface).ui.resolve(input)
              return { ...table, [omittedControl]: undefined }
            },
          },
        }
      : hook$
    return Promise.resolve(hook(engine, e, (inner: unknown) => ({ inner })))
  }
  return {
    render: e => call('ui.render', e),
    press: e => call('ui.press', e),
    input: e => call('ui.input', e),
  }
}

describe('optimizer UI', () => {
  test('pane describes each phase and an empty workflow', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)

    for (const [phase, label] of [
      ['collecting', '수집 중'], ['generating', '생성 중'], ['reviewing', '검토'],
      ['failed', '실패'], ['transferring', '전달 중'], ['sending', '전송 중'],
    ] as const) {
      current.workflow = { ...workflow(phase), lastError: phase === 'failed' ? '네트워크 오류' : undefined }
      const drawn = textOf(await ui.render(PANE))
      expect(drawn).toContain(label)
      expect(drawn).toContain('1/3회')
      expect(drawn).toContain('10토큰')
      expect(drawn).toContain('한국어로 작성한 개선안입니다.')
      if (phase === 'failed') expect(drawn).toContain('네트워크 오류')
    }

    current.workflow = null
    expect(textOf(await ui.render(PANE))).toContain('진행 중인 개선 작업이 없습니다')
    current.workflow = { ...workflow(), ui: 'composer' }
    expect(textOf(await ui.render(PANE))).toContain('개선 대화는 입력창에서 진행 중입니다')
  })

  test('placed desktop and VS Code panes render the workflow', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    for (const surface of ['desktop', 'vscode'] as const) {
      const drawn = textOf(await ui.render({ ...PANE, surface }))
      expect(drawn).toContain('프롬프트 옵티마이저')
      expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    }
  })

  test('a pane without Button offers command actions in text', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller, 'Button')
    const drawn = textOf(await ui.render({ ...PANE, surface: 'desktop' }))
    expect(drawn).toContain('검토')
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    expect(drawn).toContain('/optimize accept · send · raw · cancel · retry <보완>')
  })

  test('mobile table without Input keeps buttons and shows the retry command', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller, 'Input')
    const drawn = textOf(await ui.render({ ...PANE, surface: 'mobile' }))
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    for (const label of ['입력창으로 가져오기', '바로 보내기', '원문 보내기', '다시 다듬기', '취소']) {
      expect(drawn).toContain(label)
    }
    expect(drawn).toContain('/optimize retry <보완 내용>')
    expect(drawn).not.toContain('명령: /optimize accept')
  })

  test('pane buttons expose visible digit hotkeys and focus guidance in both layouts', async ($, on) => {
    const item = workflow()
    item.original = '긴 원문 '.repeat(40)
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)

    for (const columns of [80, 110]) {
      const pane = { ...PANE, viewport: { columns, rows: 40 } }
      const drawn = textOf(await ui.render(pane))
      for (const [digit, label] of [
        ['1', '입력창으로 가져오기'], ['2', '바로 보내기'],
        ['3', '원문 보내기'], ['4', '다시 다듬기'], ['5', '취소'],
      ]) {
        expect(drawn).toContain(`"hotkey":"${digit}"`)
        expect(drawn).toContain(`"label":"${digit}: ${label}"`)
      }
      expect(drawn).toContain('"hotkey":"0"')
      expect(drawn).toContain('"plain":true')
      expect(drawn).toContain('"label":"원문 전체 보기"')
      expect(drawn).not.toContain('"label":"0:')
      expect(drawn).toContain('숫자키 실행 · Tab 이동 · Enter 선택 · Esc 닫기')
      expect(drawn).not.toContain('ctrl+x tab으로 포커스')

      const unfocused = textOf(await ui.render({ ...pane, props: { ...PANE.props, isFocused: false } }))
      expect(unfocused).toContain('ctrl+x tab으로 포커스')
    }

    current.workflow = workflow('generating')
    const disabled = textOf(await ui.render(PANE))
    for (const label of ['1: 입력창으로 가져오기', '2: 바로 보내기', '3: 원문 보내기', '4: 다시 다듬기']) {
      expect(disabled).toContain(`${label} · 사용 불가`)
    }

    current.workflow = { ...item, phase: 'sending' }
    for (const columns of [80, 110]) {
      const sending = textOf(await ui.render({ ...PANE, viewport: { columns, rows: 40 } }))
      expect(sending).toContain('5: 취소 · 사용 불가')
      expect(sending).toContain('0: 원문 전체 보기 · 사용 불가')
    }
  })

  test('expanded original keeps its plain label when the toggle becomes unavailable', async ($, on) => {
    const item = workflow()
    item.original = '긴 원문 '.repeat(40)
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)

    for (const columns of [80, 110]) {
      const pane = { ...PANE, viewport: { columns, rows: 40 } }
      await ui.render(pane)
      await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })

      const expanded = textOf(await ui.render(pane))
      expect(expanded).toContain('"hotkey":"0"')
      expect(expanded).toContain('"plain":true')
      expect(expanded).toContain('"label":"원문 접기"')
      expect(expanded).not.toContain('"label":"0:')
      expect(expanded).toContain(item.original)

      current.workflow = { ...item, phase: 'sending' }
      const disabled = textOf(await ui.render(pane))
      expect(disabled).toContain('0: 원문 접기 · 사용 불가')
      expect(disabled).not.toContain('"hotkey":"0"')

      current.workflow = item
      await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })
    }
  })

  test('80-column pane keeps the header and all actions before a long draft', async ($, on) => {
    const item = workflow()
    item.original = '오래된 원문 '.repeat(30)
    item.draft = '길게 작성한 개선안 '.repeat(80)
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    const drawn = textOf(await ui.render({
      ...PANE,
      viewport: { columns: 80, rows: 40 },
      props: { ...PANE.props, bodyColumns: 74 },
    }))
    expect(drawn.indexOf('프롬프트 옵티마이저')).toBeLessThan(drawn.indexOf('입력창으로 가져오기'))
    for (const label of ['입력창으로 가져오기', '바로 보내기', '원문 보내기', '다시 다듬기', '취소']) {
      expect(drawn.indexOf(label)).toBeLessThan(drawn.indexOf('현재 개선안'))
    }
    expect(drawn).toContain('… (전체는 가져오기로 확인)')
    expect(drawn).not.toContain(item.draft)
    expect(drawn).toContain('원문 전체 보기')
    expect(drawn).not.toContain(item.original)
  })

  test('actions call the matching controller method once, and busy actions are unavailable', async ($, on) => {
    const current = state(workflow())
    const { controller, calls } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const press = (element: string) =>
      ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element })

    const actions = [
      ['optimizer:accept', 'accept'],
      ['optimizer:send', 'sendDraft'],
      ['optimizer:raw', 'sendOriginal'],
      ['optimizer:retry', 'retry'],
      ['optimizer:cancel', 'cancel'],
    ] as const
    for (const [key, call] of actions) {
      await press(key)
      expect(calls.at(-1)).toBe(call)
    }
    expect(calls).toHaveLength(actions.length)

    current.workflow = workflow('generating')
    const busy = textOf(await ui.render(PANE))
    expect(busy).toContain('1: 입력창으로 가져오기 · 사용 불가')
    expect(busy).toContain('잠시 기다려 주세요.')
    await press('optimizer:accept')
    expect(calls).toHaveLength(actions.length)

    current.workflow = { ...workflow('failed'), draft: '', lastError: '다시 시도할 수 있습니다.' }
    const failed = textOf(await ui.render(PANE))
    expect(failed).toContain('1: 입력창으로 가져오기 · 사용 불가')
    expect(failed).toContain('다시 시도할 수 있습니다.')
    await press('optimizer:send')
    expect(calls).toHaveLength(actions.length)
  })

  test('Input Enter refines; an empty instruction does not', async ($, on) => {
    const current = state(workflow())
    const { controller, calls } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const type = (value: string) =>
      ui.input({ component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value })

    await type(' 더 짧게 ')
    expect(calls).toEqual(['refine:더 짧게'])
    await type('   ')
    expect(calls).toEqual(['refine:더 짧게'])
  })

  test('other pane requests pass through unchanged', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    registerUi(on, controller, () => 3, 'test')
    on('ui.render', { component: 'Pane', requestId: 'other' }, async ($, e) => {
      const { Text } = await $.ui.resolve(e)
      return <Text>other pane</Text>
    })
    const other = { ...PANE, requestId: 'other' }
    expect(textOf(await $.ui.render(other))).toContain('other pane')
  })

  test('Escape/person close cancels; plugin close and completed transfer do not', async () => {
    const current = state(workflow())
    const { controller, calls } = fakeController(current)
    const ports = {} as Parameters<typeof handlePaneClose>[1]
    await handlePaneClose(controller, ports, 'plugin')
    expect(calls).toHaveLength(0)
    await handlePaneClose(controller, ports, 'person')
    expect(calls).toEqual(['cancel'])
    current.workflow = workflow('transferring')
    await handlePaneClose(controller, ports, 'person')
    expect(calls).toEqual(['cancel'])
  })

  test('pane args and presenter switch routes without duplicate composer logs', () => {
    expect(paneOpenArgs()).toMatchObject({ id: PANE_ID, focus: true, closeOnEscape: true, rows: 18 })
    const statuses: Array<string | undefined> = []
    const logs: string[] = []
    const toasts: string[] = []
    let invalidations = 0
    const ui: UiPorts = {
      open: async () => ({ isPlaced: true }), close: async () => undefined,
      invalidate: () => { invalidations++ },
      status: (text) => { statuses.push(text) },
      log: (text) => { logs.push(text) },
      toast: (text) => { toasts.push(text) },
    }
    const presenter = createPresenter()
    const current = state(workflow())
    presenter.present(ui, current)
    expect(invalidations).toBe(1)
    expect(logs).toHaveLength(0)
    current.workflow = { ...workflow(), ui: 'composer' }
    presenter.present(ui, current, '준비됐습니다')
    presenter.present(ui, current, '준비됐습니다')
    expect(statuses.at(-1)).toContain('/optimize accept(입력창으로)')
    expect(logs.filter((line) => line.startsWith('개선안:'))).toHaveLength(1)
    expect(logs.filter((line) => line === '준비됐습니다')).toHaveLength(1)
    current.workflow = null
    presenter.present(ui, current)
    expect(statuses.at(-1)).toBeUndefined()
    expect(toasts).toHaveLength(0)
    expect(DEFAULT_CONFIG.maxRounds).toBe(3)
  })

  test('presenter closes a finished pane once and invalidates it, but never closes composer', async () => {
    const closed: string[] = []
    let invalidations = 0
    const ui: UiPorts = {
      open: async () => ({ isPlaced: true }),
      close: async id => { closed.push(id); throw new Error('already closed') },
      invalidate: () => { invalidations++ },
      status: () => undefined,
      log: () => undefined,
      toast: () => undefined,
    }
    const presenter = createPresenter()
    const current = state(workflow())
    presenter.present(ui, current)
    current.workflow = null
    presenter.present(ui, current)
    presenter.present(ui, current)
    await Promise.resolve()
    expect(closed).toEqual([PANE_ID])
    expect(invalidations).toBe(2)

    current.workflow = { ...workflow(), ui: 'composer' }
    presenter.present(ui, current)
    current.workflow = null
    presenter.present(ui, current)
    expect(closed).toEqual([PANE_ID])
    expect(invalidations).toBe(2)
  })
})
