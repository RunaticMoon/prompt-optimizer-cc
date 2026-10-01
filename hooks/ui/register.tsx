/* @jsxRuntime classic */
/* @jsx h */
import type { EngineInterface, On } from 'claude-code'

import type { OptimizerController } from '../controller'
import { PANE_ID } from '../controller'
import { DEFAULT_CONFIG, type EnginePorts, type Workflow } from '../contracts'
import { COMPOSER_GUIDE, phaseLabel } from './present'
import { PANE_ROWS } from './ui-ports'

const BUSY_PHASES: readonly Workflow['phase'][] = ['idle', 'collecting', 'generating', 'transferring', 'sending']
const isBusy = (phase: Workflow['phase']): boolean => BUSY_PHASES.includes(phase)

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

/** Bound compact copy by terminal cells; the complete draft remains available through action 1. */
function previewText(value: string, maxCells: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized)
  const cellWidth = (char: string) => char.codePointAt(0)! > 0x7f ? 2 : 1
  const total = chars.reduce((sum, char) => sum + cellWidth(char), 0)
  if (total <= maxCells) return normalized
  const limit = Math.max(0, maxCells - 1)
  let used = 0
  let end = 0
  while (end < chars.length && used + cellWidth(chars[end]!) <= limit) {
    used += cellWidth(chars[end]!)
    end++
  }
  return maxCells > 0 ? `${chars.slice(0, end).join('')}…` : ''
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
  const drawnBands = new Set<string>()
  const bandKey = (id: string, surface: string) => `${id}:${surface}`
  const observeWorkflow = (workflow: Workflow | null): void => {
    if (renderedWorkflowId === workflow?.id) return
    renderedWorkflowId = workflow?.id
    showOriginal = false
    drawnBands.clear()
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const workflow = controller.getState().workflow
    observeWorkflow(workflow)
    const eligible = workflow && !e.props.hasSurvey && !e.props.view.agentId
      && (e.surface === 'terminal' || e.surface === 'desktop')
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
    // The engine has no acceptance signal for the band tree. Compact inline
    // panes therefore keep a draft preview even when this key is recorded.
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

    if (e.props.placement === 'inline' && e.props.scroll.bodyRows < PANE_ROWS) {
      // Input is a one-line field; its default submit label sits beside it on
      // focus. Keep compact copy short so it does not request another row.
      const inputRows = 1
      const previewRows = Math.max(0, e.props.scroll.bodyRows - inputRows - 1)
      const previewColumns = Math.max(1, e.props.bodyColumns - 2)
      const preview = workflow.draft.trim() || (busy ? '개선안을 준비하고 있습니다…' : message || '아직 개선안이 없습니다.')
      const compactInstruction = retryReady
        ? typeof Input === 'function'
          ? <Input key={KEYS.instruction} label="보완 요청" placeholder="보완 내용을 입력하세요" onSubmit={() => undefined} />
          : <Text wrap="truncate-end">보완: /optimize retry &lt;내용&gt;</Text>
        : <Text dimColor wrap="truncate-end">보완 요청 불가</Text>
      return (
        <Box flexDirection="column" paddingX={1}>
          {previewRows > 0 && <Text wrap="wrap">{previewText(preview, previewRows * previewColumns)}</Text>}
          {compactInstruction}
          <Box flexDirection="row">
            {draftReady
              ? <Button key={KEYS.accept} hotkey="1" label="1 넣기" plain autoFocus onPress={() => undefined} />
              : <Text dimColor>1 넣기</Text>}
            <Text> · </Text>
            {draftReady
              ? <Button key={KEYS.send} hotkey="2" label="2 전송" plain onPress={() => undefined} />
              : <Text dimColor>2 전송</Text>}
            <Text> · </Text>
            {!busy
              ? <Button key={KEYS.raw} hotkey="3" label="3 원문" plain onPress={() => undefined} />
              : <Text dimColor>3 원문</Text>}
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
    return next(e)
  })
}
