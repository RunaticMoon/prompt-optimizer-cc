/* @jsxRuntime classic */
/* @jsx h */
import type { EngineInterface, On, RenderViewport } from 'claude-code'

import type { OptimizerController } from '../controller'
import { PANE_ID } from '../controller'
import { DEFAULT_CONFIG, type EnginePorts, type Workflow } from '../contracts'
import { COMPOSER_GUIDE, RAW_MODE_BADGE_HINT, UI_COLORS, phaseColor, phaseLabel } from './present'
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
      version: () => $.session.version(),
    },
    clock: { sleep: (ms, options) => $.clock.sleep(ms, options) },
    fs: {
      stat: (path, options) => $.fs.stat(path, options),
      read: ((path: string) => $.fs.read(path)) as unknown as EnginePorts['fs']['read'],
      list: path => $.fs.list(path),
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
  return workflow.message ?? [...workflow.dialogue].reverse().find((entry) => entry.role === 'optimizer')?.text ?? ''
}

// Width is measured per grapheme cluster so an emoji sequence — a VS16
// presentation request, a ZWJ join or a flag pair — wraps as one glyph.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const EMOJI = /\p{Emoji}/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const REGIONAL_INDICATORS = /[\u{1f1e6}-\u{1f1ff}]/gu

/** Grapheme clusters of `text`; each one wraps or ellipsizes as a single glyph. */
function graphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), part => part.segment)
}

/** Terminal cell width for one grapheme cluster. */
function cellWidth(grapheme: string): number {
  const code = grapheme.codePointAt(0)
  if (code === undefined
    || code >= 0x300 && code <= 0x36f || code === 0x200d
    || code >= 0xfe00 && code <= 0xfe0f) return 0 // combining marks, ZWJ, variation selectors
  // A regional indicator is wide only as a flag pair; a lone one is narrow,
  // so this branch runs before the emoji-presentation check it also matches.
  if (code >= 0x1f1e6 && code <= 0x1f1ff) {
    return (grapheme.match(REGIONAL_INDICATORS) ?? []).length === 2 ? 2 : 1
  }
  const first = String.fromCodePoint(code)
  // Emoji presentation occupies two cells: a VS16 request on an emoji base,
  // an emoji-presentation code point, or a joined pictographic sequence.
  if (grapheme.includes('\ufe0f') && EMOJI.test(first)
    || EMOJI_PRESENTATION.test(first)
    || grapheme.includes('\u200d') && EXTENDED_PICTOGRAPHIC.test(first)) return 2
  return code >= 0x1100 && (
    code <= 0x115f || code >= 0x2329 && code <= 0x232a
    || code >= 0x2e80 && code <= 0xa4cf
    || code >= 0xac00 && code <= 0xd7a3
    || code >= 0xf900 && code <= 0xfaff
    || code >= 0xfe10 && code <= 0xfe6f
    || code >= 0xff01 && code <= 0xff60
    || code >= 0xffe0 && code <= 0xffe6
    || code >= 0x20000 && code <= 0x3fffd
  ) ? 2 : 1
}

/** Add an overflow mark without introducing another terminal row. */
function ellipsizeLine(line: string, columns: number): string {
  const parts = graphemes(line)
  let cells = parts.reduce((sum, part) => sum + cellWidth(part), 0)
  while (cells + 1 > columns) cells -= cellWidth(parts.pop()!)
  return `${parts.join('').trimEnd()}…`
}

/** Hard-wrap by cells; report overflow, replacement, and whitespace changes. */
export function hardWrapPreviewWithStatus(value: string, columns: number, maxLines: number): { lines: string[]; truncated: boolean; altered: boolean } {
  if (columns < 1 || maxLines < 1) return { lines: [], truncated: Boolean(value), altered: false }
  const lines: string[] = []
  let truncated = false
  let altered = false
  // Empty source rows are omitted to reserve the compact first view for its
  // controls. The full text keeps its original paragraphs in the scrollable panel.
  const sourceLines = value.replace(/\r\n?/g, '\n').split('\n')
  outer: for (const rawLine of sourceLines) {
    const sourceLine = rawLine.replace(/[^\S\n]+/g, ' ').trim()
    if (rawLine !== sourceLine || (!sourceLine && sourceLines.length > 1)) altered = true
    if (!sourceLine) continue
    let line = ''
    let used = 0
    for (const grapheme of graphemes(sourceLine)) {
      const width = cellWidth(grapheme)
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
      line += grapheme
      used += width
    }
    if (line) {
      lines.push(line)
      if (lines.length > maxLines) { truncated = true; break }
    }
  }
  if (lines.length > maxLines) {
    const visible = lines.slice(0, maxLines)
    visible[maxLines - 1] = ellipsizeLine(visible[maxLines - 1] ?? '', columns)
    return { lines: visible, truncated: true, altered }
  }
  return { lines, truncated, altered }
}

/** Each returned Text occupies one row; retain the existing array API. */
export function hardWrapPreview(value: string, columns: number, maxLines: number): string[] {
  return hardWrapPreviewWithStatus(value, columns, maxLines).lines
}

/** Preserve paragraphs and whitespace while counting the band's terminal rows. */
function bandLines(value: string, columns: number): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n').flatMap(source => {
    const lines: string[] = []
    let line = ''
    let cells = 0
    for (const grapheme of graphemes(source.replace(/\t/g, '    '))) {
      const width = cellWidth(grapheme)
      if (cells + width > columns) {
        if (line) lines.push(line)
        line = ''
        cells = 0
      }
      line += width > columns ? '…' : grapheme
      cells += Math.min(width, columns)
    }
    lines.push(line)
    return lines
  })
}

const OPTION_HOTKEYS = ['a', 'b', 'c', 'd'] as const
const optionKey = (index: number): string => `optimizer:option:${index}`
const replyOptions = (workflow: Workflow): string[] => workflow.question ? (workflow.options ?? []).slice(0, 4) : []

const errorSummary = (value: string): string => `오류: ${value.replace(/\s+/g, ' ').trim()}`

/** Both answer buttons and typed refinements continue on the fresh reply. */
async function refineAndFocus(
  controller: OptimizerController,
  ports: EnginePorts,
  instruction: string,
  maxRounds: number,
  invalidate: () => void,
  focus: (key: string) => Promise<unknown>,
): Promise<void> {
  await controller.refine(ports, instruction)
  const updated = controller.getState().workflow
  if (updated?.ui !== 'pane' || !canAct(updated)) return
  const key = updated.question && updated.rounds < maxRounds
    ? replyOptions(updated).length ? optionKey(0) : KEYS.instruction
    : updated.draft.trim() ? KEYS.accept : undefined
  if (!key) return
  invalidate()
  try {
    await focus(key)
  } catch {
    // Focus may be unavailable after the person moves to another site.
  }
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
  // line. Core owns the tail's dim styling and width clipping; desktop may
  // leave it undrawn. The line repaints only when the mode flips
  // (`register.ts` invalidates then).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = controller.getState()
    if (s.rawMode === null || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    return next({ ...e, props: { ...e.props, tail: RAW_MODE_BADGE_HINT } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const workflow = controller.getState().workflow
    observeWorkflow(workflow)
    // maxRows is read-only host space; viewport.rows is the whole surface.
    // Never read scroll.bodyRows: it depends on our previous rendered tree.
    const bandRows = Math.max(0, Math.min(e.props.maxRows,
      Math.floor((e.viewport?.rows ?? e.props.maxRows) / 2)))
    const eligible = workflow && !e.props.hasSurvey && !e.props.view.agentId
      && bandRows > 0
      && (e.surface === 'terminal' || e.surface === 'desktop')
      && !(workflow.ui === 'pane' && !paneClosed && isCompactViewport(e.viewport)
        && panePlacements.get(e.surface) !== 'dock')
    const key = workflow ? bandKey(workflow.id, e.surface) : undefined
    if (!eligible || !workflow || !key) {
      if (key && drawnBands.delete(key)) $.ui.invalidate('ui.render')
      return next(e)
    }

    const { Box, Text } = await $.ui.resolve(e)
    const columns = Math.max(1, e.props.bodyColumns - 2)
    const tokens = Object.values(workflow.usage).reduce((sum, count) => sum + count, 0)
    const composer = workflow.ui === 'composer' || paneClosed
    const options = replyOptions(workflow)
    // Give each section a visible row before expanding any body. Reserve the
    // overflow hint inside the same host/half-screen cap, independent of scroll.
    const sections: { lines: string[]; color: typeof UI_COLORS[keyof typeof UI_COLORS]; bold?: true; priority: number }[] = []
    const add = (value: string, color: typeof UI_COLORS[keyof typeof UI_COLORS], priority: number, bold?: true) => {
      if (value) sections.push({ lines: bandLines(value, columns), color, priority, bold })
    }
    add(latestOptimizerMessage(workflow), UI_COLORS.text, 4)
    add(workflow.question ? `질문: ${workflow.question}` : '', UI_COLORS.heading, 1, true)
    if (options.length) {
      if (composer) options.forEach((option, index) => add(`${index + 1}. ${option}`, UI_COLORS.heading, 2))
      else add(isBusy(workflow.phase) ? '선택지 답변을 처리 중입니다…' : '→ 패널에서 답을 고르세요', UI_COLORS.heading, 2)
    }
    add(workflow.lastError ? errorSummary(workflow.lastError) : '', UI_COLORS.error, 0)
    // Composer (or a surviving workflow after pane close) has no draft panel.
    if (composer) add(`개선안: ${workflow.draft || (isBusy(workflow.phase) ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}`, UI_COLORS.draft, 3)
    if (workflow.ui === 'composer') add(COMPOSER_GUIDE, UI_COLORS.section, 0)
    const total = sections.reduce((sum, section) => sum + section.lines.length, 1)
    const overflow = total > bandRows
    const available = Math.max(0, bandRows - 1 - (overflow && bandRows > 1 ? 1 : 0))
    const counts = sections.map(() => 0)
    let remaining = available
    const order = sections.map((_, index) => index).sort((a, b) => sections[a]!.priority - sections[b]!.priority)
    for (const index of order) {
      if (remaining > 0) { counts[index] = 1; remaining-- }
    }
    // Expand the draft in composer mode and the message in pane mode first.
    for (const index of [...order].sort((a, b) =>
      (sections[a]!.priority === (composer ? 3 : 4) ? -1 : sections[a]!.priority)
      - (sections[b]!.priority === (composer ? 3 : 4) ? -1 : sections[b]!.priority))) {
      const extra = Math.min(remaining, sections[index]!.lines.length - counts[index]!)
      counts[index]! += extra
      remaining -= extra
    }
    const omitted = total - 1 - counts.reduce((sum, count) => sum + count, 0)
    if (!drawnBands.has(key)) {
      drawnBands.add(key)
      $.ui.invalidate('ui.render')
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={UI_COLORS.heading} wrap="truncate-end">
          옵티마이저 <Text color={phaseColor(workflow.phase)}>{`[${phaseLabel(workflow.phase)}]`}</Text>
          <Text color={UI_COLORS.text}>{`  ${workflow.rounds}/${getMaxRounds()}회  ${tokens}토큰`}</Text>
        </Text>
        {sections.flatMap((section, index) => section.lines.slice(0, counts[index]).map((line, row) =>
          <Text key={`band:${index}:${row}`} color={section.color} bold={section.bold} wrap="truncate-end">
            {row === counts[index]! - 1 && counts[index]! < section.lines.length ? ellipsizeLine(line, columns) : line}
          </Text>))}
        {overflow && bandRows > 1 && <Text color={UI_COLORS.section} wrap="truncate-end">
          {`… ${omitted}줄 더 · ${composer ? '/optimize accept · retry <답변>' : '패널에서 확인'}`}
        </Text>}
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
    if (!workflow) return <Text color={UI_COLORS.unavailable}>진행 중인 개선 작업이 없습니다</Text>
    if (workflow.ui === 'composer') return <Text color={UI_COLORS.section}>개선 대화는 입력창에서 진행 중입니다. /optimize cancel로 취소할 수 있습니다.</Text>

    const maxRounds = getMaxRounds()
    const busy = isBusy(workflow.phase)
    const draftReady = Boolean(workflow.draft.trim()) && !busy
    const retryReady = !busy && workflow.rounds < maxRounds
    const options = replyOptions(workflow)
    const waiting = Boolean(workflow.question) && retryReady
    const message = latestOptimizerMessage(workflow)
    const bandDrawn = drawnBands.has(bandKey(workflow.id, e.surface))
    const draftText = workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')
    const draftColor = workflow.draft ? UI_COLORS.draft : busy ? UI_COLORS.progress : UI_COLORS.unavailable
    const originalToggleLabel = showOriginal ? '원문 접기' : '원문 전체 보기'
    const tokens = Object.values(workflow.usage).reduce((sum, count) => sum + count, 0)
    const header = <Text bold color={UI_COLORS.heading} wrap="truncate-end">
      프롬프트 옵티마이저 <Text color={phaseColor(workflow.phase)}>{`[${phaseLabel(workflow.phase)}]`}</Text>
      <Text color={UI_COLORS.text}>{`  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
    </Text>
    const messageSection = message && <Box flexDirection="column">
      <Text bold color={UI_COLORS.section}>옵티마이저 메시지</Text>
      <Text color={UI_COLORS.text} wrap="wrap">{message}</Text>
    </Box>
    const question = workflow.question && <Text bold color={UI_COLORS.heading} wrap="wrap">{`질문: ${workflow.question}`}</Text>
    const optionsText = options.map((option, index) => <Text key={`option-text:${index}`} color={UI_COLORS.heading} wrap="wrap">{`${index + 1}. ${option}`}</Text>)
    const draft = <Box flexDirection="column">
      <Text bold color={UI_COLORS.draft}>개선안</Text>
      <Text color={draftColor} wrap="wrap">{draftText}</Text>
    </Box>

    if (typeof Button !== 'function' && e.props.placement === 'inline' && isCompactViewport(e.viewport)) {
      const budget = estimatedCompactRows(e.viewport!)
      const columns = Math.max(1, e.props.bodyColumns - 2)
      const textRow = (value: string, color: typeof UI_COLORS[keyof typeof UI_COLORS], bold?: true) =>
        <Text color={color} bold={bold} wrap="truncate-end">{hardWrapPreview(value, columns, 1)[0]}</Text>
      const rows = [
        textRow(`개선안 · ${draftText}`, draftColor, true),
        ...(workflow.question ? [textRow(`질문: ${workflow.question}`, UI_COLORS.heading, true)] : []),
        ...(options.length ? [textRow(options.map((option, i) => `${i + 1}. ${option}`).join(' · '), UI_COLORS.heading)] : []),
        ...(message ? [textRow(message, UI_COLORS.text)] : []),
        ...(workflow.lastError ? [textRow(errorSummary(workflow.lastError), UI_COLORS.error)] : []),
        textRow('직접 입력: /optimize retry <답변 또는 보완>', UI_COLORS.section),
      ]
      return <Box flexDirection="column" paddingX={1}>
        {rows.slice(0, budget)}
        <Box flexDirection="column">
          {rows.slice(budget)}{header}{question}{optionsText}{draft}{messageSection}
          <Text color={UI_COLORS.section} wrap="wrap">직접 입력: /optimize retry &lt;선택지 답변 또는 보완 내용&gt;</Text>
          <Text color={UI_COLORS.section} wrap="wrap">{'명령: /optimize accept · send · raw · cancel · retry <보완>'}</Text>
          <Text bold color={UI_COLORS.original}>원문</Text>
          <Text color={UI_COLORS.original} wrap="wrap">{workflow.original}</Text>
          {workflow.lastError && <Text color={UI_COLORS.error} wrap="wrap">{`오류: ${workflow.lastError}`}</Text>}
        </Box>
      </Box>
    }

    if (typeof Button !== 'function') return <Box flexDirection="column" paddingX={1}>
      {header}{question}{optionsText}{draft}
      {messageSection}
      <Text bold color={UI_COLORS.original}>원문</Text>
      <Text color={UI_COLORS.original} wrap="wrap">{workflow.original}</Text>
      {workflow.lastError && <Text color={UI_COLORS.error} wrap="wrap">{`오류: ${workflow.lastError}`}</Text>}
      {busy && <Text color={UI_COLORS.progress}>{`${phaseLabel(workflow.phase)} · 잠시 기다려 주세요.`}</Text>}
      <Text color={UI_COLORS.section} wrap="wrap">직접 입력: /optimize retry &lt;선택지 답변 또는 보완 내용&gt;</Text>
      <Text color={UI_COLORS.section} wrap="wrap">{'명령: /optimize accept · send · raw · cancel · retry <보완>'}</Text>
    </Box>

    const optionButtons = (compact: boolean) => options.map((option, index) => {
      // Brackets/spaces and the visible a: prefix also consume cells. Compact
      // labels fit in one row; the numbered full answers remain below to scroll.
      const columns = Math.max(1, e.props.bodyColumns - 2)
      const labelColumns = Math.max(1, Math.floor(columns / options.length) - 7)
      const label = compact ? hardWrapPreview(option, labelColumns, 1)[0] ?? '…' : option
      return <Button key={optionKey(index)} hotkey={OPTION_HOTKEYS[index]} label={`${OPTION_HOTKEYS[index]}: ${label}`}
        variant={index === 0 ? 'primary' : undefined} autoFocus={waiting && index === 0 ? true : undefined} onPress={() => undefined} />
    })
    const instruction = (compact: boolean) => retryReady
      ? typeof Input === 'function'
        ? <Input key={KEYS.instruction} label={compact ? (workflow.question ? '직접 입력' : '보완') : (workflow.question ? '직접 입력' : '보완 내용')}
            placeholder={compact ? '보완 내용' : '선택지 답변 또는 수정할 내용을 입력하세요'}
            autoFocus={waiting && options.length === 0 ? true : undefined} onSubmit={() => undefined} />
        : <Text color={UI_COLORS.section} wrap="truncate-end">보완은 /optimize retry &lt;보완 내용&gt;</Text>
      : <Text color={UI_COLORS.unavailable} dimColor wrap="truncate-end">보완 (사용 불가)</Text>
    const acceptAction = (compact: boolean) => draftReady
      ? <Button key={KEYS.accept} hotkey="1" label={compact ? '1: 넣기' : '1: 입력창에 넣기 (수정 후 전송)'}
          variant={waiting ? 'secondary' : 'primary'} autoFocus={!waiting ? true : undefined} onPress={() => undefined} />
      : <Text color={UI_COLORS.unavailable} dimColor wrap="truncate-end">{compact ? '1: 넣기 ×' : '1: 입력창에 넣기 · 사용 불가'}</Text>
    const sendActions = (compact: boolean) => <Box flexDirection="row" gap={1}>
      {draftReady ? <Button key={KEYS.send} hotkey="2" label={compact ? '2: 전송' : '2: 개선안 바로 전송'} onPress={() => undefined} />
        : <Text color={UI_COLORS.unavailable} dimColor wrap="truncate-end">{compact ? '2: 전송 ×' : '2: 개선안 바로 전송 · 사용 불가'}</Text>}
      {!busy ? <Button key={KEYS.raw} hotkey="3" label={compact ? '3: 원문' : '3: 원문 그대로 전송'} onPress={() => undefined} />
        : <Text color={UI_COLORS.unavailable} dimColor wrap="truncate-end">{compact ? '3: 원문 ×' : '3: 원문 그대로 전송 · 사용 불가'}</Text>}
    </Box>
    const originalSection = <Box flexDirection="column">
      {busy ? <Text color={UI_COLORS.unavailable} dimColor wrap="truncate-end">{`0: ${originalToggleLabel} · 사용 불가`}</Text>
        : <Button key={KEYS.original} hotkey="0" label={`0: ${originalToggleLabel}`} onPress={() => undefined} />}
      {showOriginal && <Box flexDirection="column">
        <Text bold color={UI_COLORS.original}>원문</Text>
        <Text color={UI_COLORS.original} wrap="wrap">{workflow.original}</Text>
      </Box>}
    </Box>

    if (e.props.placement === 'inline' && isCompactViewport(e.viewport)) {
      const budget = estimatedCompactRows(e.viewport!)
      const columns = Math.max(1, e.props.bodyColumns - 2)
      const hasOptions = retryReady && options.length > 0
      const questionRows = workflow.question ? 1 : 0
      const optionRows = hasOptions ? 1 : 0
      const errorRows = workflow.lastError ? 1 : 0
      const messageRows = message ? 1 : 0
      // Essential context and input precede actions. If the host offers only
      // four rows, actions continue immediately in the scrollable portion.
      const essential = 1 + questionRows + optionRows + errorRows + messageRows + 1
      const actionsFit = essential + 1 <= budget
      const previewRows = Math.max(1, budget - questionRows - optionRows - errorRows - messageRows - 1 - (actionsFit ? 1 : 0))
      const preview = hardWrapPreviewWithStatus(`개선안 · ${draftText}`, columns, previewRows)
      const first = [
        ...preview.lines.map((line, index) => <Text key={`preview:${index}`} bold color={draftColor} wrap="truncate-end">{line}</Text>),
        ...(workflow.question ? [<Text bold color={UI_COLORS.heading} wrap="truncate-end">{hardWrapPreview(`질문: ${workflow.question}`, columns, 1)[0]}</Text>] : []),
        ...(hasOptions ? [<Box flexDirection="row">{optionButtons(true)}</Box>] : []),
        ...(workflow.lastError ? [<Text color={UI_COLORS.error} wrap="truncate-end">{errorSummary(workflow.lastError)}</Text>] : []),
        ...(messageRows ? [<Text color={UI_COLORS.text} wrap="truncate-end">{hardWrapPreview(message, columns, 1)[0]}</Text>] : []),
        instruction(true),
        ...(actionsFit ? [<Box flexDirection="row" gap={1}>{acceptAction(true)}{sendActions(true)}</Box>] : []),
      ]
      // Even a stale question plus error and message cannot overflow the first
      // view: remaining rows continue directly below, without losing controls.
      return <Box flexDirection="column" paddingX={1}>
        {first.slice(0, budget)}
        <Box flexDirection="column">
          {first.slice(budget)}
          {!actionsFit && <Box flexDirection="row" gap={1}>{acceptAction(true)}{sendActions(true)}</Box>}
          {header}
          <Text color={UI_COLORS.section} wrap="truncate-end">Tab 이동 · 아래로 스크롤하여 전문 확인 · Esc 닫기</Text>
          {question}{optionsText}
          <Text bold color={UI_COLORS.draft}>개선안 전문</Text>
          <Text color={draftColor} wrap="wrap">{draftText}</Text>
          {messageSection}{originalSection}
          {workflow.lastError && <Text color={UI_COLORS.error} wrap="wrap">{`오류: ${workflow.lastError}`}</Text>}
        </Box>
      </Box>
    }

    const keyHintText = workflow.phase === 'transferring' || workflow.phase === 'sending' ? '전송 중입니다'
      : busy ? '생성 중에는 Esc로 취소할 수 있습니다'
      : waiting ? `${e.props.isFocused ? '' : 'ctrl+x tab 포커스 · '}${options.length ? `${OPTION_HOTKEYS.slice(0, options.length).join('/')} 답변 선택 · ` : '직접 입력 후 Enter · '}Tab 이동 · Esc 닫기`
      : e.props.isFocused ? [ ...(draftReady ? ['Enter 입력창'] : []), 'Tab 이동', ...(draftReady ? ['2 바로 전송'] : []), '3 원문 전송', 'Esc 닫기' ].join(' · ')
      : `ctrl+x tab 포커스 · Tab 이동 · ${draftReady ? '1/2/3' : '3'} 선택 · Esc 닫기`
    return <Box flexDirection="column" paddingX={1}>
      {header}
      <Text color={busy ? UI_COLORS.progress : UI_COLORS.section} wrap="wrap">{keyHintText}</Text>
      {question}
      {retryReady && options.length > 0 && <Box flexDirection="column">{optionButtons(false)}</Box>}
      {draft}
      {instruction(false)}{acceptAction(false)}{sendActions(false)}
      {!bandDrawn && messageSection}
      {originalSection}
      {workflow.lastError && <Text color={UI_COLORS.error} wrap="wrap">{`오류: ${workflow.lastError}`}</Text>}
      {busy && <Text color={UI_COLORS.progress}>{`${phaseLabel(workflow.phase)} · 잠시 기다려 주세요.`}</Text>}
    </Box>
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

    if (e.element.startsWith('optimizer:option:')) {
      const value = e.element.slice('optimizer:option:'.length)
      const index = /^[0-3]$/.test(value) ? Number(value) : -1
      const option = replyOptions(workflow)[index]
      if (option && workflow.rounds < getMaxRounds()) await refineAndFocus(controller, portsOf($), option, getMaxRounds(),
        () => $.ui.invalidate('ui.render'), key => $.ui.focus({ requestId: PANE_ID, key }))
      return { element: e.element }
    }

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
      await refineAndFocus(controller, portsOf($), instruction, getMaxRounds(),
        () => $.ui.invalidate('ui.render'), key => $.ui.focus({ requestId: PANE_ID, key }))
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
