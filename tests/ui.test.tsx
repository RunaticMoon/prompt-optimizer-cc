import type { RenderInput } from 'claude-code'
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

describe('optimizer UI', () => {
  test('pane describes each phase and an empty workflow', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    registerUi(on, controller, () => 3, 'test')

    for (const [phase, label] of [
      ['collecting', '수집 중'], ['generating', '생성 중'], ['reviewing', '검토'],
      ['failed', '실패'], ['transferring', '전달 중'], ['sending', '전송 중'],
    ] as const) {
      current.workflow = { ...workflow(phase), lastError: phase === 'failed' ? '네트워크 오류' : undefined }
      const drawn = textOf(await $.ui.render(PANE))
      expect(drawn).toContain(label)
      expect(drawn).toContain('1/3회')
      expect(drawn).toContain('10토큰')
      expect(drawn).toContain('한국어로 작성한 개선안입니다.')
      if (phase === 'failed') expect(drawn).toContain('네트워크 오류')
    }

    current.workflow = null
    expect(textOf(await $.ui.render(PANE))).toContain('진행 중인 개선 작업이 없습니다')
    current.workflow = { ...workflow(), ui: 'composer' }
    expect(textOf(await $.ui.render(PANE))).toContain('개선 대화는 입력창에서 진행 중입니다')
  })

  test('actions call the matching controller method once, and busy actions are unavailable', async ($, on) => {
    const current = state(workflow())
    const { controller, calls } = fakeController(current)
    registerUi(on, controller, () => 3, 'test')

    const mounted = await $.ui.mount({ plugin: 'test', ...PANE })
    const actions = [
      ['optimizer:accept', 'accept'],
      ['optimizer:send', 'sendDraft'],
      ['optimizer:raw', 'sendOriginal'],
      ['optimizer:retry', 'retry'],
      ['optimizer:cancel', 'cancel'],
    ] as const
    for (const [key, call] of actions) {
      await mounted.press({ key })
      expect(calls.at(-1)).toBe(call)
    }
    expect(calls).toHaveLength(actions.length)

    current.workflow = workflow('generating')
    await mounted.redraw()
    const busy = textOf(await mounted.drawn())
    expect(busy).toContain('입력창으로 가져오기 · 사용 불가')
    expect(busy).toContain('잠시 기다려 주세요.')
    await expect(mounted.press({ key: 'optimizer:accept' })).rejects.toThrow()
    expect(calls).toHaveLength(actions.length)

    current.workflow = { ...workflow('failed'), draft: '', lastError: '다시 시도할 수 있습니다.' }
    await mounted.redraw()
    const failed = textOf(await mounted.drawn())
    expect(failed).toContain('입력창으로 가져오기 · 사용 불가')
    expect(failed).toContain('다시 시도할 수 있습니다.')
    await expect(mounted.press({ key: 'optimizer:send' })).rejects.toThrow()
    expect(calls).toHaveLength(actions.length)
  })

  test('Input Enter refines; an empty instruction does not', async ($, on) => {
    const current = state(workflow())
    const { controller, calls } = fakeController(current)
    registerUi(on, controller, () => 3, 'test')
    const mounted = await $.ui.mount({ plugin: 'test', ...PANE })
    await mounted.input({ key: 'optimizer:instruction', text: ' 더 짧게 ' })
    expect(calls).toEqual(['refine:더 짧게'])
    await mounted.input({ key: 'optimizer:instruction', text: '   ' })
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
})
