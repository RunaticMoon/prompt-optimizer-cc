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
      : event === 'ui.input' && focusCalls
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
  test('full panes and read-only bands distinguish original, draft, sections and phase with theme keys', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const columns of [80, 120]) {
      const pane = await ui.render({ ...PANE, viewport: { columns, rows: 40 } })
      expect(textNode(pane, '원래 요청')?.props.color).toBe('text')
      expect(textNode(pane, '한국어로 작성한 개선안입니다.')?.props.color).toBe('suggestion')
      expect(textNode(pane, '보완 요청')?.props.color).toBe('text')
      expect(textNode(pane, '옵티마이저 메시지')?.props.color).toBe('text')
      const heading = nodesOf(pane).find(node => node.type === 'Text' && contentOf(node).startsWith('프롬프트 옵티마이저'))
      expect(heading?.props.color).toBe('claude')
      expect(heading?.props.bold).toBe(true)
      expect(textNode(pane, '[검토]')?.props.color).toBe('success')
      expect(textNode(pane, '  1/3회  10토큰')?.props.color).toBe('text')
    }
    const band = await ui.render(BAND)
    expect((band as UiNode).children).toHaveLength(4)
    expect(textNode(band, '원래 요청')?.props.color).toBe('text')
    expect(textNode(band, '한국어로 작성한 개선안입니다.')?.props.color).toBe('suggestion')
    expect(textNode(band, '[검토]')?.props.color).toBe('success')
    expect(nodesOf(band).filter(node => ['Button', 'Input'].includes(node.type))).toHaveLength(0)
    const label = nodesOf(band).find(node => node.type === 'Text' && contentOf(node).startsWith('↓ 개선안'))
    expect(label?.props.bold).toBe(true)
    expect(label?.props.wrap).toBe('truncate-end')
    // The composer guide occupies the same fifth row even on a short screen.
    current.workflow = { ...workflow(), ui: 'composer' }
    const composer = await ui.render({ ...BAND, viewport: { columns: 80, rows: 24 } })
    expect((composer as UiNode).children).toHaveLength(5)
    expect(textNode(composer, COMPOSER_GUIDE)?.props.dimColor).toBe(true)
  })

  test('phase colors and explicit text distinguish progress, errors and unavailable actions', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const [phase, label, color] of [
      ['idle', '대기', 'inactive'], ['collecting', '수집 중', 'warning'],
      ['generating', '생성 중', 'warning'], ['reviewing', '검토', 'success'],
      ['failed', '실패', 'error'], ['transferring', '전달 중', 'warning'],
      ['sending', '전송 중', 'warning'],
    ] as const) {
      current.workflow = { ...workflow(phase), draft: '', dialogue: [], lastError: phase === 'failed' ? '네트워크 오류' : undefined }
      const pane = await ui.render(PANE)
      const band = await ui.render(BAND)
      expect(textNode(pane, `[${label}]`)?.props.color).toBe(color)
      expect(textNode(band, `[${label}]`)?.props.color).toBe(color)
      const unavailable = textNode(pane, '[1: 입력창에 넣기 · 사용 불가]')
      expect(unavailable?.props.color).toBe('inactive')
      expect(unavailable?.props.dimColor).toBe(true)
      if (phase === 'failed') {
        expect(textNode(pane, '네트워크 오류')?.props.color).toBe('error')
        expect(textNode(band, '오류: 네트워크 오류')?.props.color).toBe('error')
      } else if (phase !== 'reviewing') {
        expect(textNode(band, '개선안을 준비하고 있습니다…')?.props.color).toBe('warning')
      }
    }
    // A refinement error must not hide the previously usable draft in the band.
    current.workflow = { ...workflow('failed'), lastError: '네트워크 오류' }
    const band = await ui.render(BAND)
    expect(textNode(band, '한국어로 작성한 개선안입니다.')?.props.color).toBe('suggestion')
    expect(textNode(band, '[실패]')?.props.color).toBe('error')
    expect(textNode(band, ' · 오류: 네트워크 오류')?.props.color).toBe('error')
    expect((band as UiNode).children).toHaveLength(4)
  })

  test('compact first views retain measured row budgets and stable geometry with button badges', async ($, on) => {
    const item = { ...workflow(), draft: '가나다라마바사아자차카타파하'.repeat(60) }
    const { controller } = fakeController(state(item))
    const ui = await captureUi($, on, controller)
    for (const [rows, isFullscreen, budget, previewRows] of [
      [24, false, 11, 8], [24, true, 6, 3], [20, false, 7, 4], [20, true, 4, 1],
    ] as const) {
      const event = { ...PANE, viewport: { columns: 80, rows, isFullscreen }, props: {
        ...PANE.props, placement: 'inline' as const, bodyColumns: 74,
      } }
      const tree = await ui.render(event)
      const root = tree as UiNode
      const firstView = root.children!.slice(0, -1) as UiNode[]
      expect(firstView).toHaveLength(budget)
      expect(firstView.slice(0, previewRows).every(node => node.type === 'Text' && node.props.color === 'suggestion' && node.props.bold === true)).toBe(true)
      expect(firstView[previewRows]?.props.key).toBe('optimizer:accept')
      expect(firstView[previewRows]?.props.label).toBe('1: 넣기')
      expect(firstView[previewRows]?.props.variant).toBe('primary')
      expect(firstView[previewRows]?.props.autoFocus).toBe(true)
      expect(firstView[previewRows + 1]?.props.key).toBe('optimizer:instruction')
      const sendRow = nodesOf(firstView[previewRows + 2])
      expect(sendRow.filter(node => node.type === 'Button').map(node => node.props.label)).toEqual(['2: 전송', '3: 원문'])
      expect(sendRow.filter(node => node.type === 'Button').every(node => node.props.plain === undefined)).toBe(true)
      expect(root.props.paddingX).toBe(1)
      // No new border, vertical padding or margin can steal a control row.
      for (const node of [root, ...firstView, ...sendRow]) {
        for (const prop of ['borderStyle', 'paddingY', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom']) {
          expect(node.props[prop]).toBeUndefined()
        }
      }
      const repeat = await ui.render({ ...event, props: { ...event.props, scroll: { offset: 0, bodyRows: 2 } } })
      // Press handles are per-draw; compare layout props and content instead.
      const geometry = (value: unknown) => nodesOf(value).map(node => [node.type, node.props, contentOf(node)])
      expect(geometry(repeat)).toEqual(geometry(tree))
      const preview = firstView.slice(0, previewRows).map(contentOf)
      expect(preview.every(line => Array.from(line).reduce((cells, char) => cells + (char === '…' ? 1 : 2), 0) <= 72)).toBe(true)
    }
  })

  test('failed compact panes prioritise the reason while keeping the draft and all row budgets', async ($, on) => {
    const current = state({ ...workflow('failed'), draft: '긴 개선안입니다. '.repeat(120), lastError: '네트워크 오류\n다시 시도' })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    for (const [rows, isFullscreen, budget] of [[24, false, 11], [24, true, 6], [20, false, 7], [20, true, 4]] as const) {
      const event = { ...PANE, viewport: { columns: 80, rows, isFullscreen }, props: {
        ...PANE.props, placement: 'inline' as const, bodyColumns: 74,
      } }
      const tree = await ui.render(event) as UiNode
      const first = tree.children!.slice(0, -1) as UiNode[]
      expect(first).toHaveLength(budget)
      expect(contentOf(first[0])).toBe('오류: 네트워크 오류 다시 시도')
      expect(first[0]?.props.color).toBe('error')
      expect(first[0]?.props.wrap).toBe('truncate-end')
      expect(first.slice(1, -3).every(node => node.props.color === 'suggestion')).toBe(true)
      expect(first[budget - 3]?.props.key).toBe('optimizer:accept')
      expect(first[budget - 2]?.props.key).toBe('optimizer:instruction')
      expect(nodesOf(first[budget - 1]).filter(node => node.type === 'Button').map(node => node.props.label)).toEqual(['2: 전송', '3: 원문'])
      expect(textNode(tree, current.workflow!.draft)?.props.color).toBe('suggestion')
      const again = await ui.render({ ...event, props: { ...event.props, scroll: { offset: 10, bodyRows: 1 } } })
      expect(contentOf(again)).toBe(contentOf(tree))
    }
  })

  test('bands cap whole rows at half the viewport and host maxRows, independent of scroll feedback', async ($, on) => {
    const current = state({ ...workflow('failed'), draft: Array.from({ length: 40 }, (_, i) => `줄 ${i + 1}`).join('\n'), lastError: '보완 실패\n다시 시도' })
    const { controller } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    for (const [isFullscreen, maxRows, expectedRows, hidden] of [[false, 40, 20, 24], [true, 16, 16, 28]] as const) {
      const event = { ...BAND, viewport: { columns: 120, rows: 40, isFullscreen }, props: {
        ...BAND.props, bodyColumns: 115, maxRows,
      } }
      const tree = await ui.render(event) as UiNode
      const lines = tree.children!.filter(child => child && typeof child === 'object').flatMap(child => contentOf(child).split('\n'))
      expect(lines).toHaveLength(expectedRows)
      expect(lines[lines.length - 1]).toBe(`… ${hidden}줄 더 · 전문: 1 입력창`)
      expect(textNode(tree, ' · 오류: 보완 실패 다시 시도')?.props.color).toBe('error')
      const title = nodesOf(tree).find(node => node.type === 'Text' && contentOf(node).startsWith('↓ 개선안'))
      expect(title?.props.wrap).toBe('truncate-end')
      const again = await ui.render({ ...event, props: { ...event.props, scroll: { offset: 4, bodyRows: 1 } } })
      expect(contentOf(again)).toBe(contentOf(tree))
    }
    expect(invalidations).toHaveLength(1)
    // Long wrapped originals and a composer guide count towards the same cap.
    current.workflow = { ...current.workflow!, ui: 'composer', original: '가'.repeat(300), draft: '나'.repeat(500) }
    const small = await ui.render({ ...BAND, viewport: { columns: 80, rows: 20 }, props: { ...BAND.props, bodyColumns: 12, maxRows: 20 } }) as UiNode
    const smallLines = small.children!.filter(child => child && typeof child === 'object').flatMap(child => contentOf(child).split('\n'))
    expect(smallLines).toHaveLength(10)
    expect(smallLines[smallLines.length - 1]).toContain('줄 더 · 전문: /optimize accept')
    for (const maxRows of [1, 2, 3, 4]) {
      const tiny = await ui.render({ ...BAND, props: { ...BAND.props, maxRows } }) as UiNode
      expect(tiny.children!.filter(child => child && typeof child === 'object').flatMap(child => contentOf(child).split('\n')).length).toBeLessThanOrEqual(maxRows)
    }
    const empty = { ...BAND, props: { ...BAND.props, maxRows: 0 } }
    expect(await ui.render(empty)).toEqual({ inner: empty })
  })

  test('expanding the band original takes priority within its cap and collapse restores the preview', async ($, on) => {
    const item = { ...workflow(), original: '원문 확인 문장입니다. '.repeat(20) + '원문끝마커',
      draft: Array.from({ length: 40 }, (_, i) => `개선안 ${i + 1}`).join('\n') }
    const current = state(item)
    const { controller } = fakeController(current)
    const invalidations: string[] = []
    const ui = await captureUi($, on, controller, undefined, undefined, undefined, invalidations)
    const toggle = () => ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })
    for (const [isFullscreen, bodyColumns, maxRows] of [[true, 68, 15], [false, 115, 40]] as const) {
      const event = { ...BAND, viewport: { columns: 120, rows: 40, isFullscreen },
        props: { ...BAND.props, bodyColumns, maxRows } }
      await ui.render({ ...PANE, props: { ...PANE.props, placement: isFullscreen ? 'dock' : 'inline' } })
      const collapsed = await ui.render(event) as UiNode
      const original = collapsed.children!.find(child => child && typeof child === 'object'
        && (child as UiNode).props.color === 'text' && contentOf(child) !== '원문')
      expect(contentOf(original).endsWith('…')).toBe(true)
      expect(contentOf(collapsed)).not.toContain('원문끝마커')
      await toggle()
      const expanded = await ui.render(event) as UiNode
      const rows = expanded.children!.filter(child => child && typeof child === 'object')
        .flatMap(child => contentOf(child).split('\n'))
      expect(rows.length).toBeLessThanOrEqual(Math.min(maxRows, 20))
      expect(contentOf(expanded).replace(/\n/g, '')).toContain(item.original)
      expect(contentOf(expanded)).toContain('줄 더 · 전문: 1 입력창')
      expect(textOf(await ui.render(PANE))).not.toContain(item.original)
      const before = invalidations.length
      for (let i = 0; i < 300; i++) {
        expect(textOf(await ui.render({ ...event, props: { ...event.props, scroll: { offset: i, bodyRows: i % 2 } } }))).toBe(textOf(expanded))
      }
      expect(invalidations).toHaveLength(before)
      await toggle()
      expect(textOf(await ui.render(event))).toBe(textOf(collapsed))
    }
    // An original longer than even the expanded budget retains its own ellipsis.
    current.workflow = { ...item, original: '가'.repeat(2000) + '원문끝마커' }
    await toggle()
    const bounded = await ui.render(BAND) as UiNode
    const rows = bounded.children!.filter(child => child && typeof child === 'object')
      .flatMap(child => contentOf(child).split('\n'))
    expect(rows).toHaveLength(BAND.props.maxRows)
    expect(rows[rows.length - 3]!.endsWith('…')).toBe(true)
    expect(rows[rows.length - 2]).toContain('↓ 개선안')
    expect(rows[rows.length - 1]).toContain('줄 더')
    expect(contentOf(bounded)).not.toContain('원문끝마커')
  })

  test('wide emoji drafts count terminal cells and retain the band overflow hint', async ($, on) => {
    const { controller } = fakeController(state({ ...workflow(), draft: '✅'.repeat(1200) }))
    const ui = await captureUi($, on, controller)
    await ui.render(PANE) // Establish dock placement for the compact-height case.
    for (const [isFullscreen, bodyColumns, maxRows, draftRows, omitted] of [
      [false, 115, 40, 16, 6], [true, 68, 15, 11, 26], [true, 74, 10, 6, 28],
    ] as const) {
      const tree = await ui.render({ ...BAND, viewport: { columns: 120, rows: isFullscreen && maxRows === 10 ? 20 : 40, isFullscreen },
        props: { ...BAND.props, bodyColumns, maxRows } }) as UiNode
      const rows = tree.children!.filter(child => child && typeof child === 'object').flatMap(child => contentOf(child).split('\n'))
      expect(rows).toHaveLength(Math.min(maxRows, 20))
      expect(rows[rows.length - 1]).toBe(`… ${omitted}줄 더 · 전문: 1 입력창`)
      const draft = nodesOf(tree).find(node => node.type === 'Text' && contentOf(node).startsWith('✅'))!
      expect(contentOf(draft).split('\n')).toHaveLength(draftRows)
      expect(contentOf(draft).split('\n').every(line => Array.from(line).length * 2 <= bodyColumns - 2)).toBe(true)
    }
  })

  test('compact fallback previews use warning, error and inactive without adding rows', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const event = { ...PANE, viewport: { columns: 80, rows: 20, isFullscreen: true }, props: {
      ...PANE.props, placement: 'inline' as const, bodyColumns: 74,
    } }
    for (const [phase, error, content, color] of [
      ['generating', undefined, '개선안을 준비하고 있습니다…', 'warning'],
      ['failed', '네트워크 오류', '오류: 네트워크 오류', 'error'],
      ['failed', undefined, '아직 개선안이 없습니다.', 'inactive'],
    ] as const) {
      current.workflow = { ...workflow(phase), draft: '', dialogue: [], lastError: error }
      const tree = await ui.render(event)
      expect(textNode(tree, content)?.props.color).toBe(color)
      expect((tree as UiNode).children).toHaveLength(5) // Four first-view rows plus details.
      expect(textNode(tree, '1: 넣기 (사용 불가)')?.props.color).toBe('inactive')
    }
  })

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
    expect(drawn.replace(/\\n/g, '')).toContain(item.original)
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
    await ui.render(PANE) // Establish placement before measuring band transitions.
    invalidations.length = 0
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

  test('band limits long bodies, keeps phase empties, and toggles the original', async ($, on) => {
    const item = workflow()
    item.original = '긴 원문 '.repeat(40)
    item.draft = '개선안 본문 '.repeat(80)
    const current = state(item)
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)

    const collapsed = textOf(await ui.render(BAND))
    expect(collapsed).toContain('개선안 본문')
    expect(collapsed).toContain('줄 더 · 전문: 1 입력창')
    expect(collapsed).not.toContain(item.draft)
    expect(collapsed).not.toContain(item.original)
    expect(collapsed).toContain('…')
    await ui.press({ component: 'Pane', requestId: PANE_ID, plugin: 'test', element: 'optimizer:original' })
    const expanded = contentOf(await ui.render(BAND))
    expect(expanded).toContain('긴 원문')
    expect(expanded).toContain('줄 더 · 전문: 1 입력창')

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

  test('VS16 emoji fill the band at two cells and keep the overflow count', async ($, on) => {
    const { controller } = fakeController(state({ ...workflow(), draft: '⚠️'.repeat(1200) }))
    const ui = await captureUi($, on, controller)
    await ui.render(PANE) // Establish dock placement for the compact-height case.
    for (const [isFullscreen, bodyColumns, maxRows, draftRows, omitted] of [
      [false, 115, 40, 16, 6], [true, 68, 15, 11, 26], [true, 74, 10, 6, 28],
    ] as const) {
      const tree = await ui.render({ ...BAND, viewport: { columns: 120, rows: isFullscreen && maxRows === 10 ? 20 : 40, isFullscreen },
        props: { ...BAND.props, bodyColumns, maxRows } }) as UiNode
      const rows = tree.children!.filter(child => child && typeof child === 'object').flatMap(child => contentOf(child).split('\n'))
      expect(rows).toHaveLength(Math.min(maxRows, 20))
      expect(rows[rows.length - 1]).toBe(`… ${omitted}줄 더 · 전문: 1 입력창`)
      const draft = nodesOf(tree).find(node => node.type === 'Text' && contentOf(node).startsWith('⚠'))!
      const lines = contentOf(draft).split('\n')
      expect(lines).toHaveLength(draftRows)
      // Each row holds whole sequences only and stays within two-cell math.
      expect(lines.every(line => /^(?:⚠️)*$/.test(line)
        && (line.match(/⚠️/g)?.length ?? 0) * 2 <= bodyColumns - 2)).toBe(true)
    }
  })

  test('compact preview wraps a joined emoji sequence whole at two cells', async ($, on) => {
    const current = state({ ...workflow(), draft: '👨‍👩‍👧'.repeat(40) })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 24 }, props: {
      ...PANE.props, placement: 'inline' as const, bodyColumns: 10,
    } }
    const tree = await ui.render(compact) as UiNode
    // Three preview rows at a 24-row screen; eight columns hold four glyphs.
    const lines = tree.children!.slice(0, 3).map(contentOf)
    expect(lines).toEqual(['👨‍👩‍👧'.repeat(4), '👨‍👩‍👧'.repeat(4), `${'👨‍👩‍👧'.repeat(3)}…`])
  })

  test('compact pane orders preview, accept, Input, send and raw before scrollable details', async ($, on) => {
    const item = workflow()
    item.original = '숨길 원문 '.repeat(40)
    item.draft = '가나다라마바사아자차카타파'
    const current = state(item)
    const { controller, calls } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 24 }, props: {
      ...PANE.props, placement: 'inline' as const, bodyColumns: 10,
      scroll: { offset: 0, bodyRows: 2 },
    } }
    const drawn = textOf(await ui.render(compact))
    // Fixed expected rows keep this render test independent of hardWrapPreview.
    const preview = ['가나다라', '마바사아', '자차카…']
    for (const line of preview) expect(drawn).toContain(line)
    expect(drawn).toContain('…')
    expect(drawn).toContain('개선안 전문')
    expect(drawn).toContain(item.draft)
    expect(drawn).not.toContain(item.original)
    expect(drawn).toContain('프롬프트 옵티마이저')
    expect(drawn).toContain('옵티마이저 메시지')
    expect(drawn).toContain('추가 조건이 있나요?')
    expect(drawn).toContain('원문 전체 보기')
    expect(drawn).toContain('"hotkey":"0"')
    expect(drawn).not.toContain('submitLabel')
    expect(drawn).toContain('"label":"보완"')
    expect(drawn).toContain('optimizer:instruction')
    for (const [key, digit, label] of [
      ['accept', '1', '넣기'], ['send', '2', '전송'], ['raw', '3', '원문'],
    ]) {
      expect(drawn).toContain(`optimizer:${key}`)
      expect(drawn).toContain(`"hotkey":"${digit}"`)
      expect(drawn).toContain(`"label":"${digit}: ${label}"`)
    }
    expect(drawn).toContain('"autoFocus":true')
    expect(drawn.indexOf(preview[0]!)).toBeLessThan(drawn.indexOf('optimizer:accept'))
    expect(drawn.indexOf('optimizer:accept')).toBeLessThan(drawn.indexOf('optimizer:instruction'))
    expect(drawn.indexOf('optimizer:instruction')).toBeLessThan(drawn.indexOf('optimizer:send'))
    expect(drawn.indexOf('optimizer:send')).toBeLessThan(drawn.indexOf('optimizer:raw'))
    expect(drawn.indexOf('optimizer:raw')).toBeLessThan(drawn.indexOf('프롬프트 옵티마이저'))
    expect(drawn.indexOf('프롬프트 옵티마이저')).toBeLessThan(drawn.indexOf('개선안 전문'))
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
    expect((failed.match(/오류: 네트워크 오류/g) ?? [])).toHaveLength(1)
    current.workflow = { ...workflow('failed'), draft: '' }
    const messageOnly = textOf(await ui.render(compact))
    expect((messageOnly.match(/추가 조건이 있나요\?/g) ?? [])).toHaveLength(1)
  })

  test('compact pane retains full truncated optimizer messages and errors below the preview', async ($, on) => {
    const current = state({ ...workflow('failed'), draft: '' })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 20 }, props: {
      ...PANE.props, placement: 'inline' as const, bodyColumns: 12,
    } }
    const longMessage = '첫 문장 뒤에도 확인해야 하는 긴 옵티마이저 메시지입니다.'
    current.workflow!.dialogue = [{ role: 'optimizer', text: longMessage }]
    const messageTree = textOf(await ui.render(compact))
    expect(messageTree).toContain('옵티마이저 메시지')
    expect(messageTree).toContain(longMessage)

    const longError = '연결이 끊겨 자세한 오류 내용을 확인해야 합니다.'
    current.workflow!.lastError = longError
    const errorTree = textOf(await ui.render(compact))
    expect(errorTree).toContain(longError)
    expect(errorTree).toContain(`오류: ${longError}`)
    expect((errorTree.match(/오류: 연결이 끊겨/g) ?? []).length).toBeGreaterThan(0)
  })

  test('compact pane preserves blank paragraphs and replaced wide glyphs in full text', async ($, on) => {
    const current = state({ ...workflow(), draft: '첫 문단\n\n둘째 문단', dialogue: [{ role: 'optimizer', text: '질문' }] })
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 24 }, props: { ...PANE.props, placement: 'inline' as const } }
    const draftTree = textOf(await ui.render(compact))
    expect(draftTree).toContain('개선안 전문')
    expect(draftTree).toContain('첫 문단\\n\\n둘째 문단')
    current.workflow = { ...current.workflow!, draft: '가a' }
    const narrowTree = textOf(await ui.render({ ...compact, props: { ...compact.props, bodyColumns: 3 } }))
    expect(narrowTree).toContain('개선안 전문')
    expect(narrowTree).toContain('가a')
    current.workflow = { ...current.workflow!, draft: '', dialogue: [{ role: 'optimizer', text: '첫 질문\n\n둘째 질문' }] }
    const messageTree = textOf(await ui.render(compact))
    expect(messageTree).toContain('옵티마이저 메시지')
    expect(messageTree).toContain('첫 질문\\n\\n둘째 질문')
  })

  test('compact original toggle appears only for originals longer than 180 characters', async ($, on) => {
    const current = state(workflow())
    const { controller } = fakeController(current)
    const ui = await captureUi($, on, controller)
    const compact = { ...PANE, viewport: { columns: 80, rows: 24 }, props: { ...PANE.props, placement: 'inline' as const } }
    expect(textOf(await ui.render(compact))).not.toContain('optimizer:original')
    current.workflow = { ...workflow(), original: '가'.repeat(180) }
    expect(textOf(await ui.render(compact))).not.toContain('optimizer:original')
    current.workflow = { ...workflow(), original: '가'.repeat(181) }
    const long = textOf(await ui.render(compact))
    expect(long).toContain('optimizer:original')
    expect(long).toContain('"hotkey":"0"')
    current.workflow = { ...current.workflow, phase: 'generating' }
    const busy = textOf(await ui.render(compact))
    expect(busy).toContain('0: ')
    expect(busy).toContain('원문 전체 보기')
    expect(busy).toContain(' (사용 불가)')
    expect(busy).not.toContain('"hotkey":"0"')
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
    expect(textOf(await ui.render(compactBand))).toContain('↓ 개선안')
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
    expect(textOf(await ui.render(desktopBand))).toContain('↓ 개선안')
    const stableInvalidations = invalidations.length
    await ui.render(compactPane)
    await ui.render(desktopDockPane)
    await ui.render(compactPane)
    await ui.render(desktopDockPane)
    expect(invalidations).toHaveLength(stableInvalidations)
    await ui.render(dockPane)
    expect(invalidations).toHaveLength(stableInvalidations + 1)
    expect(textOf(await ui.render(desktopBand))).toContain('↓ 개선안')
    current.workflow = { ...workflow(), ui: 'composer' }
    expect(textOf(await ui.render(compactBand))).toContain('↓ 개선안')
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
    expect(textOf(await ui.render(compactBand))).toContain('↓ 개선안')
    await ui.render(compactPane)
    expect(await ui.render(compactBand)).toEqual({ inner: compactBand })
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
      expect(drawn).not.toContain('"plain":true')
      expect(drawn).toContain('"label":"0: 원문 전체 보기"')
      expect(drawn).toContain('"label":"0:')
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

  test('expanded original keeps its key badge when the toggle becomes unavailable', async ($, on) => {
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
      expect(expanded).not.toContain('"plain":true')
      expect(expanded).toContain('"label":"0: 원문 접기"')
      expect(expanded).toContain('"label":"0:')
      expect(expanded).not.toContain(item.original)
      expect(contentOf(await ui.render(BAND)).replace(/\n/g, '')).toContain(item.original)

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
    expect(band).toContain('길게 작성한 개선안')
    expect(band).toContain('줄 더 · 전문: 1 입력창')
    expect(band).not.toContain(item.draft)
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
