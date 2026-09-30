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
    },
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
    if (e.requestId !== PANE_ID || e.surface !== 'terminal') return next(e)

    const { Box, Text, Button, Input } = await $.ui.resolve(e)
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
    const message = latestOptimizerMessage(workflow)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold wrap="wrap">{`프롬프트 옵티마이저  [${phaseLabel(workflow.phase)}]  ${workflow.rounds}/${maxRounds}회  ${tokens}토큰`}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>원문</Text>
          <Text wrap="wrap">{showOriginal ? workflow.original : originalSummary}</Text>
          {originalChars.length > 180 && (
            busy
              ? <Text dimColor>[원문 전체 보기 · 사용 불가]</Text>
              : <Button key={KEYS.original} label={showOriginal ? '원문 접기' : '원문 전체 보기'} plain onPress={() => undefined} />
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
          {retryReady
            ? <Input key={KEYS.instruction} label="보완 내용" placeholder="수정하거나 확인할 내용을 입력하세요" submitLabel="다듬기" onSubmit={() => undefined} />
            : <Text dimColor>지금은 보완 요청을 입력할 수 없습니다.</Text>}
        </Box>
        <Box marginTop={1} flexDirection="row" flexWrap="wrap" gap={1}>
          {draftReady
            ? <Button key={KEYS.accept} label="입력창으로 가져오기" variant="primary" autoFocus onPress={() => undefined} />
            : <Text dimColor>[입력창으로 가져오기 · 사용 불가]</Text>}
          {draftReady
            ? <Button key={KEYS.send} label="바로 보내기" onPress={() => undefined} />
            : <Text dimColor>[바로 보내기 · 사용 불가]</Text>}
          {!busy
            ? <Button key={KEYS.raw} label="원문 보내기" onPress={() => undefined} />
            : <Text dimColor>[원문 보내기 · 사용 불가]</Text>}
          {retryReady
            ? <Button key={KEYS.retry} label="다시 다듬기" onPress={() => undefined} />
            : <Text dimColor>[다시 다듬기 · 사용 불가]</Text>}
          {cancelReady
            ? <Button key={KEYS.cancel} label="취소" role="dismiss" onPress={() => undefined} />
            : <Text dimColor>[취소 · 사용 불가]</Text>}
        </Box>
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
