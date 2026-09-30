/**
 * Task I — the improvement-dialogue controller.
 *
 * One controller owns one session's single workflow. It is the only module that
 * sequences C–H: `classifySubmission` (C) decides what a submission means,
 * `collectContext` (D) reads the snapshot once per run, `composeSystemPrompt`
 * and `buildModelRequest`/`completeRewrite` (F) drive one completion at a time,
 * `reduce`/`canStartRound`/`isStale` (G) hold the race-free state, and
 * `transferDraft`/`sendApproved` (H) deliver an approved text. Nothing here
 * draws UI, parses commands or registers engine events: K, J and L do that.
 *
 * The engine's `$` never enters this module. Every engine call goes through the
 * {@link EnginePorts} the caller passes per call; the mod loader refuses a `$`
 * handed across an import, so `register.ts` (L) builds those ports from
 * `$.noun.method(...)` closures and calls this controller with them.
 *
 * A submit hook stays fast: it only classifies, stores state and schedules the
 * first round, then returns (`docs/DESIGN.md`, ③ 제출·대기 방식). All model
 * waiting happens on the scheduled call, whose promise the host ignores — the
 * tests, using a manual queue, await it directly to stay deterministic.
 */

import type { PromptSubmitInput } from 'claude-code'

import { loadSystemPromptExtra } from './config'
import { collectContext } from './context'
import { sendApproved, transferDraft } from './delivery'
import { classifySubmission } from './eligibility'
import { buildModelRequest, completeRewrite } from './model'
import { canStartRound, initialState, isStale, reduce } from './state'
import { composeSystemPrompt } from './system-prompt'
import type {
  ContextSnapshot,
  EnginePorts,
  ModelUsage,
  OptimizerConfig,
  OptimizerEvent,
  RewriteResult,
  RuntimeState,
  SubmissionDecision,
  TransferRefusal,
  Workflow,
} from './contracts'

/** Pane id the UI opens the dialogue under (task K); a restore closes it. */
export const PANE_ID = 'prompt-optimizer'

/** The one-line Korean notices the person sees, per the design. */
const BUSY_NOTICE = '프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.'
const REPLY_NOTICE = '보완 요청을 옵티마이저에 전달했습니다.'
const OPTIMIZE_NOTICE = '프롬프트를 다듬는 중입니다.'
const LIMIT_NOTICE = '개선 횟수 한도에 도달했습니다'
const ACCEPT_NOTICE = '개선안을 입력창에 넣었습니다. Enter 로 전송하세요.'

/** A token count with every field at zero, for arms that spent nothing. */
const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/** The runtime map entry for one in-flight completion. */
interface Round {
  /** Aborts the completion on cancel, a new session, or an unexpected error. */
  controller: AbortController
}

/**
 * What the controller needs from its host. `register.ts` (L) supplies engine,
 * clock and UI bindings; a test supplies a manual queue and fakes.
 */
export interface ControllerDeps {
  /** Epoch milliseconds, for bypass expiry and usage stamps. */
  now(): number
  /** A fresh unique workflow id. */
  newId(): string
  /**
   * Queues work to run after a submit hook returns `drop`. L implements this
   * as `(fn) => $.clock.after(1, fn)`; the tests use a manual queue.
   */
  schedule(fn: () => void): void
  /** The current settings, re-read on every action so edits take effect. */
  getConfig(): OptimizerConfig
  /** A state change or notification; the UI (K) subscribes. */
  onChange(state: Readonly<RuntimeState>, notice?: string): void
}

/** What a submit hook should do with one submission. */
export type SubmitOutcome =
  | { action: 'next'; text: string }
  | { action: 'drop'; reason: string }

/** The controller's public surface, as commands (J) and the UI (K) call it. */
export interface OptimizerController {
  getState(): Readonly<RuntimeState>
  onSubmit(ports: EnginePorts, e: PromptSubmitInput, ui: 'pane' | 'composer'): Promise<SubmitOutcome>
  startExplicit(ports: EnginePorts, text: string | undefined, ui: 'pane' | 'composer'): Promise<void>
  refine(ports: EnginePorts, instruction: string): Promise<void>
  retry(ports: EnginePorts, instruction?: string): Promise<void>
  accept(ports: EnginePorts): Promise<void>
  sendDraft(ports: EnginePorts): Promise<void>
  sendOriginal(ports: EnginePorts): Promise<void>
  cancel(ports: EnginePorts): Promise<void>
  onPromptEdit(text: string): void
  onSessionStart(sessionId: string): void
  onSessionEnd(): void
}

/** A readable message from a thrown value. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The Korean notice for one restore refusal. */
function refusalNotice(reason: TransferRefusal): string {
  switch (reason) {
    case 'draft-conflict':
      return '입력창에 새로 작성한 내용이 있어 덮어쓰지 않았습니다'
    case 'no_composer':
      return '입력창을 사용할 수 없어 개선안을 넣지 못했습니다'
    case 'dialog':
      return '다른 대화 상자가 열려 있어 개선안을 넣지 못했습니다'
    case 'hook-refused':
      return '입력창이 개선안을 거부했습니다'
    default:
      return '입력창에 개선안을 넣지 못했습니다'
  }
}

/**
 * Builds a controller bound to one session's runtime.
 *
 * The returned object owns the serializable {@link RuntimeState}, an
 * `AbortController` per in-flight workflow (keyed by workflow id) and the
 * cached system prompt for the current run. None of it is shared between
 * sessions; `onSessionStart`/`onSessionEnd` tear it all down.
 */
export function createController(deps: ControllerDeps): OptimizerController {
  let state: RuntimeState = initialState('')
  const rounds = new Map<string, Round>()
  let system: string | null = null

  /** Folds one event in and repaints when the state actually moved. */
  function apply(event: OptimizerEvent): void {
    const next = reduce(state, event, deps.now())
    if (next === state) return
    state = next
    deps.onChange(state)
  }

  /** Emits a user-facing notice over the current state. */
  function notify(notice: string): void {
    deps.onChange(state, notice)
  }

  /** Aborts every in-flight completion; used on cancel and session changes. */
  function abortAll(): void {
    for (const round of rounds.values()) round.controller.abort()
    rounds.clear()
  }

  /** Locks in the run's captured settings before the first completion. */
  function resetSystemPrompt(): void {
    system = null
  }

  function makeWorkflow(
    original: string,
    context: readonly string[],
    ui: 'pane' | 'composer',
  ): Workflow {
    return {
      id: deps.newId(),
      sessionId: state.sessionId,
      generation: 0,
      phase: 'idle',
      original,
      originalContext: context,
      draft: '',
      context: null,
      dialogue: [],
      rounds: 0,
      ui,
      usage: { ...ZERO_USAGE },
    }
  }

  /** Closes the run's pane (when any) then fills the given text back in. */
  async function restore(
    ports: EnginePorts,
    workflow: Workflow,
    text: string,
  ): Promise<Awaited<ReturnType<typeof transferDraft>>> {
    return transferDraft(
      ports,
      {
        sessionId: workflow.sessionId,
        workflowId: workflow.id,
        text,
        mode: 'replace',
      },
      { now: deps.now(), paneId: workflow.ui === 'pane' ? PANE_ID : undefined },
    )
  }

  /**
   * Restores the original prompt and, on a landed fill, permits one bypass and
   * dismisses the run. A refusal leaves the run as the caller left it.
   */
  async function restoreOriginal(ports: EnginePorts, workflow: Workflow, notice: string): Promise<void> {
    let result: Awaited<ReturnType<typeof transferDraft>>
    try {
      result = await restore(ports, workflow, workflow.original)
    } catch (cause) {
      notify(`원문을 입력창에 복원하지 못했습니다: ${describeError(cause)}`)
      return
    }
    if (result.kind === 'filled') {
      apply({ type: 'bypass-issued', ticket: result.ticket })
      apply({ type: 'dismiss', workflowId: workflow.id })
      notify(notice)
      return
    }
    notify(`원문을 입력창에 복원하지 못했습니다: ${refusalNotice(result.reason)}`)
  }

  /** The inner round: collect once, then make exactly one completion. */
  async function round(ports: EnginePorts, instruction?: string): Promise<void> {
    const config = deps.getConfig()
    if (!canStartRound(state, config.maxRounds)) {
      notify(LIMIT_NOTICE)
      return
    }

    const workflow = state.workflow
    if (workflow === null) return
    const { id: workflowId, generation } = workflow

    // The snapshot is read once, on the first round.
    if (workflow.phase === 'idle') {
      apply({ type: 'phase', workflowId, generation, phase: 'collecting' })
      let context: ContextSnapshot | null = null
      try {
        context = await collectContext(ports, config)
      } catch {
        // A snapshot failure is not a round failure: continue without it.
        context = null
      }
      if (context !== null) apply({ type: 'context', workflowId, generation, context })
    }

    // A cancel during collection has already stranded this run.
    if (isStale(state, workflowId, generation)) return

    apply({ type: 'phase', workflowId, generation, phase: 'generating' })

    const controller = new AbortController()
    rounds.set(workflowId, { controller })

    if (system === null) {
      let extra = ''
      try {
        extra = (await loadSystemPromptExtra(ports, config)).text
      } catch {
        // A missing extra file falls back to the built-in prompt, already the
        // empty `extra`; `loadSystemPromptExtra` also reports its own warning.
        extra = ''
      }
      system = composeSystemPrompt(extra)
    }

    const current = state.workflow
    if (current === null || current.id !== workflowId) {
      rounds.delete(workflowId)
      return
    }

    const request = buildModelRequest(current, config, system, instruction)

    let result: RewriteResult
    try {
      result = await completeRewrite(ports, request, controller.signal)
    } catch (cause) {
      result = { kind: 'failed', reason: 'rejected', message: describeError(cause), usage: ZERO_USAGE }
    }
    // Only drop the entry this round put there (a cancel already removed it).
    if (rounds.get(workflowId)?.controller === controller) rounds.delete(workflowId)

    // The reducer folds a stale result's usage without touching the run; the
    // UI must not react either. `reply`/`failed` carry the usage, so no second
    // `usage` event is emitted (`DESIGN.md`, 3. 상태 규칙).
    const stale = isStale(state, workflowId, generation)

    if (result.kind === 'ok') {
      apply({ type: 'reply', workflowId, generation, reply: result.reply, usage: result.usage })
      if (stale) return
      const question = result.reply.question
      const notice = question !== null && question !== '' ? `질문: ${question}` : result.reply.message
      if (notice !== '') notify(notice)
      return
    }

    apply({ type: 'failed', workflowId, generation, error: result.message, usage: result.usage })
    if (stale) return

    const failed = state.workflow
    if (failed === null) return

    // A first round that produced nothing falls back to the original prompt; a
    // later failure keeps the last good draft for the person to act on.
    if (failed.draft === '') {
      await restoreOriginal(
        ports,
        failed,
        `개선에 실패해 원문을 입력창에 복원했습니다: ${result.message}`,
      )
    } else {
      notify(`개선에 실패했습니다: ${result.message}`)
    }
  }

  /**
   * Runs one round, never letting a scheduled (unawaited) round reject. An
   * unexpected fault releases the run so later submissions are not trapped.
   */
  async function runRound(ports: EnginePorts, instruction?: string): Promise<void> {
    try {
      await round(ports, instruction)
    } catch (cause) {
      const workflow = state.workflow
      if (workflow !== null && workflow.phase !== 'reviewing' && workflow.phase !== 'failed') {
        const entry = rounds.get(workflow.id)
        if (entry !== undefined) {
          entry.controller.abort()
          rounds.delete(workflow.id)
        }
        apply({ type: 'cancel', workflowId: workflow.id })
      }
      notify(`개선 중 예기치 않은 오류가 발생했습니다: ${describeError(cause)}`)
    }
  }

  async function onSubmit(
    ports: EnginePorts,
    e: PromptSubmitInput,
    ui: 'pane' | 'composer',
  ): Promise<SubmitOutcome> {
    let decision: SubmissionDecision
    try {
      decision = classifySubmission(e, deps.getConfig(), state, deps.now())
    } catch {
      // Classification itself failing must not trap the person: pass through.
      return { action: 'next', text: e.text }
    }

    switch (decision.kind) {
      case 'pass':
        return { action: 'next', text: e.text }

      case 'raw':
        return { action: 'next', text: decision.text }

      case 'bypass':
        apply({
          type: 'bypass-consumed',
          sessionId: state.sessionId,
          workflowId: decision.ticket.workflowId,
        })
        return { action: 'next', text: e.text }

      case 'busy':
        return { action: 'drop', reason: BUSY_NOTICE }

      case 'reply':
        try {
          deps.schedule(() => refine(ports, decision.text))
        } catch (cause) {
          notify(`보완 요청을 예약하지 못했습니다: ${describeError(cause)}`)
        }
        return { action: 'drop', reason: REPLY_NOTICE }

      case 'optimize': {
        let workflow: Workflow | null = null
        try {
          resetSystemPrompt()
          workflow = makeWorkflow(decision.text, e.context ?? [], ui)
          apply({ type: 'start', workflow })
          deps.schedule(() => runRound(ports))
        } catch (cause) {
          // Undo a half-started run and let the original through, so the person
          // is not stuck behind a workflow that never had a clock to run on.
          if (workflow !== null) apply({ type: 'cancel', workflowId: workflow.id })
          notify(`개선을 시작하지 못했습니다: ${describeError(cause)}`)
          return { action: 'next', text: e.text }
        }
        return { action: 'drop', reason: OPTIMIZE_NOTICE }
      }
    }
  }

  async function startExplicit(
    ports: EnginePorts,
    text: string | undefined,
    ui: 'pane' | 'composer',
  ): Promise<void> {
    if (state.workflow !== null) {
      notify('이미 개선 작업이 진행 중입니다.')
      return
    }

    let source = text
    if (source === undefined) {
      try {
        source = (await ports.prompt.read()).text
      } catch (cause) {
        notify(`입력창을 읽지 못했습니다: ${describeError(cause)}`)
        return
      }
    }
    if (source === undefined || source.trim() === '') {
      notify('개선할 텍스트가 없습니다.')
      return
    }

    try {
      resetSystemPrompt()
      const workflow = makeWorkflow(source, [], ui)
      apply({ type: 'start', workflow })
      deps.schedule(() => runRound(ports))
    } catch (cause) {
      notify(`개선을 시작하지 못했습니다: ${describeError(cause)}`)
    }
  }

  async function refine(ports: EnginePorts, instruction: string): Promise<void> {
    const workflow = state.workflow
    if (workflow === null || (workflow.phase !== 'reviewing' && workflow.phase !== 'failed')) {
      notify('보완할 개선안이 없습니다.')
      return
    }
    apply({ type: 'instruct', workflowId: workflow.id, text: instruction })
    await runRound(ports, instruction)
  }

  async function retry(ports: EnginePorts, instruction?: string): Promise<void> {
    const workflow = state.workflow
    if (workflow === null || (workflow.phase !== 'reviewing' && workflow.phase !== 'failed')) {
      notify('다시 생성할 작업이 없습니다.')
      return
    }
    if (instruction !== undefined && instruction !== '') {
      apply({ type: 'instruct', workflowId: workflow.id, text: instruction })
    }
    await runRound(ports, instruction)
  }

  async function accept(ports: EnginePorts): Promise<void> {
    const workflow = state.workflow
    if (workflow === null) {
      notify('복원할 개선안이 없습니다.')
      return
    }
    // `transferring`/`sending` mean a button is already being handled: ignore
    // the double press rather than fill or submit twice.
    if (workflow.phase !== 'reviewing' && workflow.phase !== 'failed') return
    if (workflow.draft === '') {
      notify('복원할 개선안이 없습니다.')
      return
    }

    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'transferring' })

    let result: Awaited<ReturnType<typeof transferDraft>>
    try {
      result = await restore(ports, workflow, workflow.draft)
    } catch (cause) {
      apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
      notify(`개선안을 입력창에 넣지 못했습니다: ${describeError(cause)}`)
      return
    }

    if (result.kind === 'filled') {
      apply({ type: 'bypass-issued', ticket: result.ticket })
      apply({ type: 'dismiss', workflowId: workflow.id })
      notify(ACCEPT_NOTICE)
      return
    }
    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
    notify(refusalNotice(result.reason))
  }

  async function send(ports: EnginePorts, source: 'draft' | 'original'): Promise<void> {
    const workflow = state.workflow
    if (workflow === null) {
      notify('전송할 개선 작업이 없습니다.')
      return
    }
    if (workflow.phase !== 'reviewing' && workflow.phase !== 'failed') return

    const text = source === 'draft' ? workflow.draft : workflow.original
    if (text === '') {
      notify(source === 'draft' ? '전송할 개선안이 없습니다.' : '전송할 원문이 없습니다.')
      return
    }

    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'sending' })

    let result: Awaited<ReturnType<typeof sendApproved>>
    try {
      result = await sendApproved(ports, {
        sessionId: workflow.sessionId,
        workflowId: workflow.id,
        text,
        context: workflow.originalContext,
        source,
      })
    } catch (cause) {
      apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
      notify(`전송에 실패했습니다: ${describeError(cause)}`)
      return
    }

    if (result.kind === 'sent') {
      apply({ type: 'dismiss', workflowId: workflow.id })
      notify('전송했습니다.')
      return
    }
    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
    notify(
      result.kind === 'dropped'
        ? `전송이 차단되었습니다: ${result.reason}`
        : `전송에 실패했습니다: ${result.message}`,
    )
  }

  async function cancel(ports: EnginePorts): Promise<void> {
    const workflow = state.workflow
    if (workflow === null) {
      if (state.bypass !== null) apply({ type: 'bypass-revoked', sessionId: state.sessionId })
      notify('진행 중인 개선 작업이 없습니다.')
      return
    }

    const entry = rounds.get(workflow.id)
    if (entry !== undefined) {
      entry.controller.abort()
      rounds.delete(workflow.id)
    }
    resetSystemPrompt()
    // Drop the run before restoring: a late completion then finds it stale and
    // cannot run a second restore or repaint the dialogue.
    apply({ type: 'cancel', workflowId: workflow.id })

    let result: Awaited<ReturnType<typeof transferDraft>>
    try {
      result = await restore(ports, workflow, workflow.original)
    } catch (cause) {
      notify(`개선을 취소했습니다. 원문을 입력창에 복원하지 못했습니다: ${describeError(cause)}`)
      return
    }

    if (result.kind === 'filled') {
      apply({ type: 'bypass-issued', ticket: result.ticket })
      notify('개선을 취소하고 원문을 입력창에 복원했습니다.')
      return
    }
    notify(`개선을 취소했습니다. 원문을 입력창에 복원하지 못했습니다: ${refusalNotice(result.reason)}`)
  }

  function onPromptEdit(text: string): void {
    if (state.bypass === null) return
    if (text.trim() === '') {
      apply({ type: 'bypass-revoked', sessionId: state.sessionId })
      return
    }
    apply({ type: 'bypass-edited', sessionId: state.sessionId, text })
  }

  function onSessionStart(sessionId: string): void {
    abortAll()
    resetSystemPrompt()
    apply({ type: 'reset', sessionId })
  }

  function onSessionEnd(): void {
    abortAll()
    resetSystemPrompt()
    apply({ type: 'reset', sessionId: state.sessionId })
  }

  return {
    getState: () => state,
    onSubmit,
    startExplicit,
    refine,
    retry,
    accept,
    sendDraft: ports => send(ports, 'draft'),
    sendOriginal: ports => send(ports, 'original'),
    cancel,
    onPromptEdit,
    onSessionStart,
    onSessionEnd,
  }
}
