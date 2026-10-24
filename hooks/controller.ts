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

import type { PromptSubmitInput, Timer } from 'claude-code'

import { EMPTY_COMPOSITION, isPasteOnly, noteAutocomplete, noteBox, noteEditInput } from './composition'
import type { Composition } from './composition'
import { loadSystemPromptExtra } from './config'
import { collectContext } from './context'
import { emptyLedger, findDecision, hasPendingCorrection, isActiveDecision } from './decisions'
import { BYPASS_TTL_MS, sendApproved, transferDraft } from './delivery'
import { classifySubmission } from './eligibility'
import { PROMPT_CACHE_MIN_VERSION, supportsPromptCache } from './engine-version'
import {
  buildModelRequest,
  completeRewrite,
  RequestBudgetError,
  REQUEST_BUDGET_NOTICE,
} from './model'
import { decideRawEdit } from './raw-mode'
import type { RawEditFacts } from './raw-mode'
import { resolveTargetModel } from './resolve-target-model'
import { canStartRound, initialState, isStale, reduce, workflowRoundLimit } from './state'
import { composeSystemPrompt } from './system-prompt'
import {
  type BypassTicket,
  type ContextSnapshot,
  type EnginePorts,
  type GuidanceStatus,
  type ModelUsage,
  type OptimizerConfig,
  type OptimizerEvent,
  type RewriteResult,
  type RuntimeState,
  type SubmissionDecision,
  type SubmissionFacts,
  type TransferRefusal,
  type Workflow,
} from './contracts'

/** Pane id the UI opens the dialogue under (task K); a restore closes it. */
export const PANE_ID = 'prompt-optimizer'

/** The one-line Korean notices the person sees, per the design. */
const BUSY_NOTICE = '프롬프트 옵티마이저가 작업 중입니다. /optimize cancel 로 취소할 수 있습니다.'
const REPLY_NOTICE = '보완 요청을 옵티마이저에 전달했습니다.'
const OPTIMIZE_NOTICE = '프롬프트를 다듬는 중입니다.'
const LIMIT_NOTICE = '개선 횟수 한도에 도달했습니다'
const EXTEND_APPROVAL = '추가 5회 허용'
const EXTEND_DECLINE = '현재 개선안 유지'
const EXTEND_GUIDE = '미해결 질문이 남아 있습니다. 5회를 더 허용하려면 패널에서 선택하거나 /optimize more 를 입력하세요.'
const CORRECTION_GUIDE = '정정한 결정이 아직 반영되지 않았습니다. 5회를 더 허용하려면 패널에서 선택하거나 /optimize more 를 입력하세요.'
/** The correction succeeded and a normal retry can apply it. */
export const CORRECTION_NOTICE = '결정을 정정했습니다. /optimize retry로 개선안에 반영하세요.'
/** The correction succeeded but needs an approved round before retry. */
export const CORRECTION_LIMIT_NOTICE =
  '결정을 정정했습니다. 라운드 한도에 도달했으니 /optimize more 로 승인한 뒤 /optimize retry 로 반영하세요.'
const ACCEPT_NOTICE = '개선안을 입력창에 넣었습니다. Enter 로 전송하세요.'

/** The limit guidance that matches why another round would still help. */
function extensionGuide(workflow: Readonly<Workflow> | null | undefined): string {
  return hasPendingCorrection(workflow) ? CORRECTION_GUIDE : EXTEND_GUIDE
}
/** Result reason for an action refused while its run is mid-flight. */
export const IN_FLIGHT_REASON = '개선 작업을 처리하는 중입니다.'

/** How many composer submissions' paste verdicts the controller keeps. */
const RECALLED_MAX = 100

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
  /** UI-only heartbeat, stopped even if a cancelled engine call never settles. */
  timer?: Timer
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
  /** Reopens an already placed pane with focus; the host tracks placement. */
  refocusPane?(): Promise<void>
}

/** What a submit hook should do with one submission. */
export type SubmitOutcome =
  | { action: 'next'; text: string }
  | { action: 'drop'; reason: string }

/**
 * The result of an explicit command that may be refused by the current phase
 * or by the engine. `reason` is the same one-line Korean notice the person
 * would have seen; commands (J) render it as their response.
 */
export type ActionResult = { ok: true } | { ok: false; reason: string }

/** The controller's public surface, as commands (J) and the UI (K) call it. */
export interface OptimizerController {
  getState(): Readonly<RuntimeState>
  /**
   * The target model applied to the last request actually sent, or `null`
   * before one is sent and after a session start/end. Reads stored state only:
   * it never calls the model getter or any other port.
   */
  getGuidanceStatus(): Readonly<GuidanceStatus> | null
  onSubmit(ports: EnginePorts, e: PromptSubmitInput, ui: 'pane' | 'composer'): Promise<SubmitOutcome>
  startExplicit(ports: EnginePorts, text: string | undefined, ui: 'pane' | 'composer'): Promise<void>
  refine(ports: EnginePorts, instruction: string): Promise<void>
  retry(ports: EnginePorts, instruction?: string): Promise<void>
  /** Explicit approval from the extension button or `/optimize more`. */
  extendRounds(ports: EnginePorts): Promise<ActionResult>
  /**
   * Replaces one active user decision with the person's exact new text. State
   * only: it spends no call or round and never touches the draft.
   */
  correctDecision(id: string, text: string): ActionResult
  accept(ports: EnginePorts): Promise<ActionResult>
  sendDraft(ports: EnginePorts, workflowId?: string): Promise<ActionResult>
  sendOriginal(ports: EnginePorts, workflowId?: string): Promise<ActionResult>
  cancel(ports: EnginePorts): Promise<ActionResult>
  onPromptEdit(text: string): void
  /**
   * Notes one `prompt.edit` as it arrives, before the box changes: a key-less
   * insertion of 8 characters (`PASTE_MIN_CHARS`) or more marks the draft as
   * pasted, a carried key as typed (PSTB-2735). The edit hook must call this on
   * entry, before `next`, because a paste and its Enter can arrive in one write
   * and the edit chain can finish after the submit hook (A-REPORT §7).
   */
  observeEditInput(e: { key?: unknown; inputText: string }): void
  /** Observes display text on paths such as long paste that emit no edit. */
  observeComposer(text: string): void
  /**
   * What the plugin saw build the composer draft, for the submit classifier: a
   * draft that was only pasted (or injected by another app) is passed through
   * unchanged when `pasteBypass` is on.
   *
   * `text` is the submitted text. A draft with no observed event at all is
   * pasted, but a prompt recalled from the engine's history also arrives that
   * way and is not a paste; when nothing was observed and `text` was submitted
   * earlier in this controller's life, its remembered verdict is used instead.
   */
  submissionFacts(text: string): SubmissionFacts
  /** A fill invalidates the last user-edit snapshot, but keeps accepted text. */
  clearComposerSnapshot(): void
  /**
   * Notes a landed `prompt.fill` by the plugin. An `emptied` box starts the
   * draft over; otherwise the text is the plugin's own, not a paste, so a later
   * Enter (after any bypass expires) still improves it.
   */
  onFill(emptied: boolean): void
  /**
   * Applies one prompt-box edit to the optimizer-off mode. Returns the box the
   * edit should be replaced with when the edit is consumed (arming or
   * releasing), or `null` to let the edit pass through unchanged.
   */
  onComposerEdit(e: RawEditFacts): { text: string; cursor: number } | null
  /** Clears the optimizer-off mode when it is armed (a fill, a run start). */
  clearRawMode(): void
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
 * `AbortController` per in-flight workflow (keyed by workflow id), the run's
 * cached extra system-prompt text and the last applied {@link GuidanceStatus}.
 * None of it is shared between sessions; `onSessionStart`/`onSessionEnd` tear
 * it all down.
 *
 * `Workflow.generation` stays `0` for a run's whole life: ids from `newId` only
 * increase within a session and never repeat, so {@link isStale} still tells a
 * late result from the current run without bumping the field on cancel/reset.
 */
export function createController(deps: ControllerDeps): OptimizerController {
  let state: RuntimeState = initialState('')
  const rounds = new Map<string, Round>()
  /** The run's extra system-prompt text; read once per run, `null` before that. */
  let extra: string | null = null
  /** The target model applied to the last request actually sent, or `null`. */
  let lastGuidance: Readonly<GuidanceStatus> | null = null
  /** Whether the engine takes cached text blocks; read once per controller, `null` before that. */
  let versionCache: boolean | null = null
  /**
   * The one-time unsupported-version notice, held until a round is actually
   * going ahead. It is `null` once shown (or when the version supports caching).
   */
  let pendingCacheNotice: string | null = null
  // A dialog cannot be closed by the plugin. Keep its slot across workflow
  // resets until it settles, but release it when the session starts or ends.
  let pendingAsk: Workflow | null = null
  /** Last accepted composer text, including a trigger prefix or supplement. */
  let consumedPrompt: { workflowId: string; texts: readonly string[] } | null = null
  /** Raw display text before submission expands pasted-content placeholders. */
  let composerSnapshot: string | undefined
  /**
   * What the plugin saw build the current draft since the box was last empty
   * (`hooks/composition.ts`). Read by `submissionFacts` at submit time; reset
   * when the box is emptied or a submission is consumed.
   */
  let composition: Composition = EMPTY_COMPOSITION
  /**
   * The paste verdict each composer submission's text got in this controller's
   * life, keyed by `text.trim()` (PSTB-2735, review M1). ↑ history recall
   * submits a previous prompt with no edit or autocomplete event, so an
   * unobserved draft looks pasted; a remembered verdict keeps the judgment the
   * text got when it was first sent. Oldest entries are dropped past
   * {@link RECALLED_MAX}, and a session change keeps the map: the engine's
   * input history survives `/clear`.
   */
  const recalled = new Map<string, boolean>()

  function sameQuestion(asked: Workflow): boolean {
    const current = state.workflow
    return state.sessionId === asked.sessionId && current?.id === asked.id
      && current.generation === asked.generation && current.rounds === asked.rounds
      && current.phase === 'reviewing' && current.question === asked.question
  }

  async function refocusAnsweredPane(ports: EnginePorts, asked: Workflow): Promise<void> {
    if (asked.ui !== 'pane' || !deps.refocusPane) return
    try {
      const box = await ports.prompt.read()
      if (box.text !== '' || state.workflow?.id !== asked.id || state.sessionId !== asked.sessionId) return
      await deps.refocusPane()
    } catch {
      // Placement/keyboard ownership can change while the dialog is open.
    }
  }

  /** Detached from the round and submit hook: one dialog per eligible reply. */
  function askQuestion(ports: EnginePorts): void {
    const asked = state.workflow
    if (asked && !canStartRound(state, deps.getConfig().maxRounds)) {
      askRoundExtension(ports)
      return
    }
    if (!asked || asked.phase !== 'reviewing' || !asked.question
      || (asked.options?.length ?? 0) < 2 || asked.questionAsk || pendingAsk || !ports.ui.ask) return
    const question = asked.question
    const mark = (status: 'pending' | 'closed'): void =>
      apply({ type: 'question-ask', workflowId: asked.id, round: asked.rounds, question, status })
    pendingAsk = asked
    mark('pending')
    try {
      void ports.ui.ask(question, { options: asked.options, header: '보완 질문' }).then(answer => {
        if (pendingAsk === asked) pendingAsk = null
        if (!sameQuestion(asked)) {
          ports.ui.log?.('prompt-optimizer: ignored a stale question answer', { to: 'debug' })
          askQuestion(ports)
          return
        }
        mark('closed')
        // refine enters generating synchronously; focus restoration runs beside
        // it, never delaying the answer or waiting for the next completion.
        const refined = refine(ports, answer)
        void refocusAnsweredPane(ports, asked)
        return refined
      }).catch(() => {
        if (pendingAsk === asked) pendingAsk = null
        mark('closed')
        if (!sameQuestion(asked)) askQuestion(ports)
      })
    } catch {
      pendingAsk = null
      mark('closed')
    }
  }

  /** One permission dialog per exhausted round; never itself calls the model. */
  function askRoundExtension(ports: EnginePorts): void {
    const asked = state.workflow
    if (!asked || asked.phase !== 'reviewing'
      || canStartRound(state, deps.getConfig().maxRounds) || asked.limitAsk || pendingAsk) return
    // A correction accepted at the limit clears its answered question but still
    // needs a round, so it gets the same explicit approval path.
    const pendingCorrection = hasPendingCorrection(asked)
    if (!asked.question?.trim() && !pendingCorrection) return
    const mark = (status: 'pending' | 'closed' | 'declined'): void =>
      apply({ type: 'limit-ask', workflowId: asked.id, round: asked.rounds, status })
    if (!ports.ui.ask) {
      mark('closed')
      notify(extensionGuide(asked))
      return
    }
    const current = (): boolean => sameQuestion(asked)
      && !canStartRound(state, deps.getConfig().maxRounds) && state.workflow?.limitAsk === 'pending'
    pendingAsk = asked
    mark('pending')
    try {
      void ports.ui.ask(
        pendingCorrection
          ? `${workflowRoundLimit(asked, deps.getConfig().maxRounds)}회 한도에 도달했지만 정정한 결정이 아직 반영되지 않았습니다. 이번 개선 작업에 5회를 더 허용할까요?`
          : `${workflowRoundLimit(asked, deps.getConfig().maxRounds)}회 한도에 도달했지만 미해결 질문이 남아 있습니다. 이번 개선 작업에 5회를 더 허용할까요?`,
        { options: [EXTEND_APPROVAL, EXTEND_DECLINE], header: '라운드 연장' },
      ).then(async answer => {
        if (pendingAsk === asked) pendingAsk = null
        if (!current()) {
          mark('closed')
          ports.ui.log?.('prompt-optimizer: ignored a stale round-extension answer', { to: 'debug' })
          askQuestion(ports)
          return
        }
        if (answer !== EXTEND_APPROVAL) {
          mark('declined')
          notify('추가 호출 없이 현재 개선안과 미해결 질문을 유지합니다.')
          return
        }
        mark('closed')
        await extendRounds(ports)
        void refocusAnsweredPane(ports, asked)
      }).catch(() => {
        if (pendingAsk === asked) pendingAsk = null
        const wasCurrent = current()
        mark('closed')
        if (wasCurrent) notify(extensionGuide(asked))
        else askQuestion(ports)
      })
    } catch {
      if (pendingAsk === asked) pendingAsk = null
      mark('closed')
      notify(extensionGuide(asked))
    }
  }

  async function extendRounds(ports: EnginePorts): Promise<ActionResult> {
    const workflow = state.workflow
    if (!workflow) return { ok: false, reason: '진행 중인 개선 작업이 없습니다.' }
    if (workflow.phase !== 'reviewing' && workflow.phase !== 'failed') {
      return { ok: false, reason: IN_FLIGHT_REASON }
    }
    if (pendingAsk || workflow.limitAsk === 'pending') {
      return { ok: false, reason: '열린 선택 창에서 추가 라운드 허용 여부를 선택하세요.' }
    }
    const maxRounds = workflowRoundLimit(workflow, deps.getConfig().maxRounds)
    const pendingCorrection = hasPendingCorrection(workflow)
    if (workflow.rounds < maxRounds || (!workflow.question?.trim() && !pendingCorrection)) {
      return { ok: false, reason: '한도에 도달하고 미해결 질문이나 반영할 정정이 남아 있을 때만 연장할 수 있습니다.' }
    }
    apply({ type: 'limit-extended', workflowId: workflow.id, round: workflow.rounds, maxRounds: maxRounds + 5 })
    notify(
      pendingCorrection
        ? `이번 개선 작업의 한도를 ${maxRounds + 5}회로 늘렸습니다. /optimize retry로 정정한 결정을 반영하세요.`
        : `이번 개선 작업의 한도를 ${maxRounds + 5}회로 늘렸습니다. 남은 질문에 답하거나 보완 내용을 입력하세요.`,
    )
    askQuestion(ports)
    return { ok: true }
  }

  /**
   * Whether the engine's `$.model.complete` takes cached text blocks, read from
   * `$.session.version()` at most once per controller. A missing getter, a
   * throw and an unparseable version all mean "no cache", and the answer is
   * memoized so later rounds never re-read it or warn again.
   *
   * The first unsupported read holds one Korean notice instead of emitting it:
   * a person on an old CLI never sees the cache that silently went unused, but
   * `resolveTargetModel`/`version()` can outlive a cancel, so emitting here
   * would toast a run the person already left. `round` flushes the held notice
   * after its own stale/abort check, so a live round shows it once per
   * controller and a cancelled or superseded one shows nothing. A supported
   * version holds nothing. The notice names the detected version when there is
   * one, and says so when the version could not be read.
   */
  async function promptCacheEnabled(ports: EnginePorts): Promise<boolean> {
    if (versionCache !== null) return versionCache
    let supported = false
    let version: string | undefined
    try {
      const info = await ports.session.version?.()
      version = info?.version
      supported = supportsPromptCache(version)
    } catch {
      supported = false
    }
    versionCache = supported
    if (!supported) {
      pendingCacheNotice =
        version === undefined
          ? 'Claude Code 버전을 확인할 수 없어 프롬프트 캐시 없이 동작합니다. CLI를 업데이트하세요.'
          : `Claude Code ${version}은(는) ${PROMPT_CACHE_MIN_VERSION} 미만이라 프롬프트 캐시 없이 동작합니다. CLI를 업데이트하세요.`
    }
    return supported
  }

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

  /**
   * Runs `task` from the schedule queue without letting it reject. The host
   * ignores the scheduled promise, so an unexpected fault is reported as a
   * notice rather than surfacing as an unhandled rejection. The returned
   * promise never rejects, so a test queue that awaits the callback still sees
   * it settle. A `schedule` that throws propagates to the caller, which decides
   * whether to undo a half-started run.
   */
  function scheduleTask(task: () => Promise<void>, failure: (cause: unknown) => string): void {
    deps.schedule(() =>
      Promise.resolve()
        .then(task)
        .catch(cause => notify(failure(cause)))
        .catch(() => {
          // A throwing notice sink must not itself become an unhandled rejection.
        }),
    )
  }

  /**
   * A dropped submission is handed back to the composer by the host. Consume
   * that text only from the scheduled task, after the submit hook has returned,
   * and before a completion can open a question dialog or restore a draft.
   * A new draft, a cancelled run, or an action already in flight owns its box.
   */
  async function consumeAndRun(
    ports: EnginePorts,
    workflow: Workflow,
    submittedTexts: readonly string[],
    instruction?: string,
  ): Promise<void> {
    const current = (): boolean =>
      state.sessionId === workflow.sessionId && !isStale(state, workflow.id, workflow.generation)
      && state.workflow?.phase === workflow.phase && state.workflow.rounds === workflow.rounds

    if (!current()) return
    try {
      const box = await ports.prompt.read()
      // The CLI trims submitted text; retain the actual submitted prefix here,
      // rather than comparing against the classifier's stripped original. A
      // later user edit revokes the raw-placeholder candidate, even while this
      // read is pending; that placeholder can now refer to a different paste.
      const candidates = consumedPrompt?.texts === submittedTexts ? submittedTexts : submittedTexts.slice(0, 1)
      if (current() && box.text !== '' && candidates.some(text => box.text.trim() === text.trim())) {
        await ports.prompt.fill({ text: '', mode: 'replace' })
      }
    } catch {
      // An unavailable/refusing composer must not prevent improvement. The
      // normal delivery conflict check still protects whatever it holds.
    }
    if (!current()) return
    if (instruction === undefined) await runRound(ports)
    else await refine(ports, instruction)
  }

  /** Aborts every in-flight completion; used on cancel and session changes. */
  function abortAll(): void {
    for (const [id, round] of rounds) {
      round.controller.abort()
      releaseRound(id, round.controller)
    }
  }

  /** Removes a round entry only when it is still this round's own. */
  function releaseRound(workflowId: string, controller: AbortController): void {
    const entry = rounds.get(workflowId)
    if (entry?.controller !== controller) return
    rounds.delete(workflowId)
    try {
      entry.timer?.cancel()
    } catch {
      // A refused timer cleanup must not strand a result or cancellation.
      // Its callback is inert once this round has lost ownership.
    }
  }

  /** A heartbeat redraws only live work; it never estimates tokens or completion. */
  function startProgressTimer(ports: EnginePorts, workflow: Workflow, controller: AbortController): void {
    const entry = rounds.get(workflow.id)
    if (!entry || entry.controller !== controller) return
    try {
      entry.timer = ports.clock?.every?.(1000, () => {
        if (rounds.get(workflow.id) !== entry || controller.signal.aborted) return
        try {
          apply({ type: 'progress', workflowId: workflow.id, generation: workflow.generation })
        } catch {
          // A repaint failure cannot fail an otherwise healthy model request.
        }
      })
    } catch {
      // Older/refusing hosts still show stage changes without a live clock.
    }
  }

  /** Drops the run's cached extra prompt; the next run reads the file afresh. */
  function resetExtra(): void {
    extra = null
  }

  /** Clears the run cache and the last-applied guidance on a session change. */
  function resetGuidance(): void {
    extra = null
    lastGuidance = null
    consumedPrompt = null
    composerSnapshot = undefined
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

  /**
   * Closes the run's pane (when any) then fills the given text back in.
   *
   * A tentative permit is placed before the box read/fill so a submission that
   * races the restore already sees the draft's text as its own and bypasses
   * interception instead of starting a second optimization. The fill's own text
   * confirms the permit, or a refusal (or a throw) revokes it. Adopting the fill's
   * ticket is skipped once the tentative one has been consumed, revoked or edited,
   * so a spent permit cannot come back to life and a person's correction is never
   * overwritten.
   */
  async function restore(
    ports: EnginePorts,
    workflow: Workflow,
    text: string,
  ): Promise<Awaited<ReturnType<typeof transferDraft>>> {
    const provisional: BypassTicket = {
      sessionId: workflow.sessionId,
      workflowId: workflow.id,
      text,
      expiresAt: deps.now() + BYPASS_TTL_MS,
    }
    apply({ type: 'bypass-issued', ticket: provisional })

    let result: Awaited<ReturnType<typeof transferDraft>>
    try {
      result = await transferDraft(
        ports,
        {
          sessionId: workflow.sessionId,
          workflowId: workflow.id,
          text,
          mode: 'replace',
        },
        {
          now: deps.now(),
          paneId: workflow.ui === 'pane' ? PANE_ID : undefined,
          // A fill can be refused, or another submit hook can delay the host's
          // handback until after our scheduled clear. Only the already accepted
          // text may be replaced in either case; fresh user input stays protected.
          expectedDraft: consumedPrompt?.workflowId === workflow.id ? consumedPrompt.texts : undefined,
        },
      )
    } catch (cause) {
      if (state.bypass === provisional) {
        apply({ type: 'bypass-revoked', sessionId: workflow.sessionId })
      }
      throw cause
    }

    // Only this restore's own tentative permit may be replaced or revoked: a
    // consumed, revoked or edited permit is a new (or missing) object and must
    // be left alone.
    if (state.bypass === provisional) {
      if (result.kind === 'filled') apply({ type: 'bypass-issued', ticket: result.ticket })
      else apply({ type: 'bypass-revoked', sessionId: workflow.sessionId })
    }
    return result
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
      // `restore` already confirmed the permit with the fill's own text.
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

    const controller = new AbortController()
    rounds.set(workflowId, { controller })
    startProgressTimer(ports, workflow, controller)
    try {
      // The snapshot is read once, on the first round.
      if (workflow.phase === 'idle') {
        apply({ type: 'phase', workflowId, generation, phase: 'collecting' })
        let context: ContextSnapshot | null = null
        try {
          context = await collectContext(ports, config, workflow.original)
        } catch {
          context = null
        }
        if (context !== null) apply({ type: 'context', workflowId, generation, context })
      }

      // A cancel during collection has already stranded this run.
      if (isStale(state, workflowId, generation)) return

      apply({ type: 'phase', workflowId, generation, phase: 'generating' })

      // The extra file is read once per run. Only a live owner may cache it: a
      // cancel or a new run during the read must not be overwritten by this one.
      if (extra === null) {
        let loadedText = ''
        let warning: string | undefined
        try {
          const loaded = await loadSystemPromptExtra(ports, config)
          loadedText = loaded.text
          warning = loaded.warning
        } catch {
          // A missing extra file falls back to the built-in prompt, already the
          // empty `loadedText`; `loadSystemPromptExtra` reports its own warning
          // when it can, but an unexpected throw here leaves none to relay.
          loadedText = ''
        }
        // After the await, a stale or aborted round must not write the cache or
        // notify: its result belongs to a run the person already left.
        if (isStale(state, workflowId, generation) || controller.signal.aborted) {
          releaseRound(workflowId, controller)
          return
        }
        extra = loadedText
        // The prompt is loaded once per run, so this is the run's one warning
        // notice; the warning text itself names the file and the reason. Only a
        // missing/unreadable file leaves `extra` empty and falls back to the
        // built-in prompt; a truncation warning keeps the loaded text.
        if (warning !== undefined && warning !== '') {
          notify(
            loadedText === ''
              ? `시스템 프롬프트 파일을 읽지 못해 기본 프롬프트를 사용합니다: ${warning}`
              : `시스템 프롬프트 파일 안내: ${warning}`,
          )
        }
      }

      // The main session's model is read afresh on every round (the first call,
      // retry and refine alike), just before the request is assembled.
      apply({ type: 'progress', workflowId, generation, stage: 'target-model' })
      const target = await resolveTargetModel(ports, config.modelGuidance, controller.signal)
      // The engine version caps prompt caching; it is read once per controller.
      const cache = await promptCacheEnabled(ports)

      // A cancel during detection must not send or record anything: a `cancelled`
      // snapshot is not permission to complete.
      if (isStale(state, workflowId, generation) || controller.signal.aborted) {
        releaseRound(workflowId, controller)
        return
      }

      const current = state.workflow
      if (current === null || current.id !== workflowId) {
        releaseRound(workflowId, controller)
        return
      }

      // `promptCacheEnabled` held the unsupported-version notice instead of
      // showing it while the round was still cancellable. This is the first
      // point past every stale/abort guard, so the run really is going ahead:
      // show it now, once per controller, and clear it so later rounds stay
      // silent. A cancelled round never reaches here, so its held notice waits
      // for the next live round instead of toasting a run already left.
      if (pendingCacheNotice !== null) {
        const notice = pendingCacheNotice
        pendingCacheNotice = null
        notify(notice)
      }

      const system = composeSystemPrompt(extra, target.profile)
      let request: ReturnType<typeof buildModelRequest>
      try {
        request = buildModelRequest(current, {
          ...config, maxRounds: workflowRoundLimit(current, config.maxRounds),
        }, system, instruction, { cache })
      } catch (cause) {
        // A local preflight refusal is not a model failure: keep the run and
        // its evidence, spend no round or call, and skip the first-failure
        // restore path. Any other build fault keeps the old handling.
        if (!(cause instanceof RequestBudgetError)) throw cause
        apply({
          type: 'budget-blocked',
          workflowId,
          generation,
          sessionId: current.sessionId,
          requiredChars: cause.requiredChars,
          limitChars: cause.limitChars,
          decisionIds: cause.decisionIds,
        })
        notify(REQUEST_BUDGET_NOTICE)
        return
      }

      // Record the model this request actually targets, just before sending.
      lastGuidance = { workflowId, round: current.rounds + 1, target }

      apply({ type: 'progress', workflowId, generation, stage: 'generating' })
      let result: RewriteResult
      try {
        result = await completeRewrite(ports, request, controller.signal)
      } catch (cause) {
        result = { kind: 'failed', reason: 'rejected', message: describeError(cause), usage: ZERO_USAGE }
      }
      // Only drop the entry this round put there (a cancel already removed it).
      releaseRound(workflowId, controller)

      // The reducer folds a same-session stale result's usage without touching
      // the run; the UI must not react either. `reply`/`failed` carry the usage
      // and its owning session, so no second `usage` event is emitted
      // (`DESIGN.md`, 3. 상태 규칙).
      const stale = isStale(state, workflowId, generation)

      if (result.kind === 'ok') {
        // Preserve unresolved decisions in the draft if the person stops here,
        // and retain the question so explicit approval can continue the work.
        if (current.rounds + 1 >= workflowRoundLimit(current, config.maxRounds) && result.reply.question !== null) {
          const heading = /[가-힣]/.test(result.reply.draft)
            ? '미확정 사항 (구현 전 확인)'
            : 'Open decision (resolve before implementation)'
          const options = result.reply.options ?? []
          const choiceLine = options.length > 0 ? `\n- 선택지: ${options.join(' / ')}` : ''
          result = {
            ...result,
            reply: {
              ...result.reply,
              draft: `${result.reply.draft}\n\n${heading}:\n${result.reply.question}${choiceLine}`,
            },
          }
        }
        apply({ type: 'reply', workflowId, generation, sessionId: current.sessionId, reply: result.reply, usage: result.usage })
        if (stale) return
        const question = result.reply.question
        const options = result.reply.options ?? []
        const notice = question !== null && question !== ''
          ? `질문: ${question}${options.length > 0 ? ` (선택지 ${options.length}개)` : ''}`
          : result.reply.message
        if (notice !== '') notify(notice)
        askQuestion(ports)
        return
      }

      apply({ type: 'failed', workflowId, generation, sessionId: current.sessionId, error: result.message, usage: result.usage })
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
    } catch (cause) {
      controller.abort()
      throw cause
    } finally {
      releaseRound(workflowId, controller)
    }
  }

  /**
   * Runs one round, never letting a scheduled (unawaited) round reject. An
   * unexpected fault releases the run so later submissions are not trapped.
   */
  async function runRound(ports: EnginePorts, instruction?: string): Promise<void> {
    const owner = state.workflow
    try {
      await round(ports, instruction)
    } catch (cause) {
      if (!owner || isStale(state, owner.id, owner.generation)) return
      const workflow = state.workflow
      if (workflow !== null && workflow.phase !== 'reviewing' && workflow.phase !== 'failed') {
        const entry = rounds.get(workflow.id)
        if (entry !== undefined) {
          entry.controller.abort()
          releaseRound(workflow.id, entry.controller)
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
    // The engine clears the box before this hook, then may hand back its raw
    // paste placeholders on drop. The last edit is the only pre-expansion
    // snapshot. Consume it once so another submission cannot reuse stale text.
    const submittedTexts = e.origin.kind !== 'composer' || composerSnapshot === undefined
      ? [e.text] : [e.text, composerSnapshot]
    if (e.origin.kind === 'composer') composerSnapshot = undefined
    let decision: SubmissionDecision
    // What the plugin saw build this draft, read before the classifier (and
    // before the draft's composition is consumed below), so this pass and the
    // pre-classification in `register` see the same facts. Record the verdict
    // right here, including on the classify-failure path below, so a later
    // no-event submission of the same text (↑ recall) can reuse it.
    const facts = e.origin.kind === 'composer' ? submissionFacts(e.text) : undefined
    if (facts !== undefined) remember(e.text, facts.pasted)
    try {
      decision = classifySubmission(e, deps.getConfig(), state, deps.now(), facts)
    } catch {
      // Classification itself failing must not trap the person: pass through.
      // The mode is still one-shot, so clear it before returning, and a composer
      // draft is consumed for the same reason.
      if (e.origin.kind === 'composer') composition = EMPTY_COMPOSITION
      if (state.rawMode !== null) apply({ type: 'raw-mode-cleared', sessionId: state.sessionId })
      return { action: 'next', text: e.text }
    }

    // A composer submission is one-shot for the draft's composition, whatever
    // the classifier decided: the engine clears the box, and a dropped
    // submission is handed back (the restore fill re-observes it).
    if (e.origin.kind === 'composer') composition = EMPTY_COMPOSITION

    // The optimizer-off mode is one-shot: whatever the classifier decided, a
    // mode armed at classification time is cleared by this submission.
    if (state.rawMode !== null) apply({ type: 'raw-mode-cleared', sessionId: state.sessionId })

    switch (decision.kind) {
      case 'pass':
        return { action: 'next', text: e.text }

      case 'raw':
        // The classifier hands back the remainder even when it is empty or only
        // spaces; there is nothing to send, so drop instead of forwarding it.
        if (decision.text.trim() === '') {
          return { action: 'drop', reason: '보낼 내용이 없습니다.' }
        }
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

      case 'reply': {
        const workflow = state.workflow
        if (workflow === null) return { action: 'drop', reason: BUSY_NOTICE }
        if (!canStartRound(state, deps.getConfig().maxRounds)) {
          askRoundExtension(ports)
          return { action: 'drop', reason: `${LIMIT_NOTICE}. ${extensionGuide(workflow)}` }
        }
        try {
          scheduleTask(
            () => consumeAndRun(ports, workflow, submittedTexts, decision.text),
            cause => `보완 요청을 처리하지 못했습니다: ${describeError(cause)}`,
          )
          consumedPrompt = { workflowId: workflow.id, texts: submittedTexts }
        } catch (cause) {
          notify(`보완 요청을 예약하지 못했습니다: ${describeError(cause)}`)
        }
        return { action: 'drop', reason: REPLY_NOTICE }
      }

      case 'optimize': {
        let workflow: Workflow | null = null
        try {
          resetExtra()
          workflow = makeWorkflow(decision.text, e.context ?? [], ui)
          apply({ type: 'start', workflow })
          const scheduledWorkflow = workflow
          scheduleTask(
            () => consumeAndRun(ports, scheduledWorkflow, submittedTexts),
            cause => `개선을 시작하지 못했습니다: ${describeError(cause)}`,
          )
          consumedPrompt = { workflowId: workflow.id, texts: submittedTexts }
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
    // An explicit /optimize run supersedes the optimizer-off mode.
    clearRawMode()
    composerSnapshot = undefined
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

    let workflow: Workflow | null = null
    try {
      resetExtra()
      workflow = makeWorkflow(source, [], ui)
      apply({ type: 'start', workflow })
      const scheduledWorkflow = workflow
      scheduleTask(
        () => consumeAndRun(ports, scheduledWorkflow, [scheduledWorkflow.original]),
        cause => `개선을 시작하지 못했습니다: ${describeError(cause)}`,
      )
      consumedPrompt = { workflowId: workflow.id, texts: [workflow.original] }
    } catch (cause) {
      // Undo a half-started run, as the Enter path does, so the person is not
      // stuck behind a workflow that never had a clock to run on. `consumedPrompt`
      // is set only after `scheduleTask`, so a failed attempt never owns it and
      // an older run's entry stays untouched.
      if (workflow !== null) {
        try {
          apply({ type: 'cancel', workflowId: workflow.id })
        } catch {
          // A throwing state listener must not swallow the failure notice.
        }
      }
      notify(`개선을 시작하지 못했습니다: ${describeError(cause)}`)
    }
  }

  async function refine(ports: EnginePorts, instruction: string): Promise<void> {
    const workflow = state.workflow
    if (workflow === null || (workflow.phase !== 'reviewing' && workflow.phase !== 'failed')) {
      notify('보완할 개선안이 없습니다.')
      return
    }
    if (!canStartRound(state, deps.getConfig().maxRounds)) {
      notify(LIMIT_NOTICE)
      askRoundExtension(ports)
      return
    }
    apply({ type: 'instruct', workflowId: workflow.id, text: instruction })
    // The supplement now lives in the dialogue, which `buildModelRequest`
    // renders; `''` stops it from also filling the `<instruction>` section
    // (whose fallback is the same dialogue turn, doubling the text).
    await runRound(ports, '')
  }

  async function retry(ports: EnginePorts, instruction?: string): Promise<void> {
    const workflow = state.workflow
    if (workflow === null || (workflow.phase !== 'reviewing' && workflow.phase !== 'failed')) {
      notify('다시 생성할 작업이 없습니다.')
      return
    }
    if (!canStartRound(state, deps.getConfig().maxRounds)) {
      notify(LIMIT_NOTICE)
      askRoundExtension(ports)
      return
    }
    if (instruction !== undefined && instruction !== '') {
      apply({ type: 'instruct', workflowId: workflow.id, text: instruction })
      await runRound(ports, '')
      return
    }
    // A bare retry must not re-render the last supplement as `<instruction>`
    // (it is already in the dialogue); `''` keeps it from doubling.
    await runRound(ports, '')
  }

  function correctDecision(id: string, text: string): ActionResult {
    const workflow = state.workflow
    if (workflow === null) return refuseCorrection('진행 중인 개선 작업이 없습니다.')
    if (workflow.phase !== 'reviewing' && workflow.phase !== 'failed') {
      return { ok: false, reason: IN_FLIGHT_REASON }
    }
    // A host dialog cannot be closed by the plugin: refuse rather than clear a
    // pending marker while the person still sees the old choices.
    if (pendingAsk !== null || workflow.questionAsk === 'pending' || workflow.limitAsk === 'pending') {
      return refuseCorrection('열린 선택 창을 먼저 닫아 주세요.')
    }
    const ledger = workflow.decisions ?? emptyLedger()
    if (findDecision(ledger, id) === undefined) {
      return refuseCorrection(`결정 ${id}을(를) 찾지 못했습니다. /optimize decisions로 id를 확인하세요.`)
    }
    if (!isActiveDecision(ledger, id)) {
      return refuseCorrection(`결정 ${id}은(는) 이미 대체되었습니다. 활성 결정을 정정하세요.`)
    }
    if (text.trim() === '') return refuseCorrection('정정할 내용을 입력하세요.')

    apply({ type: 'decision-corrected', workflowId: workflow.id, targetId: id, text })
    // The notice has to be actionable: at the limit a retry would be refused
    // before it could apply the correction, so name the approval step first.
    notify(canStartRound(state, deps.getConfig().maxRounds) ? CORRECTION_NOTICE : CORRECTION_LIMIT_NOTICE)
    return { ok: true }
  }

  /** Notifies one correction refusal and returns it for the command's answer. */
  function refuseCorrection(reason: string): ActionResult {
    notify(reason)
    return { ok: false, reason }
  }

  async function accept(ports: EnginePorts): Promise<ActionResult> {
    const workflow = state.workflow
    if (workflow === null) {
      notify('복원할 개선안이 없습니다.')
      return { ok: false, reason: '복원할 개선안이 없습니다.' }
    }
    // `transferring`/`sending` mean a button is already being handled: ignore
    // the double press rather than fill or submit twice.
    if (workflow.phase !== 'reviewing' && workflow.phase !== 'failed') {
      return { ok: false, reason: IN_FLIGHT_REASON }
    }
    if (workflow.draft === '') {
      notify('복원할 개선안이 없습니다.')
      return { ok: false, reason: '복원할 개선안이 없습니다.' }
    }

    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'transferring' })

    let result: Awaited<ReturnType<typeof transferDraft>>
    try {
      result = await restore(ports, workflow, workflow.draft)
    } catch (cause) {
      apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
      const reason = `개선안을 입력창에 넣지 못했습니다: ${describeError(cause)}`
      notify(reason)
      return { ok: false, reason }
    }

    if (result.kind === 'filled') {
      // `restore` already confirmed the permit with the fill's own text.
      apply({ type: 'dismiss', workflowId: workflow.id })
      notify(ACCEPT_NOTICE)
      return { ok: true }
    }
    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
    const reason = refusalNotice(result.reason)
    notify(reason)
    return { ok: false, reason }
  }

  async function send(
    ports: EnginePorts,
    source: 'draft' | 'original',
    workflowId?: string,
  ): Promise<ActionResult> {
    const workflow = state.workflow
    if (workflow === null) {
      notify('전송할 개선 작업이 없습니다.')
      return { ok: false, reason: '전송할 개선 작업이 없습니다.' }
    }
    // A caller that captured an id before deferring (the `/optimize send`
    // command) must not send a different run that replaced it meanwhile.
    if (workflowId !== undefined && workflow.id !== workflowId) {
      const reason = '개선 작업이 바뀌어 전송하지 않았습니다.'
      notify(reason)
      return { ok: false, reason }
    }
    if (workflow.phase !== 'reviewing' && workflow.phase !== 'failed') {
      return { ok: false, reason: IN_FLIGHT_REASON }
    }

    const text = source === 'draft' ? workflow.draft : workflow.original
    if (text === '') {
      const reason = source === 'draft' ? '전송할 개선안이 없습니다.' : '전송할 원문이 없습니다.'
      notify(reason)
      return { ok: false, reason }
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
      const reason = `전송에 실패했습니다: ${describeError(cause)}`
      notify(reason)
      return { ok: false, reason }
    }

    if (result.kind === 'sent') {
      apply({ type: 'dismiss', workflowId: workflow.id })
      notify('전송했습니다.')
      return { ok: true }
    }
    apply({ type: 'phase', workflowId: workflow.id, generation: workflow.generation, phase: 'reviewing' })
    const reason =
      result.kind === 'dropped'
        ? `전송이 차단되었습니다: ${result.reason}`
        : `전송에 실패했습니다: ${result.message}`
    notify(reason)
    return { ok: false, reason }
  }

  async function cancel(ports: EnginePorts): Promise<ActionResult> {
    const workflow = state.workflow
    if (workflow === null) {
      if (state.bypass !== null) apply({ type: 'bypass-revoked', sessionId: state.sessionId })
      notify('진행 중인 개선 작업이 없습니다.')
      return { ok: false, reason: '진행 중인 개선 작업이 없습니다.' }
    }

    // A transfer or send is already under way: aborting here would race a
    // second `transferDraft`/`sendApproved` against the first. Refuse instead.
    if (workflow.phase === 'transferring') {
      const reason = '입력창으로 옮기는 중이라 취소할 수 없습니다'
      notify(reason)
      return { ok: false, reason }
    }
    if (workflow.phase === 'sending') {
      const reason = '전송 중이라 취소할 수 없습니다'
      notify(reason)
      return { ok: false, reason }
    }

    const entry = rounds.get(workflow.id)
    if (entry !== undefined) {
      entry.controller.abort()
      releaseRound(workflow.id, entry.controller)
    }
    resetExtra()
    // Drop the run before restoring: a late completion then finds it stale and
    // cannot run a second restore or repaint the dialogue.
    apply({ type: 'cancel', workflowId: workflow.id })

    let result: Awaited<ReturnType<typeof transferDraft>>
    try {
      result = await restore(ports, workflow, workflow.original)
    } catch (cause) {
      const reason = `개선을 취소했습니다. 원문을 입력창에 복원하지 못했습니다: ${describeError(cause)}`
      notify(reason)
      return { ok: false, reason }
    }

    if (result.kind === 'filled') {
      // `restore` already confirmed the permit with the fill's own text.
      notify('개선을 취소하고 원문을 입력창에 복원했습니다.')
      return { ok: true }
    }
    const reason = `개선을 취소했습니다. 원문을 입력창에 복원하지 못했습니다: ${refusalNotice(result.reason)}`
    notify(reason)
    return { ok: false, reason }
  }

  function onPromptEdit(text: string): void {
    // The box's text is the running draft's anchor: an emptied box (the
    // engine's own clear, or a person deleting everything) starts a fresh draft.
    composition = noteBox(composition, text)
    composerSnapshot = text
    // Once the person edits again, an old paste placeholder no longer proves
    // ownership of the box. Keep only the actual submitted text as a fallback.
    if (consumedPrompt !== null) consumedPrompt = { ...consumedPrompt, texts: consumedPrompt.texts.slice(0, 1) }
    if (state.rawMode !== null) {
      apply({ type: 'raw-mode-seen', sessionId: state.sessionId, draft: text })
    }
    if (state.bypass === null) return
    if (text.trim() === '') {
      apply({ type: 'bypass-revoked', sessionId: state.sessionId })
      return
    }
    apply({ type: 'bypass-edited', sessionId: state.sessionId, text })
  }

  function observeEditInput(e: { key?: unknown; inputText: string }): void {
    composition = noteEditInput(composition, e)
  }

  function submissionFacts(text: string): SubmissionFacts {
    // A recalled history entry emits no edit or autocomplete event, so an
    // unobserved draft would look pasted. A remembered verdict for the same
    // text stands instead; anything observed keeps the composition's judgment.
    if (!composition.observed) {
      const remembered = recalled.get(text.trim())
      if (remembered !== undefined) return { pasted: remembered }
    }
    return { pasted: isPasteOnly(composition) }
  }

  /** Records one composer submission's pasted verdict, evicting the oldest. */
  function remember(text: string, pasted: boolean): void {
    const key = text.trim()
    if (key === '') return
    recalled.delete(key)
    recalled.set(key, pasted)
    if (recalled.size > RECALLED_MAX) {
      const oldest = recalled.keys().next().value
      if (oldest !== undefined) recalled.delete(oldest)
    }
  }

  function onFill(emptied: boolean): void {
    // The plugin wrote the box, not the person: an empty replacement starts the
    // draft over, any other text is the plugin's own (not a paste), so a later
    // Enter still improves it once the restore's bypass ticket is gone.
    composition = emptied ? EMPTY_COMPOSITION : { ...EMPTY_COMPOSITION, observed: true }
  }

  function onComposerEdit(e: RawEditFacts): { text: string; cursor: number } | null {
    const mode = state.rawMode
    // The box changed on a path that reported no edit (backspace at 0, Esc, a
    // history move, ...): the remembered draft no longer matches, so the mode
    // is dropped rather than trusted as the person's own marker.
    if (mode !== null && e.text !== mode.draft) {
      apply({ type: 'raw-mode-cleared', sessionId: state.sessionId })
    }
    const decision = decideRawEdit(
      e,
      state.rawMode !== null,
      deps.getConfig().rawPrefix,
      state.workflow !== null,
    )
    switch (decision.kind) {
      case 'arm':
        apply({ type: 'raw-mode-armed', sessionId: state.sessionId, draft: decision.box.text })
        return decision.box
      case 'release':
        apply({ type: 'raw-mode-cleared', sessionId: state.sessionId })
        return decision.box
      case 'pass':
        return null
    }
  }

  function clearRawMode(): void {
    if (state.rawMode === null) return
    apply({ type: 'raw-mode-cleared', sessionId: state.sessionId })
  }

  function onSessionStart(sessionId: string): void {
    abortAll()
    pendingAsk = null
    resetGuidance()
    composition = EMPTY_COMPOSITION
    apply({ type: 'reset', sessionId })
  }

  function onSessionEnd(): void {
    abortAll()
    pendingAsk = null
    resetGuidance()
    composition = EMPTY_COMPOSITION
    apply({ type: 'reset', sessionId: state.sessionId })
  }

  return {
    getState: () => state,
    getGuidanceStatus: () => lastGuidance,
    onSubmit,
    startExplicit,
    refine,
    retry,
    extendRounds,
    correctDecision,
    accept,
    sendDraft: (ports, workflowId) => send(ports, 'draft', workflowId),
    sendOriginal: (ports, workflowId) => send(ports, 'original', workflowId),
    cancel,
    onPromptEdit,
    observeEditInput,
    observeComposer: text => {
      // Autocomplete sees a long paste's placeholder even though no edit
      // arrived for it, so the draft's composition follows it whichever branch
      // below handles the host's handback. Do not treat it as a user edit or
      // repopulate a snapshot consumed by a still-running submit.
      composition = noteAutocomplete(composition, text)
      const workflow = state.workflow
      if (workflow === null || workflow.phase === 'reviewing' || workflow.phase === 'failed') {
        composerSnapshot = text
      }
    },
    submissionFacts,
    clearComposerSnapshot: () => { composerSnapshot = undefined },
    onFill,
    onComposerEdit,
    clearRawMode,
    onSessionStart,
    onSessionEnd,
  }
}
