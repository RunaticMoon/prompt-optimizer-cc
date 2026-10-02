/* @jsxRuntime classic */
/* @jsx h */
import type { EngineInterface, On, RenderViewport } from 'claude-code'

import type { OptimizerController } from '../controller'
import { PANE_ID } from '../controller'
import { DEFAULT_CONFIG, type EnginePorts, type Workflow } from '../contracts'
import { RAW_MODE_HINT } from '../raw-mode'
import { COMPOSER_GUIDE, phaseLabel } from './present'
import { PANE_ROWS } from './ui-ports'

const BUSY_PHASES: readonly Workflow['phase'][] = ['idle', 'collecting', 'generating', 'transferring', 'sending']
const isBusy = (phase: Workflow['phase']): boolean => BUSY_PHASES.includes(phase)
// Compact treatment is based on terminal height. Pane placement is tracked
// separately because a dock viewport reports transcript width, not screen width.
const COMPACT_VIEWPORT_ROWS = 40

export function isCompactViewport(viewport?: RenderViewport): boolean {
  return Boolean(viewport && viewport.rows < COMPACT_VIEWPORT_ROWS)
}

/** Budget the inline pane's first view from measured body rows. */
export function estimatedCompactRows(viewport: RenderViewport): number {
  // At 80×24, main-screen has 11 rows and fullscreen has 6; at 80×20
  // they have 7 and 4. Main-screen 100×24 also has 11, fullscreen 6.
  // An unknown fullscreen flag uses the conservative fullscreen estimate.
  // Clamp to at least four even on shorter screens, so the preview and three
  // control rows may extend below the first view when fewer rows are available.
  const estimate = viewport.isFullscreen === false
    ? viewport.rows - 13
    : Math.floor((viewport.rows - 12) / 2)
  return Math.min(PANE_ROWS, Math.max(4, estimate))
}

const KEYS = {
  original: 'optimizer:original',
  instruction: 'optimizer:instruction',
  accept: 'optimizer:accept',
  send: 'optimizer:send',
  raw: 'optimizer:raw',
} as const

/** Keep `$` at the hook registration site; helpers receive only method closures. */
function portsOf($: EngineInterface): EnginePorts {
  return {
    session: {
      // The controller only calls `messages()` with no argument; the cast keeps
      // the overloaded call type without reading the method as a value.
      messages: (() => $.session.messages()) as unknown as EnginePorts['session']['messages'],
      cwd: () => $.session.cwd(),
      root: () => $.session.root(),
      repo: () => $.session.repo(),
      model: () => $.session.model(),
    },
    clock: { sleep: (ms, options) => $.clock.sleep(ms, options) },
    fs: {
      stat: path => $.fs.stat(path),
      read: ((path: string) => $.fs.read(path)) as unknown as EnginePorts['fs']['read'],
    },
    // The loader wants a literal env name; `HOME` is the only one read.
    env: { get: () => $.env.get('HOME') },
    model: { complete: (request, options) => $.model.complete(request, options) },
    prompt: {
      read: () => $.prompt.read(),
      fill: args => $.prompt.fill(args),
      submit: args => $.prompt.submit(args),
    },
    ui: { close: args => $.ui.close(args) },
  }
}

function canAct(workflow: Workflow | null): workflow is Workflow {
  return Boolean(workflow && !isBusy(workflow.phase))
}

function latestOptimizerMessage(workflow: Workflow): string {
  return [...workflow.dialogue].reverse().find((entry) => entry.role === 'optimizer')?.text ?? ''
}

/** Terminal cell width for the wide characters used by the preview. */
function cellWidth(char: string): number {
  const code = char.codePointAt(0)!
  if (code >= 0x300 && code <= 0x36f) return 0 // combining marks
  return code >= 0x1100 && (
    code <= 0x115f || code >= 0x2329 && code <= 0x232a
    || code >= 0x2e80 && code <= 0xa4cf
    || code >= 0xac00 && code <= 0xd7a3
    || code >= 0xf900 && code <= 0xfaff
    || code >= 0xfe10 && code <= 0xfe6f
    || code >= 0xff01 && code <= 0xff60
    || code >= 0xffe0 && code <= 0xffe6
    || code >= 0x1f300 && code <= 0x1faff
    || code >= 0x20000 && code <= 0x3fffd
  ) ? 2 : 1
}

/** Hard-wrap by cells; report overflow, replacement, and whitespace changes. */
export function hardWrapPreviewWithStatus(value: string, columns: number, maxLines: number): { lines: string[]; truncated: boolean; altered: boolean } {
  if (columns < 1 || maxLines < 1) return { lines: [], truncated: Boolean(value), altered: false }
  const lines: string[] = []
  let truncated = false
  let altered = false
  // Empty source rows are omitted to reserve the compact first view for its
  // controls. The full text keeps its original paragraphs below or in the band.
  const sourceLines = value.replace(/\r\n?/g, '\n').split('\n')
  outer: for (const rawLine of sourceLines) {
    const sourceLine = rawLine.replace(/[^\S\n]+/g, ' ').trim()
    if (rawLine !== sourceLine || (!sourceLine && sourceLines.length > 1)) altered = true
    if (!sourceLine) continue
    let line = ''
    let used = 0
    for (const char of sourceLine) {
      const width = cellWidth(char)
      if (used + width > columns) {
        if (!line) { // Replace an unfit wide glyph; continue with the next.
          lines.push('…')
          truncated = true
          if (lines.length > maxLines) break outer
          continue
        }
        lines.push(line)
        if (lines.length > maxLines) { truncated = true; break outer }
        line = ''
        used = 0
        if (width > columns) {
          lines.push('…')
          truncated = true
          if (lines.length > maxLines) break outer
          continue
        }
      }
      line += char
      used += width
    }
    if (line) {
      lines.push(line)
      if (lines.length > maxLines) { truncated = true; break }
    }
  }
  if (lines.length > maxLines) {
    const visible = lines.slice(0, maxLines)
    const last = Array.from(visible[maxLines - 1] ?? '')
    while (last.reduce((sum, char) => sum + cellWidth(char), 0) + 1 > columns) last.pop()
    visible[maxLines - 1] = `${last.join('').trimEnd()}…`
    return { lines: visible, truncated: true, altered }
  }
  return { lines, truncated, altered }
}

/** Each returned Text occupies one row; retain the existing array API. */
export function hardWrapPreview(value: string, columns: number, maxLines: number): string[] {
  return hardWrapPreviewWithStatus(value, columns, maxLines).lines
}

/** Escape and the pane close mark both arrive with origin `person`. */
export async function handlePaneClose(
  controller: OptimizerController,
  ports: EnginePorts,
  origin: 'person' | 'plugin' | 'unload',
): Promise<void> {
  const workflow = controller.getState().workflow
  if (origin === 'person' && workflow?.ui === 'pane' && !['transferring', 'sending'].includes(workflow.phase)) {
    await controller.cancel(ports)
  }
}

/** The UI owns its pane, band, and input events; all foreign instances pass through. */
export function registerUi(
  on: On,
  controller: OptimizerController,
  getMaxRounds: () => number = () => DEFAULT_CONFIG.maxRounds,
  pluginName = 'prompt-optimizer',
): void {
  let showOriginal = false
  let renderedWorkflowId: string | undefined
  const panePlacements = new Map<string, 'inline' | 'dock'>()
  let paneClosed = false
  const drawnBands = new Set<string>()
  const bandKey = (id: string, surface: string) => `${id}:${surface}`
  const observeWorkflow = (workflow: Workflow | null): void => {
    if (renderedWorkflowId === workflow?.id) return
    renderedWorkflowId = workflow?.id
    showOriginal = false
    panePlacements.clear()
    paneClosed = false
    drawnBands.clear()
  }

  // The optimizer-off mode shows its hint at the end of the engine's own hint
  // line: only the surfaces that draw `tail` are touched, everything else
  // passes unchanged. The line repaints only when the mode flips (`register.ts`
  // invalidates then).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = controller.getState()
    if (s.rawMode === null || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    return next({ ...e, props: { ...e.props, tail: RAW_MODE_HINT } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const workflow = controller.getState().workflow
    observeWorkflow(workflow)
    const eligible = workflow && !e.props.hasSurvey && !e.props.view.agentId
      && (e.surface === 'terminal' || e.surface === 'desktop')
      && !(workflow.ui === 'pane' && !paneClosed && isCompactViewport(e.viewport)
        && panePlacements.get(e.surface) !== 'dock')
    const key = workflow ? bandKey(workflow.id, e.surface) : undefined
    if (!eligible || !workflow || !key) {
      if (key && drawnBands.delete(key)) $.ui.invalidate('ui.render')
      return next(e)
    }

    const { Box, Text } = await $.ui.resolve(e)
    const originalChars = Array.from(workflow.original)
    const original = workflow.ui === 'composer' || showOriginal || originalChars.length <= 180
      ? workflow.original
      : `${originalChars.slice(0, 180).join('')}…`
    const busy = isBusy(workflow.phase)
    // RenderResultOf has no accepted/denied signal for a tree. Keep the key
    // stable as workflow.id+surface and invalidate only once per draw transition.
    if (!drawnBands.has(key)) {
      drawnBands.add(key)
      $.ui.invalidate('ui.render')
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>원문</Text>
        <Text wrap="wrap">{original}</Text>
        <Text bold>↓ 개선안</Text>
        <Text wrap="wrap">{workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}</Text>
        {workflow.ui === 'composer' && <Text dimColor wrap="truncate-end">{COMPOSER_GUIDE}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)

    const elements = await $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const workflow = controller.getState().workflow
    observeWorkflow(workflow)
    if (workflow?.ui === 'pane' && panePlacements.get(e.surface) !== e.props.placement) {
      panePlacements.set(e.surface, e.props.placement)
      $.ui.invalidate('ui.render')
    }
    if (workflow?.ui === 'pane') paneClosed = false
    if (!workflow) return <Text>진행 중인 개선 작업이 없습니다</Text>
    if (workflow.ui === 'composer') return <Text>개선 대화는 입력창에서 진행 중입니다. /optimize cancel로 취소할 수 있습니다.</Text>

    const maxRounds = getMaxRounds()
    const busy = isBusy(workflow.phase)
    const draftReady = Boolean(workflow.draft.trim()) && !busy
    const retryReady = !busy && workflow.rounds < maxRounds
    const tokens = Object.values(workflow.usage).reduce((sum, count) => sum + count, 0)
    const originalChars = Array.from(workflow.original)
    const originalToggleLabel = showOriginal ? '원문 접기' : '원문 전체 보기'
    const message = latestOptimizerMessage(workflow)
    const bandDrawn = drawnBands.has(bandKey(workflow.id, e.surface))

    // A surface without Button needs command text; mobile can still use its Button table.
    if (typeof Button !== 'function') {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
          <Text bold>원문</Text>
          <Text wrap="wrap">{workflow.original}</Text>
          <Text bold>현재 개선안</Text>
          <Text wrap="wrap">{workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}</Text>
          {message && (
            <Box marginTop={1} flexDirection="column">
              <Text bold>옵티마이저 메시지</Text>
              <Text wrap="wrap">{message}</Text>
            </Box>
          )}
          {workflow.lastError && <Text wrap="wrap">{`오류: ${workflow.lastError}`}</Text>}
          {busy && <Text>{`${phaseLabel(workflow.phase)} · 잠시 기다려 주세요.`}</Text>}
          <Text wrap="wrap">{'명령: /optimize accept · send · raw · cancel · retry <보완>'}</Text>
        </Box>
      )
    }

    if (e.props.placement === 'inline' && isCompactViewport(e.viewport)) {
      // Derive the budget from the viewport, never the rendered bodyRows:
      // inline panes shrink to their own content height and can feed that back.
      const estimatedRows = estimatedCompactRows(e.viewport!)
      const previewLines = Math.max(1, estimatedRows - 3)
      const previewColumns = Math.max(1, e.props.bodyColumns - 2)
      const draftPreview = workflow.draft.trim()
      const preview = draftPreview
        || (workflow.lastError ? `오류: ${workflow.lastError}` : '')
        || (busy ? '개선안을 준비하고 있습니다…' : message || '아직 개선안이 없습니다.')
      const { lines: wrappedPreview, truncated: previewTruncated, altered: previewAltered } = hardWrapPreviewWithStatus(preview, previewColumns, previewLines)
      const previewNeedsFullText = previewTruncated || previewAltered || Boolean(draftPreview && workflow.draft !== draftPreview)
      const compactInstruction = retryReady
        ? typeof Input === 'function'
          ? <Input key={KEYS.instruction} label="보완" placeholder="보완 내용" onSubmit={() => undefined} />
          : <Text wrap="truncate-end">보완: /optimize retry &lt;내용&gt;</Text>
        : <Text dimColor wrap="truncate-end">보완 (사용 불가)</Text>
      const originalPreview = showOriginal || originalChars.length <= 180
        ? workflow.original : `${originalChars.slice(0, 180).join('')}…`
      return (
        <Box flexDirection="column" paddingX={1}>
          {wrappedPreview.map((line, index) =>
            <Text key={`preview:${index}`} wrap="truncate-end">{line}</Text>)}
          {draftReady
            ? <Button key={KEYS.accept} hotkey="1" label="넣기" plain autoFocus onPress={() => undefined} />
            : <Text dimColor>1: 넣기 (사용 불가)</Text>}
          {compactInstruction}
          <Box flexDirection="row" flexWrap="wrap">
            {draftReady
              ? <Button key={KEYS.send} hotkey="2" label="전송" plain onPress={() => undefined} />
              : <Text dimColor>2: 전송 (사용 불가)</Text>}
            <Text> · </Text>
            {!busy
              ? <Button key={KEYS.raw} hotkey="3" label="원문" plain onPress={() => undefined} />
              : <Text dimColor>3: 원문 (사용 불가)</Text>}
          </Box>
          {/* Keep details below the first view: their height prevents an inline
              pane from shrinking to the compact controls and preserves context. */}
          <Box marginTop={1} flexDirection="column">
            <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
            {draftPreview && previewNeedsFullText && <Box flexDirection="column">
              <Text bold>개선안 전문</Text>
              <Text wrap="wrap">{workflow.draft}</Text>
            </Box>}
            {message && (previewNeedsFullText || preview !== message) && <Box flexDirection="column">
              <Text bold>옵티마이저 메시지</Text>
              <Text wrap="wrap">{message}</Text>
            </Box>}
            <Text bold>원문</Text>
            <Text wrap="wrap">{originalPreview}</Text>
            {originalChars.length > 180 && (busy
              ? <Text dimColor>0: {originalToggleLabel} (사용 불가)</Text>
              : <Button key={KEYS.original} hotkey="0" label={originalToggleLabel} plain onPress={() => undefined} />)}
            {workflow.lastError && (previewNeedsFullText || preview !== `오류: ${workflow.lastError}`) &&
              <Text wrap="wrap" color="error">{`오류: ${workflow.lastError}`}</Text>}
          </Box>
        </Box>
      )
    }

    const acceptAction = draftReady
      ? <Button key={KEYS.accept} hotkey="1" label="1: 입력창에 넣기 (수정 후 전송)" variant="primary" autoFocus onPress={() => undefined} />
      : <Text dimColor>[1: 입력창에 넣기 · 사용 불가]</Text>
    const sendActions = (
      <Box marginTop={1} flexDirection="row" flexWrap="wrap" gap={1}>
        {draftReady
          ? <Button key={KEYS.send} hotkey="2" label="2: 개선안 바로 전송" onPress={() => undefined} />
          : <Text dimColor>[2: 개선안 바로 전송 · 사용 불가]</Text>}
        {!busy
          ? <Button key={KEYS.raw} hotkey="3" label="3: 원문 그대로 전송" onPress={() => undefined} />
          : <Text dimColor>[3: 원문 그대로 전송 · 사용 불가]</Text>}
      </Box>
    )
    // Arrows move focus on some hosts but scroll the pane body on others, so the
    // hint teaches Tab instead. Only keys that actually work this phase are
    // advertised: a busy run cannot accept or send, and a run without a draft
    // has no Enter/2 to offer.
    const transferring = workflow.phase === 'transferring' || workflow.phase === 'sending'
    const keyHintText = transferring
      ? '전송 중입니다'
      : busy
        ? '생성 중에는 Esc로 취소할 수 있습니다'
        : e.props.isFocused
          ? [
              ...(draftReady ? ['Enter 입력창'] : []),
              'Tab 이동',
              ...(draftReady ? ['2 바로 전송'] : []),
              '3 원문 전송',
              'Esc 닫기',
            ].join(' · ')
          : [
              'ctrl+x tab 포커스',
              'Tab 이동',
              draftReady ? '1/2/3 선택' : '3 선택',
              'Esc 닫기',
            ].join(' · ')
    const keyHint = <Text dimColor wrap="wrap">{keyHintText}</Text>
    const instruction = retryReady
      ? typeof Input === 'function'
        ? <Input key={KEYS.instruction} label="보완 내용" placeholder="수정하거나 확인할 내용을 입력하세요" submitLabel="Enter로 다시 다듬기" onSubmit={() => undefined} />
        : <Text wrap="wrap">보완은 /optimize retry &lt;보완 내용&gt;</Text>
      : <Text dimColor>지금은 보완 요청을 입력할 수 없습니다.</Text>

    if ((e.viewport?.columns ?? e.props.bodyColumns) <= 90) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
          {keyHint}
          <Box marginTop={1}>{acceptAction}</Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>보완 요청</Text>
            {instruction}
          </Box>
          {sendActions}
          {!bandDrawn && <Box marginTop={1} flexDirection="column">
            <Text bold>원문</Text>
            <Text wrap="wrap">{workflow.original}</Text>
            <Text bold>현재 개선안</Text>
            <Text wrap="wrap">{workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}</Text>
          </Box>}
          {message && (
            <Box marginTop={1} flexDirection="column">
              <Text bold>옵티마이저 메시지</Text>
              <Text wrap="wrap">{message}</Text>
            </Box>
          )}
          {bandDrawn && originalChars.length > 180 && <Box marginTop={1}>
            {busy
              ? <Text dimColor>{`[0: ${originalToggleLabel} · 사용 불가]`}</Text>
              : <Button key={KEYS.original} hotkey="0" label={originalToggleLabel} plain onPress={() => undefined} />}
          </Box>}
          {workflow.lastError && <Text wrap="wrap" color="error">{`오류: ${workflow.lastError}`}</Text>}
          {busy && <Text dimColor>{phaseLabel(workflow.phase)} · 잠시 기다려 주세요.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
        {keyHint}
        <Box marginTop={1}>{acceptAction}</Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>보완 요청</Text>
          {instruction}
        </Box>
        {sendActions}
        {!bandDrawn && <Box marginTop={1} flexDirection="column">
          <Text bold>원문</Text>
          <Text wrap="wrap">{workflow.original}</Text>
          <Text bold>현재 개선안</Text>
          <Text wrap="wrap">{workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}</Text>
        </Box>}
        {message && (
          <Box marginTop={1} flexDirection="column">
            <Text bold>옵티마이저 메시지</Text>
            <Text wrap="wrap">{message}</Text>
          </Box>
        )}
        {bandDrawn && originalChars.length > 180 && <Box marginTop={1}>
          {busy
            ? <Text dimColor>{`[0: ${originalToggleLabel} · 사용 불가]`}</Text>
            : <Button key={KEYS.original} hotkey="0" label={originalToggleLabel} plain onPress={() => undefined} />}
        </Box>}
        {workflow.lastError && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="error">오류</Text>
            <Text wrap="wrap">{workflow.lastError}</Text>
          </Box>
        )}
        {busy && <Text dimColor>{phaseLabel(workflow.phase)} · 잠시 기다려 주세요.</Text>}
      </Box>
    )
  })

  on('ui.press', { plugin: pluginName }, async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE_ID) return next(e)
    const workflow = controller.getState().workflow
    if (!workflow || workflow.ui !== 'pane') return next(e)
    if (e.element === KEYS.original) {
      if (canAct(workflow)) {
        showOriginal = !showOriginal
        $.ui.invalidate('ui.render')
      }
      return { element: e.element }
    }

    if (!canAct(workflow)) return { element: e.element }

    const ports = portsOf($)
    if (e.element === KEYS.accept && workflow.draft.trim()) await controller.accept(ports)
    else if (e.element === KEYS.send && workflow.draft.trim()) await controller.sendDraft(ports)
    else if (e.element === KEYS.raw) await controller.sendOriginal(ports)
    else return next(e)
    return { element: e.element }
  })

  on('ui.input', { plugin: pluginName, element: KEYS.instruction }, async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE_ID || e.kind !== 'submit') return next(e)
    const workflow = controller.getState().workflow
    const instruction = e.value.trim()
    if (canAct(workflow) && workflow.ui === 'pane' && workflow.rounds < getMaxRounds() && instruction) {
      await controller.refine(portsOf($), instruction)
      const updated = controller.getState().workflow
      if (updated?.ui === 'pane' && updated.draft.trim() && canAct(updated)) {
        $.ui.invalidate('ui.render')
        try {
          await $.ui.focus({ requestId: PANE_ID, key: KEYS.accept })
        } catch {
          // Focus may be unavailable after the person moves to another site.
        }
      }
    }
    return { element: e.element, value: e.value }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    await handlePaneClose(controller, portsOf($), e.origin.kind)
    // PaneCloseInput has no surface. Forget all placements so a workflow that
    // survives the close can show its band until a pane renders again.
    panePlacements.clear()
    paneClosed = true
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
