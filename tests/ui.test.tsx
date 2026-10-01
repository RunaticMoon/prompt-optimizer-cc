import type { EngineInterface, On, RenderInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import type { OptimizerController } from '../hooks/controller'
import { PANE_ID } from '../hooks/controller'
import { DEFAULT_CONFIG, type RuntimeState, type Workflow } from '../hooks/contracts'
import { COMPOSER_GUIDE, createPresenter } from '../hooks/ui/present'
import { handlePaneClose, hardWrapPreview, isCompactViewport, registerUi } from '../hooks/ui/register'
import { PANE_ROWS, paneOpenArgs, type UiPorts } from '../hooks/ui/ui-ports'

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

const BAND: RenderInput<'AbovePrompt', 'terminal'> = {
  component: 'AbovePrompt', surface: 'terminal',
  requestId: 'above-prompt',
  viewport: { columns: 110, rows: 40 },
  props: {
    hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 72,
    scroll: { offset: 0, bodyRows: 11 }, view: {},
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

function fakeController(current: RuntimeState, onRefine?: () => void) {
  const calls: string[] = []
  const controller = {
    getState: () => current,
    refine: async (_ports: unknown, text: string) => {
      calls.push(`refine:${text}`)
      onRefine?.()
    },
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
async function captureUi($: Engine, on: On, controller: OptimizerController, omittedControl?: 'Button' | 'Input', focusCalls?: string[], focusFail?: 'deny' | 'throw', renderInvalidations?: string[]): Promise<{
  render: (e: RenderInput<'Pane' | 'AbovePrompt'>) => Promise<unknown>
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
    const matcher = rest[0] as { component?: string }
    hooks.set(event === 'ui.render' ? `${event}:${matcher.component}` : event, rest[rest.length - 1] as CapturedHook)
    return { catch: () => undefined }
  }) as unknown as On
  registerUi(capturing, controller, () => 3, 'test')

  const call = (event: string, e: unknown): Promise<unknown> => {
    const hook = hooks.get(event === 'ui.render' ? `${event}:${(e as { component: string }).component}` : event)
    if (hook === undefined) throw new Error(`no ${event} hook was registered`)
    const engine = event === 'ui.input' && focusCalls
      ? { ui: {
          invalidate: (kind: string) => { focusCalls.push(`invalidate:${kind}`) },
          focus: async (args: { requestId: string; key: string }) => {
            focusCalls.push(`focus:${args.requestId}:${args.key}`)
            if (focusFail === 'throw') throw new Error('focus unavailable')
            return focusFail === 'deny' ? { deny: 'the ring did not move' } : {}
          },
        } }
      : event === 'ui.render' && (omittedControl || renderInvalidations)
      ? {
          ui: {
            invalidate: (kind: 'ui.render') => {
              renderInvalidations?.push(kind)
              if (!renderInvalidations) (hook$ as EngineInterface).ui.invalidate(kind)
            },
            resolve: async (input: RenderInput<'Pane' | 'AbovePrompt'>) => {
              const table = await (hook$ as EngineInterface).ui.resolve(input)
              return omittedControl ? { ...table, [omittedControl]: undefined } : table
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
  test('AbovePrompt draws pane content and yields for other states', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const drawn = textOf(await ui.render(BAND))
    expect(drawn).toContain('원래 요청')
    expect(drawn).toContain('↓ 개선안')
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    expect(drawn.indexOf('원문')).toBeLessThan(drawn.indexOf('↓ 개선안'))
    for (const control of ['Button', 'Input', 'Select', '"hotkey"']) expect(drawn).not.toContain(control)

    for (const [item, props] of [
      [null, BAND.props],
      [workflow(), { ...BAND.props, hasSurvey: true }],
      [workflow(), { ...BAND.props, view: { agentId: 'agent-1' } }],
    ] as const) {
      current.workflow = item
      expect(await ui.render({ ...BAND, props })).toEqual({ inner: { ...BAND, props } })
    }
    expect(textOf(await ui.render(PANE))).toContain('한국어로 작성한 개선안입니다.')
  })

  test('band yields to vscode and mobile even with an active pane workflow', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    for (const surface of ['vscode', 'mobile'] as const) {
      const event = { ...BAND, surface }
      expect(await ui.render(event)).toEqual({ inner: event })
    }
    // The same workflow still draws on a surface that has a band.
    expect(textOf(await ui.render(BAND))).toContain('한국어로 작성한 개선안입니다.')
  })

  test('pane-mode band omits the composer guide', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    const drawn = textOf(await ui.render(BAND))
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    expect(drawn).not.toContain(COMPOSER_GUIDE)
  })

  test('composer band shows the full original, draft, and shared guide', async ($, on) => {
    const item = { ...workflow(), ui: 'composer' as const, original: '긴 원문 '.repeat(40) }
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const drawn = textOf(await ui.render(BAND))
    expect(drawn).toContain(item.original)
    expect(drawn).toContain(item.draft)
    expect(drawn).toContain(COMPOSER_GUIDE)
    expect(drawn.indexOf('원문')).toBeLessThan(drawn.indexOf('↓ 개선안'))
    expect(drawn.indexOf('↓ 개선안')).toBeLessThan(drawn.indexOf(COMPOSER_GUIDE))
    expect(drawn).toContain('"dimColor":true')
    expect(drawn).toContain('"wrap":"truncate-end"')
    for (const control of ['Button', 'Input', 'Select', '"hotkey"']) expect(drawn).not.toContain(control)

    current.workflow = { ...item, phase: 'generating', draft: '' }
    expect(textOf(await ui.render(BAND))).toContain('개선안을 준비하고 있습니다…')
    current.workflow = { ...item, phase: 'failed', draft: '' }
    expect(textOf(await ui.render(BAND))).toContain('아직 개선안이 없습니다.')
  })

  test('band eligibility transitions restore the pane fallback and invalidate once', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    const ineligible = [
      { ...BAND, props: { ...BAND.props, hasSurvey: true } },
      { ...BAND, props: { ...BAND.props, view: { agentId: 'agent-1' } } },
    ]
    for (const event of ineligible) {
      expect(textOf(await ui.render(BAND))).toContain('원래 요청')
      await ui.render(BAND)
      expect(invalidations).toHaveLength(1)
      expect(textOf(await ui.render(PANE))).not.toContain('한국어로 작성한 개선안입니다.')
      expect(await ui.render(event)).toEqual({ inner: event })
      await ui.render(event)
      expect(invalidations).toHaveLength(2)
      const fallback = textOf(await ui.render(PANE))
      expect(fallback).toContain('원래 요청')
      expect(fallback).toContain('한국어로 작성한 개선안입니다.')
      invalidations.length = 0
    }
  })

  test('band shows full draft, phase empties, and original toggle', async ($, on) => {
    const item = workflow()
    item.original = '긴 원문 '.repeat(40)
    item.draft = '개선안 본문 '.repeat(80)
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)

    const collapsed = textOf(await ui.render(BAND))
    expect(collapsed).toContain(item.draft)
    expect(collapsed).not.toContain(item.original)
    expect(collapsed).toContain('…')
    await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })
    expect(textOf(await ui.render(BAND))).toContain(item.original)

    current.workflow = { ...item, phase: 'generating', draft: '' }
    expect(textOf(await ui.render(BAND))).toContain('개선안을 준비하고 있습니다…')
    current.workflow = { ...item, phase: 'failed', draft: '' }
    expect(textOf(await ui.render(BAND))).toContain('아직 개선안이 없습니다.')
  })

  test('pane keeps multiline optimizer message and falls back before band renders', async ($, on) => {
    const item = workflow()
    item.original = '원문 내용 '.repeat(30)
    item.dialogue = [{ role: 'optimizer', text: '수정했습니다.\n확인하시겠어요?' }]
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    const fallback = textOf(await ui.render({ ...PANE, viewport: { columns: 80, rows: 40 } }))
    expect(fallback).toContain(item.original)
    expect(fallback).toContain(item.draft)
    await ui.render(BAND)
    for (const columns of [80, 110]) {
      const pane = { ...PANE, viewport: { columns, rows: 40 } }
      const drawn = textOf(await ui.render(pane))
      expect(drawn).not.toContain(item.original)
      expect(drawn).not.toContain(item.draft)
      expect(drawn).toContain('수정했습니다.\\n확인하시겠어요?')
    }
    const mobile = textOf(await ui.render({ ...PANE, surface: 'mobile' }))
    expect(mobile).toContain(item.original)
    expect(mobile).toContain(item.draft)
    expect(mobile).not.toContain('원문 전체 보기')
  })

  test('compact viewport uses screen rows, except fullscreen dock; pane ignores bodyRows', async ($, on) => {
    expect(isCompactViewport({ columns: 80, rows: 24 })).toBe(true)
    expect(isCompactViewport({ columns: 80, rows: 48 })).toBe(false)
    expect(isCompactViewport({ columns: 120, rows: 30, isFullscreen: true })).toBe(false)
    expect(isCompactViewport()).toBe(false)
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    const paneAt = (placement: 'inline' | 'dock', bodyRows: number, rows: number, viewport = true) => ui.render({
      ...PANE,
      viewport: viewport ? { columns: 80, rows } : undefined,
      props: { ...PANE.props, placement, scroll: { offset: 0, bodyRows } },
    })
    for (const bodyRows of [2, 6, PANE_ROWS, 30]) {
      const compact = textOf(await paneAt('inline', bodyRows, 24))
      expect(compact).toContain('"label":"넣기"')
      expect(compact).toContain('"label":"보완"')
    }
    for (const full of [await paneAt('inline', 2, 48), await paneAt('dock', 2, 24), await paneAt('inline', 2, 24, false)]) {
      expect(textOf(full)).toContain('"label":"1: 입력창에 넣기 (수정 후 전송)"')
    }
  })

  test('hard-wrap preview honors cells, newlines, spaces, and ellipsis within the row budget', () => {
    const words = Array(13).fill('가나다라마').join('   ')
    const wrapped = hardWrapPreview(words, 38, 3)
    expect(wrapped).toHaveLength(3)
    expect(wrapped[2]!.endsWith('…')).toBe(true)
    expect(wrapped.every(line => !line.includes('  '))).toBe(true)
    expect(hardWrapPreview('가나다라마', 4, 3)).toEqual(['가나', '다라', '마'])
    expect(hardWrapPreview('첫 줄\n둘째 줄', 38, 3)).toEqual(['첫 줄', '둘째 줄'])
    expect(hardWrapPreview('가나다', 4, 1)).toEqual(['가…'])
    expect(hardWrapPreview('abc', 3, 1)).toEqual(['abc'])
  })

  test('compact pane orders preview, accept, Input, send and raw before scrollable details', async ($, on) => {
    const item = workflow()
    item.original = '숨길 원문 '.repeat(40)
    item.draft = Array(13).fill('가나다라마').join('   ')
    const current = state(item)
    const { controller, calls } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 24 }, props: {
      ...PANE.props, placement: 'inline' as const, bodyColumns: 40,
      scroll: { offset: 0, bodyRows: 2 },
    } }
    const drawn = textOf(await ui.render(compact))
    // 24 screen rows estimate six pane rows: three preview rows and 1/Input/2·3.
    const preview = hardWrapPreview(item.draft, 38, 3)
    expect(preview).toHaveLength(3)
    for (const line of preview) expect(drawn).toContain(line)
    expect(drawn).toContain('…')
    expect(drawn).not.toContain(item.draft)
    expect(drawn).not.toContain(item.original)
    expect(drawn).toContain('프롬프트 옵티마이저')
    expect(drawn).toContain('옵티마이저 메시지')
    expect(drawn).toContain('추가 조건이 있나요?')
    expect(drawn).toContain('원문 전체 보기')
    expect(drawn).not.toContain('submitLabel')
    expect(drawn).toContain('"label":"보완"')
    expect(drawn).toContain('optimizer:instruction')
    for (const [key, digit, label] of [
      ['accept', '1', '넣기'], ['send', '2', '전송'], ['raw', '3', '원문'],
    ]) {
      expect(drawn).toContain(`optimizer:${key}`)
      expect(drawn).toContain(`"hotkey":"${digit}"`)
      expect(drawn).toContain(`"label":"${label}"`)
    }
    expect(drawn).toContain('"autoFocus":true')
    expect(drawn.indexOf(preview[0]!)).toBeLessThan(drawn.indexOf('optimizer:accept'))
    expect(drawn.indexOf('optimizer:accept')).toBeLessThan(drawn.indexOf('optimizer:instruction'))
    expect(drawn.indexOf('optimizer:instruction')).toBeLessThan(drawn.indexOf('optimizer:send'))
    expect(drawn.indexOf('optimizer:send')).toBeLessThan(drawn.indexOf('optimizer:raw'))
    expect(drawn.indexOf('optimizer:raw')).toBeLessThan(drawn.indexOf('프롬프트 옵티마이저'))
    await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:accept' })
    await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:send' })
    await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:raw' })
    await ui.input({ component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value: '더 짧게' })
    expect(calls).toEqual(['accept', 'sendDraft', 'sendOriginal', 'refine:더 짧게'])
  })

  test('compact pane uses the optimizer question without a draft and dims unavailable actions', async ($, on) => {
    const current = state({ ...workflow('failed'), draft: '' })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 24 }, props: { ...PANE.props, placement: 'inline' as const,
      scroll: { offset: 0, bodyRows: 6 } } }
    const missing = textOf(await ui.render(compact))
    expect(missing).toContain('추가 조건이 있나요?')
    expect(missing).toContain('"hotkey":"3"')
    expect(missing).not.toContain('"hotkey":"1"')
    expect(missing).not.toContain('"hotkey":"2"')
    expect(missing).toContain('"dimColor":true')

    current.workflow = { ...workflow('generating'), draft: '' }
    const busy = textOf(await ui.render(compact))
    expect(busy).toContain('개선안을 준비하고 있습니다…')
    expect(busy).toContain('보완 (사용 불가)')
    expect(busy).not.toContain('optimizer:instruction')
    expect(busy).not.toContain('"hotkey":"3"')

    current.workflow = { ...workflow('failed'), draft: '', lastError: '네트워크 오류' }
    const failed = textOf(await ui.render(compact))
    expect(failed.indexOf('오류: 네트워크 오류')).toBeLessThan(failed.indexOf('optimizer:raw'))
    expect((failed.match(/오류: 네트워크 오류/g) ?? [])).toHaveLength(2)
  })

  test('compact pane omits its band while composer still draws it', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    const compactBand = { ...BAND, viewport: { columns: 80, rows: 24 } }
    expect(textOf(await ui.render(BAND))).toContain('↓ 개선안')
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
    expect(invalidations).toHaveLength(2)
    current.workflow = { ...workflow(), ui: 'composer' }
    expect(textOf(await ui.render(compactBand))).toContain('↓ 개선안')
  })

  test('pane describes each phase and an empty workflow', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)

    for (const [phase, label] of [
      ['collecting', '수집 중'], ['generating', '생성 중'], ['reviewing', '검토'],
      ['failed', '실패'], ['transferring', '전달 중'], ['sending', '전송 중'],
    ] as const) {
      current.workflow = { ...workflow(phase), lastError: phase === 'failed' ? '네트워크 오류' : undefined }
      const band = textOf(await ui.render(BAND))
      const drawn = textOf(await ui.render(PANE))
      expect(drawn).toContain(label)
      expect(drawn).toContain('1/3회')
      expect(drawn).toContain('10토큰')
      expect(band).toContain('원래 요청')
      expect(band).toContain('한국어로 작성한 개선안입니다.')
      expect(drawn).not.toContain('한국어로 작성한 개선안입니다.')
      if (phase === 'failed') expect(drawn).toContain('네트워크 오류')
    }

    current.workflow = null
    expect(textOf(await ui.render(PANE))).toContain('진행 중인 개선 작업이 없습니다')
    current.workflow = { ...workflow(), ui: 'composer' }
    expect(textOf(await ui.render(PANE))).toContain('개선 대화는 입력창에서 진행 중입니다')
  })

  test('desktop band owns the bodies while its pane keeps the controls', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    expect(textOf(await ui.render({ ...BAND, surface: 'desktop' }))).toContain('한국어로 작성한 개선안입니다.')
    const drawn = textOf(await ui.render({ ...PANE, surface: 'desktop' }))
    expect(drawn).toContain('프롬프트 옵티마이저')
    expect(drawn).not.toContain('원래 요청')
    expect(drawn).not.toContain('한국어로 작성한 개선안입니다.')
  })

  test('VS Code pane falls back to the full bodies without a band', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    const drawn = textOf(await ui.render({ ...PANE, surface: 'vscode' }))
    expect(drawn).toContain('원래 요청')
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
  })

  test('a pane without Button offers command actions in text', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller, 'Button')
    await ui.render(BAND)
    const drawn = textOf(await ui.render({ ...PANE, surface: 'desktop' }))
    expect(drawn).toContain('검토')
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    expect(drawn).toContain('/optimize accept · send · raw · cancel · retry <보완>')
    // The optimizer message is its own section after the draft, not an inline prefix.
    expect(drawn).toContain('옵티마이저 메시지')
    expect(drawn).toContain('추가 조건이 있나요?')
    expect(drawn).not.toContain('옵티마이저: 추가 조건이 있나요?')
    expect(drawn.indexOf('원문')).toBeLessThan(drawn.indexOf('현재 개선안'))
    expect(drawn.indexOf('현재 개선안')).toBeLessThan(drawn.indexOf('옵티마이저 메시지'))
  })

  test('mobile table without Input keeps buttons and shows the retry command', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller, 'Input')
    const drawn = textOf(await ui.render({ ...PANE, surface: 'mobile' }))
    expect(drawn).toContain('한국어로 작성한 개선안입니다.')
    for (const label of ['입력창에 넣기', '개선안 바로 전송', '원문 그대로 전송']) {
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
    await ui.render(BAND)

    for (const columns of [80, 110]) {
      const pane = { ...PANE, viewport: { columns, rows: 40 } }
      const drawn = textOf(await ui.render(pane))
      for (const [digit, label] of [
        ['1', '입력창에 넣기 (수정 후 전송)'], ['2', '개선안 바로 전송'],
        ['3', '원문 그대로 전송'],
      ]) {
        expect(drawn).toContain(`"hotkey":"${digit}"`)
        expect(drawn).toContain(`"label":"${digit}: ${label}"`)
      }
      expect(drawn).toContain('"hotkey":"0"')
      expect(drawn).toContain('"plain":true')
      expect(drawn).toContain('"label":"원문 전체 보기"')
      expect(drawn).not.toContain('"label":"0:')
      expect(drawn).toContain('"autoFocus":true')
      expect(drawn).toContain('Enter 입력창 · Tab 이동 · 2 바로 전송 · 3 원문 전송 · Esc 닫기')
      expect(drawn).not.toContain('↑↓')
      expect(drawn).not.toContain('ctrl+x tab 포커스')
      expect(drawn).not.toContain('"hotkey":"4"')
      expect(drawn).not.toContain('"hotkey":"5"')
      expect(drawn).not.toContain('optimizer:retry')
      expect(drawn).not.toContain('optimizer:cancel')
      expect(drawn.indexOf('optimizer:accept')).toBeLessThan(drawn.indexOf('optimizer:instruction'))
      expect(drawn.indexOf('optimizer:instruction')).toBeLessThan(drawn.indexOf('optimizer:send'))
      expect(drawn.indexOf('optimizer:send')).toBeLessThan(drawn.indexOf('optimizer:raw'))
      expect(drawn).not.toContain('현재 개선안')
      expect(drawn).not.toContain(item.original)
      expect(drawn.indexOf('optimizer:raw')).toBeLessThan(drawn.indexOf('옵티마이저 메시지'))
      expect(drawn.indexOf('옵티마이저 메시지')).toBeLessThan(drawn.indexOf('원문 전체 보기'))

      const unfocused = textOf(await ui.render({ ...pane, props: { ...PANE.props, isFocused: false } }))
      expect(unfocused).toContain('ctrl+x tab 포커스')
    }

    current.workflow = workflow('generating')
    const disabled = textOf(await ui.render(PANE))
    for (const label of ['1: 입력창에 넣기', '2: 개선안 바로 전송', '3: 원문 그대로 전송']) {
      expect(disabled).toContain(`${label} · 사용 불가`)
    }

    current.workflow = { ...item, phase: 'sending' }
    for (const columns of [80, 110]) {
      const sending = textOf(await ui.render({ ...PANE, viewport: { columns, rows: 40 } }))
      expect(sending).toContain('0: 원문 전체 보기 · 사용 불가')
    }
  })

  test('key guidance omits arrows and matches busy and draft-less states', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const paneAt = (isFocused: boolean) =>
      ui.render({ ...PANE, viewport: { columns: 80, rows: 40 }, props: { ...PANE.props, isFocused } })

    // A ready draft: the focused hint teaches Tab, never the arrows.
    const focused = textOf(await paneAt(true))
    expect(focused).toContain('Enter 입력창 · Tab 이동 · 2 바로 전송 · 3 원문 전송 · Esc 닫기')
    expect(focused).not.toContain('↑↓')
    expect(textOf(await paneAt(false))).toContain('ctrl+x tab 포커스 · Tab 이동 · 1/2/3 선택 · Esc 닫기')

    // Busy (generating): 1/2/3 are all disabled, so the hint is a short note.
    current.workflow = workflow('generating')
    expect(textOf(await paneAt(true))).toContain('생성 중에는 Esc로 취소할 수 있습니다')
    expect(textOf(await paneAt(false))).toContain('생성 중에는 Esc로 취소할 수 있습니다')

    // Transferring/sending: Esc cannot cancel, so the note says it is sending.
    current.workflow = workflow('sending')
    expect(textOf(await paneAt(true))).toContain('전송 중입니다')
    expect(textOf(await paneAt(false))).toContain('전송 중입니다')

    // Failed with no draft: Enter and 2 must not be advertised.
    current.workflow = { ...workflow('failed'), draft: '', lastError: '실패했습니다' }
    const failedFocused = textOf(await paneAt(true))
    expect(failedFocused).toContain('Tab 이동 · 3 원문 전송 · Esc 닫기')
    expect(failedFocused).not.toContain('Enter 입력창')
    expect(failedFocused).not.toContain('2 바로 전송')
    const failedUnfocused = textOf(await paneAt(false))
    expect(failedUnfocused).toContain('ctrl+x tab 포커스 · Tab 이동 · 3 선택 · Esc 닫기')
    expect(failedUnfocused).not.toContain('1/2/3 선택')
  })

  test('refine focus refusal still returns the input result', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const focusCalls: string[] = []
    const ui = await captureUi($, on, controller, undefined, focusCalls, 'deny')
    const result = await ui.input({
      component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value: '더 짧게',
    })
    expect(result).toEqual({ element: 'optimizer:instruction', value: '더 짧게' })
    expect(focusCalls).toEqual(['invalidate:ui.render', `focus:${PANE_ID}:optimizer:accept`])
  })

  test('refine focus throw still returns the input result', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const focusCalls: string[] = []
    const ui = await captureUi($, on, controller, undefined, focusCalls, 'throw')
    const result = await ui.input({
      component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value: '더 짧게',
    })
    expect(result).toEqual({ element: 'optimizer:instruction', value: '더 짧게' })
    expect(focusCalls).toEqual(['invalidate:ui.render', `focus:${PANE_ID}:optimizer:accept`])
  })

  test('refine does not focus when the reply leaves no draft', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current, () => {
      current.workflow = { ...workflow('failed'), draft: '', lastError: '실패했습니다' }
    })
    const focusCalls: string[] = []
    const ui = await captureUi($, on, controller, undefined, focusCalls)
    await ui.input({
      component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value: '더 짧게',
    })
    expect(focusCalls).toEqual([])
  })

  test('refine does not focus when the workflow moved to the composer', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current, () => {
      current.workflow = { ...workflow(), ui: 'composer' }
    })
    const focusCalls: string[] = []
    const ui = await captureUi($, on, controller, undefined, focusCalls)
    await ui.input({
      component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value: '더 짧게',
    })
    expect(focusCalls).toEqual([])
  })

  test('expanded original keeps its plain label when the toggle becomes unavailable', async ($, on) => {
    const item = workflow()
    item.original = '긴 원문 '.repeat(40)
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    await ui.render(BAND)

    for (const columns of [80, 110]) {
      const pane = { ...PANE, viewport: { columns, rows: 40 } }
      await ui.render(pane)
      await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })

      const expanded = textOf(await ui.render(pane))
      expect(expanded).toContain('"hotkey":"0"')
      expect(expanded).toContain('"plain":true')
      expect(expanded).toContain('"label":"원문 접기"')
      expect(expanded).not.toContain('"label":"0:')
      expect(expanded).not.toContain(item.original)
      expect(textOf(await ui.render(BAND))).toContain(item.original)

      current.workflow = { ...item, phase: 'sending' }
      const disabled = textOf(await ui.render(pane))
      expect(disabled).toContain('0: 원문 접기 · 사용 불가')
      expect(disabled).not.toContain('"hotkey":"0"')

      current.workflow = item
      await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })
    }
  })

  test('80-column pane keeps the header and actions before a long draft', async ($, on) => {
    const item = workflow()
    item.original = '오래된 원문 '.repeat(30)
    item.draft = '길게 작성한 개선안 '.repeat(80)
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    const band = textOf(await ui.render({ ...BAND, viewport: { columns: 80, rows: 40 }, props: { ...BAND.props, bodyColumns: 74 } }))
    const drawn = textOf(await ui.render({
      ...PANE,
      viewport: { columns: 80, rows: 40 },
      props: { ...PANE.props, bodyColumns: 74 },
    }))
    expect(drawn.indexOf('프롬프트 옵티마이저')).toBeLessThan(drawn.indexOf('입력창에 넣기'))
    expect(band).toContain(item.draft)
    expect(band).not.toContain(item.original)
    expect(drawn).not.toContain('현재 개선안')
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
    ] as const
    for (const [key, call] of actions) {
      await press(key)
      expect(calls.at(-1)).toBe(call)
    }
    expect(calls).toHaveLength(actions.length)

    current.workflow = workflow('generating')
    const busy = textOf(await ui.render(PANE))
    expect(busy).toContain('1: 입력창에 넣기 · 사용 불가')
    expect(busy).toContain('잠시 기다려 주세요.')
    await press('optimizer:accept')
    expect(calls).toHaveLength(actions.length)

    current.workflow = { ...workflow('failed'), draft: '', lastError: '다시 시도할 수 있습니다.' }
    const failed = textOf(await ui.render(PANE))
    expect(failed).toContain('1: 입력창에 넣기 · 사용 불가')
    expect(failed).toContain('다시 시도할 수 있습니다.')
    await press('optimizer:send')
    expect(calls).toHaveLength(actions.length)
  })

  test('Input Enter refines; an empty instruction does not', async ($, on) => {
    const current = state(workflow())
    const { controller, calls } = fakeController(current)
    const focusCalls: string[] = []
    const ui = await captureUi($, on, controller, undefined, focusCalls)
    const type = (value: string) =>
      ui.input({ component: 'Pane', requestId: PANE_ID, plugin: 'test', kind: 'submit', element: 'optimizer:instruction', value })

    await type(' 더 짧게 ')
    expect(calls).toEqual(['refine:더 짧게'])
    expect(focusCalls).toEqual(['invalidate:ui.render', `focus:${PANE_ID}:optimizer:accept`])
    await type('   ')
    expect(calls).toEqual(['refine:더 짧게'])
    expect(focusCalls).toHaveLength(2)
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
    expect(paneOpenArgs()).toMatchObject({ id: PANE_ID, focus: true, closeOnEscape: true, rows: 12 })
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
    expect(invalidations).toBe(3)
    expect(statuses.at(-1)).toContain('/optimize accept(입력창으로)')
    expect(logs.filter((line) => line.startsWith('개선안:'))).toHaveLength(1)
    expect(logs.filter((line) => line === '준비됐습니다')).toHaveLength(1)
    current.workflow = null
    presenter.present(ui, current)
    expect(invalidations).toBe(4)
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
    expect(invalidations).toBe(3)
    current.workflow = null
    presenter.present(ui, current)
    expect(closed).toEqual([PANE_ID])
    expect(invalidations).toBe(4)
  })
})
