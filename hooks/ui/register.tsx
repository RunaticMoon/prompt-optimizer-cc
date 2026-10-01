/* @jsxRuntime classic */
/* @jsx h */
import type { EngineInterface, On } from 'claude-code'

import type { OptimizerController } from '../controller'
import { PANE_ID } from '../controller'
import { DEFAULT_CONFIG, type EnginePorts, type Workflow } from '../contracts'
import { phaseLabel } from './present'

const KEYS = {
  original: 'optimizer:original',
  instruction: 'optimizer:instruction',
  accept: 'optimizer:accept',
  send: 'optimizer:send',
  raw: 'optimizer:raw',
  retry: 'optimizer:retry',
  cancel: 'optimizer:cancel',
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
  return Boolean(workflow && !['idle', 'collecting', 'generating', 'transferring', 'sending'].includes(workflow.phase))
}

function latestOptimizerMessage(workflow: Workflow): string {
  return [...workflow.dialogue].reverse().find((entry) => entry.role === 'optimizer')?.text ?? ''
}

/** Bound a narrow preview by terminal cells; the complete draft stays available through accept. */
function previewText(value: string, maxCells: number, suffix: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized)
  const width = (text: string) => Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! > 0x7f ? 2 : 1), 0)
  if (width(normalized) <= maxCells) return normalized
  const limit = maxCells - width(suffix)
  let used = 0
  let end = 0
  while (end < chars.length && used + width(chars[end]!) <= limit) {
    used += width(chars[end]!)
    end++
  }
  return `${chars.slice(0, end).join('')}${suffix}`
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

/** The UI owns exactly these four events; all foreign instances pass through. */
export function registerUi(
  on: On,
  controller: OptimizerController,
  getMaxRounds: () => number = () => DEFAULT_CONFIG.maxRounds,
  pluginName = 'prompt-optimizer',
): void {
  let showOriginal = false
  let renderedWorkflowId: string | undefined

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)

    const elements = await $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const workflow = controller.getState().workflow
    if (!workflow) return <Text>진행 중인 개선 작업이 없습니다</Text>
    if (workflow.ui === 'composer') return <Text>개선 대화는 입력창에서 진행 중입니다. /optimize cancel로 취소할 수 있습니다.</Text>

    if (renderedWorkflowId !== workflow.id) {
      renderedWorkflowId = workflow.id
      showOriginal = false
    }

    const maxRounds = getMaxRounds()
    const busy = ['idle', 'collecting', 'generating', 'transferring', 'sending'].includes(workflow.phase)
    const cancelReady = !['transferring', 'sending'].includes(workflow.phase)
    const draftReady = Boolean(workflow.draft.trim()) && !busy
    const retryReady = !busy && workflow.rounds < maxRounds
    const tokens = Object.values(workflow.usage).reduce((sum, count) => sum + count, 0)
    const originalChars = Array.from(workflow.original)
    const originalSummary = originalChars.length > 180
      ? `${originalChars.slice(0, 180).join('')}…`
      : workflow.original
    const originalToggleLabel = showOriginal ? '원문 접기' : '원문 전체 보기'
    const message = latestOptimizerMessage(workflow)

    // A surface without Button needs command text; mobile can still use its Button table.
    if (typeof Button !== 'function') {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
          <Text bold>원문</Text>
          <Text wrap="wrap">{workflow.original}</Text>
          <Text bold>현재 개선안</Text>
          <Text wrap="wrap">{workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}</Text>
          {message && <Text wrap="wrap">{`옵티마이저: ${message}`}</Text>}
          {workflow.lastError && <Text wrap="wrap">{`오류: ${workflow.lastError}`}</Text>}
          {busy && <Text>{`${phaseLabel(workflow.phase)} · 잠시 기다려 주세요.`}</Text>}
          <Text wrap="wrap">{'명령: /optimize accept · send · raw · cancel · retry <보완>'}</Text>
        </Box>
      )
    }

    const actions = (
      <Box marginTop={1} flexDirection="row" flexWrap="wrap" gap={1}>
        {draftReady
          ? <Button key={KEYS.accept} hotkey="1" label="1: 입력창으로 가져오기" variant="primary" autoFocus onPress={() => undefined} />
          : <Text dimColor>[1: 입력창으로 가져오기 · 사용 불가]</Text>}
        {draftReady
          ? <Button key={KEYS.send} hotkey="2" label="2: 바로 보내기" onPress={() => undefined} />
          : <Text dimColor>[2: 바로 보내기 · 사용 불가]</Text>}
        {!busy
          ? <Button key={KEYS.raw} hotkey="3" label="3: 원문 보내기" onPress={() => undefined} />
          : <Text dimColor>[3: 원문 보내기 · 사용 불가]</Text>}
        {retryReady
          ? <Button key={KEYS.retry} hotkey="4" label="4: 다시 다듬기" onPress={() => undefined} />
          : <Text dimColor>[4: 다시 다듬기 · 사용 불가]</Text>}
        {cancelReady
          ? <Button key={KEYS.cancel} hotkey="5" label="5: 취소" role="dismiss" onPress={() => undefined} />
          : <Text dimColor>[5: 취소 · 사용 불가]</Text>}
      </Box>
    )
    const keyHint = (
      <Text dimColor wrap="wrap">{e.props.isFocused
        ? '숫자키 실행 · Tab 이동 · Enter 선택 · Esc 닫기'
        : 'ctrl+x tab으로 포커스 · 숫자키 실행 · Tab 이동 · Enter 선택 · Esc 닫기'}</Text>
    )
    const instruction = retryReady
      ? typeof Input === 'function'
        ? <Input key={KEYS.instruction} label="보완 내용" placeholder="수정하거나 확인할 내용을 입력하세요" submitLabel="다듬기" onSubmit={() => undefined} />
        : <Text wrap="wrap">보완은 /optimize retry &lt;보완 내용&gt;</Text>
      : <Text dimColor>지금은 보완 요청을 입력할 수 없습니다.</Text>

    if ((e.viewport?.columns ?? e.props.bodyColumns) <= 90) {
      const bodyColumns = e.props.bodyColumns || (e.viewport?.columns ?? 80) - 4
      const draft = workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
          {actions}
          {keyHint}
          <Box marginTop={1} flexDirection="column">
            <Text bold>보완 요청</Text>
            {instruction}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>현재 개선안</Text>
            <Text wrap="wrap">{previewText(draft, Math.max(32, bodyColumns - 4) * 2, '… (전체는 가져오기로 확인)')}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>원문</Text>
            <Text wrap="wrap">{showOriginal ? workflow.original : previewText(workflow.original, Math.max(24, bodyColumns - 4), '…')}</Text>
            {originalChars.length > 24 && (busy
              ? <Text dimColor>{`[0: ${originalToggleLabel} · 사용 불가]`}</Text>
              : <Button key={KEYS.original} hotkey="0" label={originalToggleLabel} plain onPress={() => undefined} />)}
          </Box>
          {message && <Text wrap="wrap">{`옵티마이저: ${previewText(message, Math.max(32, bodyColumns - 4) * 2, '…')}`}</Text>}
          {workflow.lastError && <Text wrap="wrap" color="error">{`오류: ${workflow.lastError}`}</Text>}
          {busy && <Text dimColor>{phaseLabel(workflow.phase)} · 잠시 기다려 주세요.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>원문</Text>
          <Text wrap="wrap">{showOriginal ? workflow.original : originalSummary}</Text>
          {originalChars.length > 180 && (
            busy
              ? <Text dimColor>{`[0: ${originalToggleLabel} · 사용 불가]`}</Text>
              : <Button key={KEYS.original} hotkey="0" label={originalToggleLabel} plain onPress={() => undefined} />
          )}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>현재 개선안</Text>
          <Text wrap="wrap">{workflow.draft || (busy ? '개선안을 준비하고 있습니다…' : '아직 개선안이 없습니다.')}</Text>
        </Box>
        {message && (
          <Box marginTop={1} flexDirection="column">
            <Text bold>옵티마이저 메시지 / 질문</Text>
            <Text wrap="wrap">{message}</Text>
          </Box>
        )}
        {workflow.lastError && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="error">오류</Text>
            <Text wrap="wrap">{workflow.lastError}</Text>
          </Box>
        )}
        {busy && <Text dimColor>{phaseLabel(workflow.phase)} · 잠시 기다려 주세요.</Text>}
        <Box marginTop={1} flexDirection="column">
          <Text bold>보완 요청</Text>
          {instruction}
        </Box>
        {actions}
        {keyHint}
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

    if (e.element === KEYS.cancel) {
      if (!['transferring', 'sending'].includes(workflow.phase)) await controller.cancel(portsOf($))
      return { element: e.element }
    }
    if (!canAct(workflow)) return { element: e.element }

    const ports = portsOf($)
    if (e.element === KEYS.accept && workflow.draft.trim()) await controller.accept(ports)
    else if (e.element === KEYS.send && workflow.draft.trim()) await controller.sendDraft(ports)
    else if (e.element === KEYS.raw) await controller.sendOriginal(ports)
    else if (e.element === KEYS.retry && workflow.rounds < getMaxRounds()) await controller.retry(ports)
    else return next(e)
    return { element: e.element }
  })

  on('ui.input', { plugin: pluginName, element: KEYS.instruction }, async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE_ID || e.kind !== 'submit') return next(e)
    const workflow = controller.getState().workflow
    const instruction = e.value.trim()
    if (canAct(workflow) && workflow.ui === 'pane' && workflow.rounds < getMaxRounds() && instruction) {
      await controller.refine(portsOf($), instruction)
    }
    return { element: e.element, value: e.value }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    await handlePaneClose(controller, portsOf($), e.origin.kind)
    return next(e)
  })
}
