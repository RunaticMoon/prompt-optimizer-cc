import type { EngineInterface, On, RenderInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import type { OptimizerController } from '../hooks/controller'
import { PANE_ID } from '../hooks/controller'
import { DEFAULT_CONFIG, type RuntimeState, type Workflow } from '../hooks/contracts'
import { COMPOSER_GUIDE, RAW_MODE_BADGE_HINT, createPresenter } from '../hooks/ui/present'
import { estimatedCompactRows, handlePaneClose, hardWrapPreview, hardWrapPreviewWithStatus, isCompactViewport, registerUi } from '../hooks/ui/register'
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
    sessionId: 'session-1', workflow: item, bypass: null, rawMode: null,
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

type UiNode = { type: string; props: Record<string, unknown>; children?: unknown[] }

function nodesOf(tree: unknown): UiNode[] {
  if (!tree || typeof tree !== 'object' || !('type' in tree)) return []
  const node = tree as UiNode
  return [node, ...(node.children ?? []).flatMap(nodesOf)]
}

function contentOf(tree: unknown): string {
  if (typeof tree === 'string') return tree
  if (!tree || typeof tree !== 'object') return ''
  return ((tree as UiNode).children ?? []).map(contentOf).join('')
}

function textNode(tree: unknown, content: string): UiNode | undefined {
  return nodesOf(tree).find(node => node.type === 'Text' && contentOf(node) === content)
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
  render: (e: RenderInput<'Pane' | 'AbovePrompt' | 'PromptHint'>) => Promise<unknown>
  press: (e: unknown) => Promise<unknown>
  input: (e: unknown) => Promise<unknown>
  close: (e: unknown) => Promise<unknown>
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
    const engine = event === 'ui.close' && renderInvalidations
      ? { ui: { invalidate: (kind: string) => { renderInvalidations.push(kind) } } }
      : (event === 'ui.input' || event === 'ui.press') && focusCalls
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
    close: e => call('ui.close', e),
  }
}

describe('optimizer UI', () => {

  test('panel owns the draft and original toggle; read-only band owns the message', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      for (const columns of [80, 120]) {
        const pane = await ui.render({ ...PANE, surface, viewport: { columns, rows: 40 } })
        expect(textNode(pane, '개선안')?.props.bold).toBe(true)
        expect(textNode(pane, current.workflow!.draft)?.props.color).toBe('suggestion')
        expect(textOf(pane)).not.toContain('원래 요청')
        expect(textOf(pane)).toContain('optimizer:original')
      }
    }
    const band = await ui.render(BAND)
    expect(contentOf(band)).toContain('추가 조건이 있나요?')
    expect(contentOf(band)).not.toContain(current.workflow!.draft)
    expect(contentOf(band)).not.toContain('원래 요청')
    expect(nodesOf(band).filter(node => ['Button', 'Input'].includes(node.type))).toHaveLength(0)
    const pane = await ui.render(PANE)
    expect(contentOf(pane)).not.toContain('추가 조건이 있나요?')
    expect(contentOf(pane)).toContain(current.workflow!.draft)
    await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:original' })
    expect(contentOf(await ui.render(PANE))).toContain('원래 요청')
    expect(contentOf(await ui.render(BAND))).not.toContain('원래 요청')
  })

  test('workflow message has priority and absent fields fall back to dialogue', async ($, on) => {
    const current = state({ ...workflow(), message: '계약 메시지', question: '어떤 형식인가요?', options: ['보고서', '목록'] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const band = contentOf(await ui.render(BAND))
    expect(band).toContain('계약 메시지')
    expect(band).toContain('어떤 형식인가요?')
    expect(band).toContain('→ 패널에서 답을 고르세요')
    expect(band).not.toContain('추가 조건이 있나요?')
    current.workflow = workflow()
    expect(contentOf(await ui.render(BAND))).toContain('추가 조건이 있나요?')
    current.workflow.message = ''
    expect(contentOf(await ui.render(BAND))).not.toContain('추가 조건이 있나요?')
  })

  test('question choices use a/b/c/d with only the first answer autofocused', async ($, on) => {
    const current = state({ ...workflow(), question: '어떻게 작성할까요?', options: ['보고서', '목록', '표', '요약'] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const placement of ['inline', 'dock'] as const) {
      const tree = await ui.render({ ...PANE, props: { ...PANE.props, placement } })
      const buttons = nodesOf(tree).filter(node => node.type === 'Button' && String(node.props.key).startsWith('optimizer:option:'))
      expect(buttons.map(node => node.props.key)).toEqual([0, 1, 2, 3].map(i => `optimizer:option:${i}`))
      expect(buttons.map(node => node.props.hotkey)).toEqual(['a', 'b', 'c', 'd'])
      expect(buttons[0]!.props.autoFocus).toBe(true)
      expect(buttons.slice(1).every(node => node.props.autoFocus === undefined)).toBe(true)
      expect(nodesOf(tree).filter(node => node.props.autoFocus === true)).toHaveLength(1)
      expect(textNode(tree, '질문: 어떻게 작성할까요?')?.props.color).toBe('claude')
      expect(contentOf(tree).indexOf('질문:')).toBeLessThan(contentOf(tree).indexOf('개선안'))
      expect(nodesOf(tree).find(node => node.props.key === 'optimizer:accept')?.props.autoFocus).toBeUndefined()
    }
  })

  test('question without choices focuses direct input, including draft-less replies', async ($, on) => {
    const current = state({ ...workflow(), draft: '', question: '추가 조건이 있나요?', options: [] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const rows of [24, 40]) {
      const tree = await ui.render({ ...PANE, viewport: { columns: 80, rows }, props: { ...PANE.props, placement: 'inline' } })
      expect(nodesOf(tree).find(node => node.props.key === 'optimizer:instruction')?.props.autoFocus).toBe(true)
      expect(textOf(tree)).toContain('직접 입력')
      expect(nodesOf(tree).filter(node => node.props.autoFocus === true)).toHaveLength(1)
    }
  })

  test('answer press refines with exact option text and focuses the fresh question', async ($, on) => {
    const current = state({ ...workflow(), question: '형식?', options: ['보고서', '목록'] })
    const { controller, calls } = fakeController(current, () => { current.workflow = { ...workflow(), draft: '', question: '분량?', options: ['한 페이지'] } })
    const focus: string[] = []
    const ui = await captureUi($, on, controller, undefined, focus)
    const result = await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:option:1' })
    expect(result).toEqual({ element: 'optimizer:option:1' })
    expect(calls).toEqual(['refine:목록'])
    expect(focus).toEqual(['invalidate:ui.render', `focus:${PANE_ID}:optimizer:option:0`])
  })

  test('answer press and input share follow-up focus for input, accept and focus denial', async ($, on) => {
    const current = state({ ...workflow(), question: '형식?', options: ['보고서'] })
    let reply: Workflow = { ...workflow(), question: '조건?', options: [] }
    const { controller, calls } = fakeController(current, () => { current.workflow = reply })
    const focus: string[] = []
    const ui = await captureUi($, on, controller, undefined, focus, 'deny')
    await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:option:0' })
    expect(focus.at(-1)).toBe(`focus:${PANE_ID}:optimizer:instruction`)
    current.workflow = { ...workflow(), question: '형식?', options: ['표'] }
    reply = workflow()
    expect(await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:option:0' })).toEqual({ element: 'optimizer:option:0' })
    expect(calls).toEqual(['refine:보고서', 'refine:표'])
    expect(focus.at(-1)).toBe(`focus:${PANE_ID}:optimizer:accept`)
  })

  test('invalid indices, stale question, round limit, composer and busy presses do not refine', async ($, on) => {
    const item = { ...workflow(), question: '형식?', options: ['목록'] }
    const current = state(item)
    const { controller, calls } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const value of ['-1', '4', '1', 'NaN', '0junk', '00', '1.0', '']) {
      await ui.press({ component: 'Pane', requestId: PANE_ID, element: `optimizer:option:${value}` })
    }
    for (const phase of ['idle', 'collecting', 'generating', 'transferring', 'sending'] as const) {
      current.workflow = { ...item, phase }
      const tree = await ui.render(PANE)
      expect(textOf(tree)).not.toContain('optimizer:option:')
      await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:option:0' })
    }
    for (const patch of [{ question: null }, { rounds: 3 }, { ui: 'composer' as const }]) {
      current.workflow = { ...item, ...patch }
      await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:option:0' })
    }
    expect(calls).toHaveLength(0)
  })

  test('compact first views prioritize draft, question, choices, direct input, then actions within row budget', async ($, on) => {
    const item = { ...workflow(), draft: '긴 한국어 개선안 '.repeat(80), message: '검토 메시지', question: '형식을 고르세요', options: ['목록', '보고서', '표', '요약'] }
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    for (const [rows, isFullscreen, budget] of [[24, false, 11], [24, true, 6], [20, false, 7], [20, true, 4]] as const) {
      const event = { ...PANE, viewport: { columns: 80, rows, isFullscreen }, props: { ...PANE.props, placement: 'inline' as const, bodyColumns: 74 } }
      const tree = await ui.render(event) as UiNode
      const first = tree.children!.slice(0, -1)
      expect(first).toHaveLength(budget)
      expect(contentOf(first[0])).toContain('개선안')
      expect(contentOf(first[first.length - (budget > 4 ? 2 : 1)])).toBe(budget > 4 ? '' : '검토 메시지')
      const drawn = textOf(tree)
      expect(drawn.indexOf('질문:')).toBeLessThan(drawn.indexOf('optimizer:option:0'))
      expect(drawn.indexOf('optimizer:option:3')).toBeLessThan(drawn.indexOf('optimizer:instruction'))
      expect(drawn.indexOf('optimizer:instruction')).toBeLessThan(drawn.indexOf('optimizer:accept'))
      expect(drawn).toContain(item.draft)
      expect(drawn).toContain(item.message)
      expect(nodesOf(tree).filter(node => node.props.autoFocus === true)).toHaveLength(1)
      expect(first.flatMap(nodesOf).find(node => node.props.autoFocus === true)?.props.key).toBe('optimizer:option:0')
      const repeat = await ui.render({ ...event, props: { ...event.props, scroll: { offset: 9, bodyRows: 1 } } })
      const geometry = (value: unknown) => nodesOf(value).map(node => [node.type, node.props, contentOf(node)])
      expect(geometry(repeat)).toEqual(geometry(tree))
    }
  })

  test('compact long choice labels fit one row and keep complete numbered answers below', async ($, on) => {
    const options = ['가'.repeat(80), '✅'.repeat(30), '👨‍👩‍👧'.repeat(10), '가'.repeat(20)]
    const { controller } = fakeController(state({ ...workflow(), question: '선택?', options }))
    const ui = await captureUi($, on, controller)
    const tree = await ui.render({ ...PANE, viewport: { columns: 80, rows: 24, isFullscreen: true }, props: { ...PANE.props, placement: 'inline', bodyColumns: 74 } }) as UiNode
    const buttons = nodesOf(tree).filter(node => String(node.props.key).startsWith('optimizer:option:'))
    expect(buttons).toHaveLength(4)
    for (const option of options) expect(contentOf(tree)).toContain(option)
    expect(buttons.every(node => String(node.props.label).endsWith('…'))).toBe(true)
    expect(buttons.every(node => hardWrapPreview(String(node.props.label), 14, 1)[0] === node.props.label)).toBe(true)
  })

  test('compact states preserve full draft, messages, questions and errors below bounded previews', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const event = { ...PANE, viewport: { columns: 80, rows: 20, isFullscreen: true }, props: { ...PANE.props, placement: 'inline' as const, bodyColumns: 12 } }
    for (const phase of ['generating', 'reviewing', 'failed'] as const) {
      current.workflow = { ...workflow(phase), draft: '첫 문단\n\n둘째 문단 👨‍👩‍👧', message: '첫 메시지\n\n둘째 메시지', question: '첫 질문\n\n둘째 질문', options: ['보고서'], lastError: phase === 'failed' ? '연결 오류\n다시 시도' : undefined }
      const tree = await ui.render(event) as UiNode
      expect(tree.children!.slice(0, -1).length).toBeLessThanOrEqual(4)
      for (const full of [current.workflow.draft, current.workflow.message!, current.workflow.question!]) expect(contentOf(tree)).toContain(full)
      if (phase === 'failed') expect(contentOf(tree)).toContain('연결 오류\n다시 시도')
      if (phase === 'generating') expect(textOf(tree)).not.toContain('optimizer:option:')
    }
  })

  test('band caps rows at host maxRows and half the screen without scroll feedback', async ($, on) => {
    const current = state({ ...workflow(), message: '✅'.repeat(1200), question: '질문 '.repeat(100), options: ['보고서', '요약'], lastError: '오류\n내용' })
    const { controller } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    await ui.render(PANE)
    invalidations.length = 0
    for (const rows of [20, 24, 40]) for (const maxRows of [1, 2, 3, 4, 12, 40]) {
      const event = { ...BAND, viewport: { columns: 80, rows }, props: { ...BAND.props, bodyColumns: 74, maxRows } }
      const tree = await ui.render(event) as UiNode
      expect(tree.children!.length).toBeLessThanOrEqual(Math.min(maxRows, Math.floor(rows / 2)))
      expect(textOf(tree)).not.toContain('optimizer:option:')
      expect(textOf(await ui.render({ ...event, props: { ...event.props, scroll: { offset: 99, bodyRows: 1 } } }))).toBe(textOf(tree))
      if (maxRows >= 12) {
        expect(contentOf(tree)).toContain('패널에서 답을 고르세요')
        expect(contentOf(tree)).toContain('질문:')
        expect(contentOf(tree)).toContain('오류: 오류 내용')
      }
    }
    expect(invalidations).toHaveLength(1)
    const empty = { ...BAND, props: { ...BAND.props, maxRows: 0 } }
    expect(await ui.render(empty)).toEqual({ inner: empty })
  })

  test('band wraps wide emoji messages at grapheme boundaries and reports exact omitted rows', async ($, on) => {
    const { controller } = fakeController(state({ ...workflow(), message: '👨‍👩‍👧'.repeat(40) }))
    const ui = await captureUi($, on, controller)
    const tree = await ui.render({ ...BAND, props: { ...BAND.props, bodyColumns: 10, maxRows: 5 } }) as UiNode
    const rows = tree.children!.map(contentOf)
    expect(rows).toHaveLength(5)
    expect(rows.slice(1, 3)).toEqual(['👨‍👩‍👧'.repeat(4), '👨‍👩‍👧'.repeat(4)])
    expect(rows[3]).toBe(`${'👨‍👩‍👧'.repeat(3)}…`)
    expect(rows[4]).toContain('… 7줄 더')
  })

  test('composer band includes message, question, numbered answers, draft and shared guide', async ($, on) => {
    const item = { ...workflow(), ui: 'composer' as const, message: '다듬었습니다', question: '형식?', options: ['보고서', '목록', '표', '요약'] }
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    const tree = await ui.render({ ...BAND, props: { ...BAND.props, bodyColumns: 200, maxRows: 20 } }) as UiNode
    const drawn = contentOf(tree)
    for (const text of [item.message, item.question, item.draft, COMPOSER_GUIDE, '1. 보고서', '2. 목록', '3. 표', '4. 요약']) expect(drawn).toContain(text)
    expect(nodesOf(tree).every(node => !['Button', 'Input'].includes(node.type))).toBe(true)
    expect(tree.children!.length).toBeLessThanOrEqual(20)
    expect(contentOf(await ui.render(PANE))).toContain('개선 대화는 입력창에서 진행 중입니다')
  })

  test('composer long content retains each answer and draft preview inside its cap', async ($, on) => {
    const item = { ...workflow(), ui: 'composer' as const, message: '메시지 '.repeat(200), question: '어떤 형태를 원하시나요?', options: ['보고서', '목록', '표', '요약'], draft: '개선안 '.repeat(400) }
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    const tree = await ui.render({ ...BAND, viewport: { columns: 80, rows: 24 }, props: { ...BAND.props, maxRows: 40, bodyColumns: 74 } }) as UiNode
    expect(tree.children!).toHaveLength(12)
    for (const text of ['메시지', '질문:', '1. 보고서', '2. 목록', '3. 표', '4. 요약', '개선안:', '보완 내용을 입력해 Enter']) expect(contentOf(tree)).toContain(text)
    expect(contentOf(tree)).toContain('줄 더')
  })

  test('surveys, agent views and unsupported surfaces yield; panel still preserves draft and question', async ($, on) => {
    const current = state({ ...workflow(), question: '형식?', options: ['목록'] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const event of [ { ...BAND, props: { ...BAND.props, hasSurvey: true } }, { ...BAND, props: { ...BAND.props, view: { agentId: 'other' } } }, { ...BAND, surface: 'mobile' as const }, { ...BAND, surface: 'vscode' as const } ]) expect(await ui.render(event)).toEqual({ inner: event })
    const pane = contentOf(await ui.render(PANE))
    expect(pane).toContain('형식?')
    expect(pane).toContain(current.workflow!.draft)
    expect(pane).toContain('추가 조건이 있나요?')
    current.workflow = null
    expect(await ui.render(BAND)).toEqual({ inner: BAND })
    expect(contentOf(await ui.render(PANE))).toContain('진행 중인 개선 작업이 없습니다')
  })

  test('band eligibility transitions preserve draft and restore message fallback once', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    await ui.render(PANE)
    invalidations.length = 0
    for (const props of [{ ...BAND.props, hasSurvey: true }, { ...BAND.props, view: { agentId: 'other' } }]) {
      await ui.render(BAND); await ui.render(BAND)
      expect(invalidations).toHaveLength(1)
      expect(contentOf(await ui.render(PANE))).toContain('한국어로 작성한 개선안입니다.')
      expect(contentOf(await ui.render(PANE))).not.toContain('추가 조건이 있나요?')
      await ui.render({ ...BAND, props }); await ui.render({ ...BAND, props })
      expect(invalidations).toHaveLength(2)
      expect(contentOf(await ui.render(PANE))).toContain('추가 조건이 있나요?')
      invalidations.length = 0
    }
  })

  test('all phases use theme colors and explicit unavailable/progress/error text', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const [phase, label, color] of [['idle', '대기', 'inactive'], ['collecting', '수집 중', 'warning'], ['generating', '생성 중', 'warning'], ['reviewing', '검토', 'success'], ['failed', '실패', 'error'], ['transferring', '전달 중', 'warning'], ['sending', '전송 중', 'warning']] as const) {
      current.workflow = { ...workflow(phase), draft: '', dialogue: [], lastError: phase === 'failed' ? '네트워크 오류' : undefined }
      const pane = await ui.render(PANE)
      const band = await ui.render(BAND)
      expect(textNode(pane, `[${label}]`)?.props.color).toBe(color)
      expect(textNode(band, `[${label}]`)?.props.color).toBe(color)
      expect(textNode(pane, '1: 입력창에 넣기 · 사용 불가')?.props.dimColor).toBe(true)
      if (phase === 'failed') {
        expect(textNode(pane, '오류: 네트워크 오류')?.props.color).toBe('error')
        expect(textNode(band, '오류: 네트워크 오류')?.props.color).toBe('error')
      }
    }
    current.workflow = { ...workflow('failed'), lastError: '보완 실패' }
    expect(contentOf(await ui.render(PANE))).toContain(current.workflow.draft)
  })

  test('Button-less surfaces show numbered choices and direct command input', async ($, on) => {
    const current = state({ ...workflow(), question: '형식?', options: ['보고서', '목록'] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller, 'Button')
    for (const rows of [24, 40]) {
      const tree = await ui.render({ ...PANE, viewport: { columns: 80, rows }, props: { ...PANE.props, placement: 'inline' } })
      for (const text of ['질문: 형식?', '1. 보고서', '2. 목록', '개선안', '/optimize retry <선택지 답변 또는 보완 내용>', current.workflow!.draft]) expect(contentOf(tree)).toContain(text)
      expect(nodesOf(tree).every(node => !['Button', 'Input'].includes(node.type))).toBe(true)
    }
  })

  test('compact Button-less first view stays within rows while preserving all answer text', async ($, on) => {
    const item = { ...workflow('failed'), draft: '한국어 개선안 '.repeat(80), message: '검토 메시지', question: '어떤 형식?', options: ['보고서', '목록', '표', '요약'], lastError: '네트워크 오류' }
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller, 'Button')
    for (const [rows, isFullscreen, budget] of [[24, false, 11], [24, true, 6], [20, true, 4]] as const) {
      const tree = await ui.render({ ...PANE, viewport: { columns: 80, rows, isFullscreen }, props: { ...PANE.props, placement: 'inline' } }) as UiNode
      expect(tree.children!.slice(0, -1).length).toBeLessThanOrEqual(budget)
      for (const text of [item.draft, item.message, item.question, '1. 보고서', '2. 목록', '3. 표', '4. 요약', '/optimize retry <선택지 답변 또는 보완 내용>']) expect(contentOf(tree)).toContain(text)
      expect(nodesOf(tree).every(node => !['Button', 'Input'].includes(node.type))).toBe(true)
    }
  })

  test('digit actions remain distinct from answers and hint follows question focus', async ($, on) => {
    const current = state({ ...workflow(), question: '형식?', options: ['목록'] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const tree = await ui.render(PANE)
    const buttons = nodesOf(tree).filter(node => node.type === 'Button')
    expect(buttons.map(node => node.props.hotkey)).toEqual(['a', '1', '2', '3', '0'])
    expect(contentOf(tree)).toContain('답변 선택')
    expect(contentOf(tree)).not.toContain('Enter 입력창')
    current.workflow = workflow()
    expect(nodesOf(await ui.render(PANE)).find(node => node.props.key === 'optimizer:accept')?.props.autoFocus).toBe(true)
  })

  test('original toggle works for short and long originals, stays in panel, and ignores busy presses', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const original of ['짧은 원문', '긴 원문 '.repeat(200)]) {
      current.workflow!.original = original
      const press = () => ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:original' })
      expect(contentOf(await ui.render(PANE))).not.toContain(original)
      await press()
      expect(contentOf(await ui.render(PANE))).toContain(original)
      expect(contentOf(await ui.render(BAND))).not.toContain(original)
      current.workflow!.phase = 'sending'
      const disabled = await ui.render(PANE)
      expect(contentOf(disabled)).toContain('원문 접기 · 사용 불가')
      await press()
      expect(contentOf(await ui.render(PANE))).toContain(original)
      current.workflow!.phase = 'reviewing'
      await press()
    }
  })

  test('new workflows reset original visibility and surface placements', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    await ui.render(PANE)
    await ui.press({ component: 'Pane', requestId: PANE_ID, element: 'optimizer:original' })
    expect(contentOf(await ui.render(PANE))).toContain('원래 요청')
    current.workflow = { ...workflow(), id: 'workflow-2', question: '새 질문?', options: ['목록'] }
    const compact = { ...BAND, viewport: { columns: 80, rows: 24 } }
    expect(await ui.render(compact)).toEqual({ inner: compact })
    expect(contentOf(await ui.render(PANE))).not.toContain('원래 요청')
  })

  test('presenter logs structured message instead of legacy combined dialogue', () => {
    const logs: string[] = []
    const ui: UiPorts = { open: async () => ({ isPlaced: true }), close: async () => undefined, invalidate: () => undefined, status: () => undefined, log: text => { logs.push(text) }, toast: () => undefined }
    const current = state({ ...workflow(), ui: 'composer', message: '한국어 메시지' })
    const presenter = createPresenter()
    presenter.present(ui, current); presenter.present(ui, current)
    expect(logs.filter(text => text.startsWith('옵티마이저:'))).toEqual(['옵티마이저: 한국어 메시지'])
  })

  test('presenter falls back to the dialogue on an empty message so a lone question still logs', () => {
    const logs: string[] = []
    const ui: UiPorts = { open: async () => ({ isPlaced: true }), close: async () => undefined, invalidate: () => undefined, status: () => undefined, log: text => { logs.push(text) }, toast: () => undefined }
    const current = state({
      ...workflow(),
      ui: 'composer',
      message: '',
      question: '어느 쪽인가요?',
      options: ['보고서', '목록'],
      dialogue: [{ role: 'optimizer', text: '어느 쪽인가요?' }],
    })
    const presenter = createPresenter()
    presenter.present(ui, current)
    expect(logs.filter(text => text.startsWith('옵티마이저:'))).toEqual(['옵티마이저: 어느 쪽인가요?'])
  })

  test('PromptHint adds the optimizer-off tail only while the mode is armed', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const HINT: RenderInput<'PromptHint', 'terminal'> = {
      component: 'PromptHint', surface: 'terminal', requestId: 'hint',
      viewport: { columns: 80, rows: 40 },
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    }
    // Mode off: the event passes through unchanged.
    expect(await ui.render(HINT)).toEqual({ inner: HINT })

    // Mode on: the tail is added, replacing whatever the engine offered.
    current.rawMode = { sessionId: 'session-1', draft: '' }
    expect(RAW_MODE_BADGE_HINT).toBe('최적화 끔 ctrl+u 켜기')
    expect(await ui.render(HINT)).toEqual({
      inner: { ...HINT, props: { ...HINT.props, tail: RAW_MODE_BADGE_HINT } },
    })
    expect(await ui.render({ ...HINT, surface: 'desktop' })).toEqual({
      inner: { ...HINT, surface: 'desktop', props: { ...HINT.props, tail: RAW_MODE_BADGE_HINT } },
    })

    // Only the surfaces that draw `tail` are touched.
    for (const surface of ['mobile', 'vscode'] as const) {
      const event: RenderInput<'PromptHint', typeof surface> = { ...HINT, surface }
      expect(await ui.render(event)).toEqual({ inner: event })
    }

    // Mode off again: an engine tail is left as it is.
    current.rawMode = null
    const withTail: RenderInput<'PromptHint', 'terminal'> = {
      ...HINT,
      props: { ...HINT.props, tail: 'engine tail' },
    }
    expect(await ui.render(withTail)).toEqual({ inner: withTail })
  })

  test('band yields to vscode and mobile even with an active pane workflow', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    for (const surface of ['vscode', 'mobile'] as const) {
      const event = { ...BAND, surface }
      expect(await ui.render(event)).toEqual({ inner: event })
    }
    // The same workflow still draws on a surface that has a band.
    expect(textOf(await ui.render(BAND))).toContain('추가 조건이 있나요?')
  })

  test('pane-mode band omits the composer guide', async ($, on) => {
    const { controller } = fakeController(state(workflow()))
    const ui = await captureUi($, on, controller)
    const drawn = textOf(await ui.render(BAND))
    expect(drawn).toContain('추가 조건이 있나요?')
    expect(drawn).not.toContain(COMPOSER_GUIDE)
  })

  test('compact viewport uses screen rows and pane placement; pane ignores bodyRows', async ($, on) => {
    expect(isCompactViewport({ columns: 80, rows: 24 })).toBe(true)
    expect(isCompactViewport({ columns: 80, rows: 48 })).toBe(false)
    expect(isCompactViewport({ columns: 120, rows: 30, isFullscreen: true })).toBe(true)
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
      expect(compact).toContain('"label":"1: 넣기"')
      expect(compact).toContain('"label":"보완"')
    }
    for (const full of [await paneAt('inline', 2, 48), await paneAt('dock', 2, 24), await paneAt('inline', 2, 24, false)]) {
      expect(textOf(full)).toContain('"label":"1: 입력창에 넣기 (수정 후 전송)"')
    }
  })

  test('measured inline row budgets leave three control rows', () => {
    for (const [rows, isFullscreen, expectedRows, previewLines] of [
      [20, true, 4, 1], [24, true, 6, 3],
      [24, false, 11, 8], [20, false, 7, 4],
    ] as const) {
      const estimated = estimatedCompactRows({ columns: 80, rows, isFullscreen })
      expect(estimated).toBe(expectedRows)
      expect(Math.max(1, estimated - 3)).toBe(previewLines)
    }
    expect(estimatedCompactRows({ columns: 80, rows: 20 })).toBe(4)
    expect(estimatedCompactRows({ columns: 80, rows: 80, isFullscreen: false })).toBe(PANE_ROWS)
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
    expect(hardWrapPreview('가a', 1, 3)).toEqual(['…', 'a'])
    expect(hardWrapPreview('가나', 1, 1)).toEqual(['…'])
    expect(hardWrapPreview('', 5, 3)).toEqual([])
    expect(hardWrapPreview('\n   \n\t', 5, 2)).toEqual([])
    expect(hardWrapPreview('abc\n \n', 5, 1)).toEqual(['abc'])
    expect(hardWrapPreview(' \n abc \n ', 5, 1)).toEqual(['abc'])
  })

  test('hard-wrap status distinguishes complete previews, row overflow, and wide-glyph replacement', () => {
    expect(hardWrapPreviewWithStatus('abc', 3, 1)).toEqual({ lines: ['abc'], truncated: false, altered: false })
    expect(hardWrapPreviewWithStatus('abc\ndef', 3, 1)).toEqual({ lines: ['ab…'], truncated: true, altered: false })
    expect(hardWrapPreviewWithStatus('가a', 1, 3)).toEqual({ lines: ['…', 'a'], truncated: true, altered: false })
    expect(hardWrapPreviewWithStatus('a\n\nb', 3, 3)).toEqual({ lines: ['a', 'b'], truncated: false, altered: true })
  })

  test('emoji presentation is wide, text symbols stay narrow, and selectors and joiners are zero-width', () => {
    for (const char of ['⌚', '⏩', '⏰', '⏳', '◽', '☔', '♈', '♿', '⚓', '⚡', '⚪', '⚽', '⛄', '⛎', '⛔', '⛪', '⛲', '⛵', '⛺', '⛽',
      '✅', '✊', '✨', '❌', '❎', '❓', '❗', '➕', '➰', '➿', '⬛', '⭐', '⭕', '🀄', '🃏', '🆎', '🆑', '🈁', '😀', '🚀', '🟠', '🤌', '🩷']) {
      expect(hardWrapPreview(char.repeat(3), 4, 3)).toEqual([char.repeat(2), char])
    }
    expect(hardWrapPreview('✓✓✓', 3, 1)).toEqual(['✓✓✓'])
    expect(hardWrapPreview('✅\ufe0f✅\ufe0f', 4, 1)).toEqual(['✅\ufe0f✅\ufe0f'])
    // A joined emoji measures as one wide glyph; the sequence is never split.
    expect(hardWrapPreview('👩\u200d💻', 4, 1)).toEqual(['👩\u200d💻'])
    expect(hardWrapPreview('👩\u200d💻', 2, 1)).toEqual(['👩\u200d💻'])
  })

  test('emoji sequences measure per grapheme: VS16, ZWJ joins and flags', () => {
    // U+1F7F0 has emoji presentation even though it postdates older range tables.
    expect(hardWrapPreview('🟰'.repeat(3), 4, 3)).toEqual(['🟰🟰', '🟰'])
    // VS16 requests the wide emoji presentation; the bare sign stays narrow.
    expect(hardWrapPreview('⚠️'.repeat(3), 4, 3)).toEqual(['⚠️⚠️', '⚠️'])
    expect(hardWrapPreview('⚠'.repeat(4), 4, 3)).toEqual(['⚠⚠⚠⚠'])
    // 🏷 defaults to text presentation: narrow alone, wide with VS16.
    expect(hardWrapPreview('🏷🏷🏷', 3, 3)).toEqual(['🏷🏷🏷'])
    expect(hardWrapPreview('🏷️'.repeat(3), 4, 3)).toEqual(['🏷️🏷️', '🏷️'])
    // A joined family and a flag pair are one two-cell glyph, never split.
    expect(hardWrapPreview('👨‍👩‍👧', 2, 3)).toEqual(['👨‍👩‍👧'])
    expect(hardWrapPreview('🇰🇷'.repeat(3), 4, 3)).toEqual(['🇰🇷🇰🇷', '🇰🇷'])
    expect(hardWrapPreview('a👨‍👩‍👧b', 4, 3)).toEqual(['a👨‍👩‍👧b'])
    expect(hardWrapPreview('a👨‍👩‍👧b', 2, 3)).toEqual(['a', '👨‍👩‍👧', 'b'])
  })

  test('VS16 widens only emoji bases and lone regional indicators stay narrow', () => {
    // VS16 on a non-emoji base like U+2713 keeps the text-width sign narrow.
    expect(hardWrapPreviewWithStatus('✓\ufe0fA', 2, 3)).toEqual({ lines: ['✓\ufe0fA'], truncated: false, altered: false })
    // A lone regional indicator is one cell; only the flag pair is two.
    expect(hardWrapPreviewWithStatus('🇰', 1, 3)).toEqual({ lines: ['🇰'], truncated: false, altered: false })
    expect(hardWrapPreview('🇰🇷', 2, 3)).toEqual(['🇰🇷'])
    // A keycap sequence keeps its emoji base and stays two cells wide.
    expect(hardWrapPreview('1\ufe0f\u20e3'.repeat(3), 4, 3)).toEqual(['1\ufe0f\u20e3'.repeat(2), '1\ufe0f\u20e3'])
    // A combining accent and leading lone selectors or joiners add no cells.
    expect(hardWrapPreview('e\u0301e\u0301e\u0301', 3, 3)).toEqual(['e\u0301e\u0301e\u0301'])
    expect(hardWrapPreview('\ufe0f\u200d가', 2, 3)).toEqual(['\ufe0f\u200d가'])
  })

  test('compact band waits for its surface placement and avoids repeated invalidation across surfaces', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    const compactBand = { ...BAND, viewport: { columns: 80, rows: 24 } }
    const compactPane = { ...PANE, viewport: { columns: 80, rows: 24 }, props: { ...PANE.props, placement: 'inline' as const } }
    const dockPane = { ...compactPane, props: { ...compactPane.props, placement: 'dock' as const } }
    // An unknown placement never flashes a band before the pane resolves it.
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
    const beforeInlineFirst = invalidations.length
    await ui.render(compactPane)
    expect(invalidations).toHaveLength(beforeInlineFirst + 1)
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
    expect(invalidations).toHaveLength(beforeInlineFirst + 1)
    const beforeDock = invalidations.length
    await ui.render(dockPane)
    expect(invalidations).toHaveLength(beforeDock + 1)
    await ui.render(dockPane)
    expect(invalidations).toHaveLength(beforeDock + 1)
    expect(textOf(await ui.render(compactBand))).toContain('옵티마이저')
    const beforeInline = invalidations.length
    await ui.render(compactPane)
    expect(invalidations).toHaveLength(beforeInline + 1)
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
    const afterBandTransition = invalidations.length
    await ui.render(compactPane)
    await ui.render(compactBand)
    expect(invalidations).toHaveLength(afterBandTransition)
    const desktopBand = { ...compactBand, surface: 'desktop' as const }
    expect(await ui.render(desktopBand)).toEqual({ inner: desktopBand })
    const desktopDockPane = { ...dockPane, surface: 'desktop' as const }
    await ui.render(desktopDockPane)
    expect(textOf(await ui.render(desktopBand))).toContain('옵티마이저')
    const stableInvalidations = invalidations.length
    await ui.render(compactPane)
    await ui.render(desktopDockPane)
    await ui.render(compactPane)
    await ui.render(desktopDockPane)
    expect(invalidations).toHaveLength(stableInvalidations)
    await ui.render(dockPane)
    expect(invalidations).toHaveLength(stableInvalidations + 1)
    expect(textOf(await ui.render(desktopBand))).toContain('옵티마이저')
    current.workflow = { ...workflow(), ui: 'composer' }
    expect(textOf(await ui.render(compactBand))).toContain('옵티마이저')
  })

  test('ui.close clears pane placement and restores the band for a surviving workflow', async ($, on) => {
    const current = state(workflow('sending'))
    const { controller, calls } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    const compactBand = { ...BAND, viewport: { columns: 80, rows: 24 } }
    const compactPane = { ...PANE, viewport: { columns: 80, rows: 24 }, props: { ...PANE.props, placement: 'inline' as const } }
    await ui.render(compactPane)
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
    const beforeClose = invalidations.length
    await ui.close({ id: PANE_ID, origin: { kind: 'person' } })
    expect(calls).toEqual([])
    expect(invalidations).toHaveLength(beforeClose + 1)
    expect(textOf(await ui.render(compactBand))).toContain('옵티마이저')
    await ui.render(compactPane)
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
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
    expect(DEFAULT_CONFIG.maxRounds).toBe(5)
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

describe('question dialog guidance', () => {
  test('band and pane switch dialog guidance back to the pane fallback on close', async ($, on) => {
    const item = { ...workflow(), question: '대상 독자는 누구인가요?', options: ['경영진', '개발팀'], questionAsk: 'pending' as 'pending' | 'closed' }
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const guide = '→ 선택 창에서 답을 고르세요 (Esc: 패널에서 답하기)'
    const readable = (tree: unknown) => contentOf(tree).replace(/\n/g, '')
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      if (surface === 'terminal' || surface === 'desktop') {
        expect(readable(await ui.render({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 120 } }))).toContain(guide)
      }
      const pane = await ui.render({ ...PANE, surface })
      expect(contentOf(pane)).toContain(guide)
      expect(textOf(pane)).toContain('optimizer:option:0')
      if (surface !== 'mobile') expect(textOf(pane)).toContain('optimizer:instruction')
    }
    item.questionAsk = 'closed'
    expect(contentOf(await ui.render(BAND))).toContain('→ 패널에서 답을 고르세요')
    expect(contentOf(await ui.render(PANE))).toContain('→ 패널에서 답을 고르세요')
    expect(contentOf(await ui.render(PANE))).not.toContain('선택 창에서')
  })

  test('compact and buttonless panes retain dialog guidance and fallback answers', async ($, on) => {
    const item: Workflow = { ...workflow(), question: '대상 독자는 누구인가요?', options: ['경영진', '개발팀'], questionAsk: 'pending' }
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller, 'Button')
    for (const questionAsk of ['pending', 'closed'] as const) {
      item.questionAsk = questionAsk
      for (const [rows, isFullscreen] of [[24, false], [24, true], [20, true]] as const) {
        const viewport = { columns: 80, rows, isFullscreen }
        const pane = await ui.render({ ...PANE, viewport, props: { ...PANE.props, placement: 'inline' } }) as UiNode
        const first = pane.children!.slice(0, -1)
        expect(first.length).toBeLessThanOrEqual(estimatedCompactRows(viewport))
        const guide = questionAsk === 'pending'
          ? '→ 선택 창에서 답을 고르세요 (Esc: 패널에서 답하기)'
          : '→ 패널에서 답을 고르세요'
        expect(first.map(contentOf).join('')).toContain(guide)
        expect(contentOf(pane)).toContain('1. 경영진')
        expect(contentOf(pane)).toContain('/optimize retry')
      }
    }
  })
})
