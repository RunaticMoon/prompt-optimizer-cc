/**
 * Pure reducer for one session's optimizer state (DESIGN 3, 작업 G).
 *
 * The reducer owns the serializable half of a run — the single active
 * {@link Workflow}, the outstanding {@link BypassTicket}, and the per-session
 * {@link UsageTotals}. Timers, `AbortController`s and pending promises stay in
 * the callers' runtime memory and never enter this module.
 *
 * Every entry point is pure: `reduce` never mutates its input, always builds a
 * new object for a real change (returning the input unchanged when an event is
 * ignored), and never touches an engine or a UI. That keeps the race rules
 * testable in isolation: stale generations, button double-presses, cancel and
 * session reset all resolve here, before any side effect runs.
 */
import type {
  AnswerSource,
  ModelUsage,
  OptimizerEvent,
  OptimizerMessage,
  OptimizerReply,
  Phase,
  RuntimeState,
  UsageTotals,
  Workflow,
} from './contracts'
import { appendAnswer, emptyLedger, questionIdFor } from './decisions'

/**
 * The only legal `phase` moves. Everything else — including a move to the same
 * phase — is ignored, which is what makes an approval button's second press a
 * no-op rather than a second transfer.
 *
 * - idle → collecting: a new run began.
 * - collecting → generating: the snapshot landed and a completion started.
 * - generating → reviewing | failed: the completion settled.
 * - reviewing | failed → generating | transferring | sending: refine, restore,
 *   or send.
 * - transferring | sending → reviewing | idle: the transfer/send was refused
 *   (back to review) or the run is over.
 */
const PHASE_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  idle: ['collecting'],
  collecting: ['generating'],
  generating: ['reviewing', 'failed'],
  reviewing: ['generating', 'transferring', 'sending'],
  failed: ['generating', 'transferring', 'sending'],
  transferring: ['reviewing', 'idle'],
  sending: ['reviewing', 'idle'],
}

/** The empty state for a session: no run, no permit, no recorded usage. */
export function initialState(sessionId: string): RuntimeState {
  return {
    sessionId,
    workflow: null,
    bypass: null,
    rawMode: null,
    usage: {
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      updatedAt: 0,
    },
  }
}

/** Sums two token counts field by field. */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

/**
 * Whether one generation-bearing result belongs to a run the state no longer
 * holds. Callers use this to discard a late completion before showing it.
 */
export function isStale(
  state: Readonly<RuntimeState>,
  workflowId: string,
  generation: number,
): boolean {
  const workflow = state.workflow
  return workflow === null || workflow.id !== workflowId || workflow.generation !== generation
}

/** The configured allowance, extended only for this workflow when approved. */
export function workflowRoundLimit(workflow: Workflow | null, configured: number): number {
  return Math.max(configured, workflow?.roundLimit ?? 0)
}

/** Whether another completion is still allowed for the active run. */
export function canStartRound(state: Readonly<RuntimeState>, maxRounds: number): boolean {
  const workflow = state.workflow
  return workflow !== null && workflow.rounds < workflowRoundLimit(workflow, maxRounds)
}

/**
 * Applies one event and returns the next state.
 *
 * @param state the current state; never mutated
 * @param event one reducer input
 * @param now epoch milliseconds, for bypass expiry and `usage.updatedAt`
 * @returns the next state (the input itself when the event changes nothing)
 */
export function reduce(state: Readonly<RuntimeState>, event: OptimizerEvent, now: number): RuntimeState {
  // A permit past its instant is gone before the event is even considered, so
  // no branch below can act on (or re-issue) a dead ticket.
  const base = expireBypass(state, now)

  switch (event.type) {
    case 'start': {
      const current = base.workflow
      // One run per session: an in-flight run cannot be displaced by another.
      if (current !== null && current.phase !== 'idle') return base
      // Every real run starts with a ledger and a null pending-question id;
      // fixture workflows that predate the fields get the same defaults.
      return {
        ...base,
        workflow: {
          ...event.workflow,
          decisions: event.workflow.decisions ?? emptyLedger(),
          questionId: event.workflow.questionId ?? null,
        },
      }
    }

    case 'phase': {
      const current = matchWorkflow(base, event.workflowId, event.generation)
      if (current === null) return base
      if (!PHASE_TRANSITIONS[current.phase].includes(event.phase)) return base
      const active = event.phase === 'collecting' || event.phase === 'generating'
      const continuing = current.phase === 'collecting' && event.phase === 'generating'
      return {
        ...base,
        workflow: {
          ...current,
          phase: event.phase,
          progress: active ? {
            stage: event.phase === 'collecting' ? 'context' : 'instructions',
            startedAt: continuing ? current.progress?.startedAt ?? now : now,
            updatedAt: now,
          } : undefined,
        },
      }
    }

    case 'progress': {
      const current = matchWorkflow(base, event.workflowId, event.generation)
      if (!current?.progress || (current.phase !== 'collecting' && current.phase !== 'generating')) return base
      const stage = event.stage ?? current.progress.stage
      const updatedAt = Math.max(current.progress.updatedAt, now)
      if (stage === current.progress.stage && updatedAt === current.progress.updatedAt) return base
      return {
        ...base,
        workflow: { ...current, progress: { ...current.progress, stage, updatedAt } },
      }
    }

    case 'reply': {
      // The tokens were spent even if the run is gone, so the session total
      // still grows for this session's own completions; only the workflow
      // update is generation-gated. A result from another session belongs
      // there and changes nothing here.
      const usage = event.sessionId === base.sessionId
        ? addTotals(base.usage, event.usage, now)
        : base.usage
      const current = matchWorkflow(base, event.workflowId, event.generation)
      if (current === null) return usage === base.usage ? base : { ...base, usage }

      const question = event.reply.question
      const updated: Workflow = {
        ...current,
        phase: 'reviewing',
        progress: undefined,
        draft: event.reply.draft,
        message: event.reply.message,
        question,
        // A fresh id per successful reply; the reply's other fields remain
        // unconfirmed model output, never user evidence.
        questionId: question === null || question === ''
          ? null
          : questionIdFor(current.id, current.generation, current.rounds + 1),
        options: event.reply.options ?? [],
        rounds: current.rounds + 1,
        usage: addUsage(current.usage, event.usage),
      }
      const entry = dialogueEntry(event.reply)
      if (entry !== null) updated.dialogue = [...current.dialogue, entry]
      // A recovery reply clears the failure that preceded it.
      delete updated.lastError
      delete updated.questionAsk
      delete updated.limitAsk
      return { ...base, usage, workflow: updated }
    }

    case 'question-ask': {
      const current = base.workflow
      if (!current || current.id !== event.workflowId || current.rounds !== event.round
        || current.phase !== 'reviewing' || current.question !== event.question) return base
      if (current.questionAsk === event.status) return base
      return { ...base, workflow: { ...current, questionAsk: event.status } }
    }

    case 'limit-ask': {
      const current = base.workflow
      if (!current || current.id !== event.workflowId || current.rounds !== event.round) return base
      // A dialog can close after another action changed the phase. Release its
      // pending marker so a refused transfer can return to an actionable review.
      const closingPending = event.status === 'closed' && current.limitAsk === 'pending'
      if (!closingPending && current.phase !== 'reviewing' && current.phase !== 'failed') return base
      if (current.limitAsk === event.status) return base
      return { ...base, workflow: { ...current, limitAsk: event.status } }
    }

    case 'limit-extended': {
      const current = base.workflow
      if (!current || current.id !== event.workflowId || current.rounds !== event.round
        || (current.phase !== 'reviewing' && current.phase !== 'failed')) return base
      if (!(event.maxRounds > current.rounds && event.maxRounds > (current.roundLimit ?? 0))) return base
      return { ...base, workflow: { ...current, roundLimit: event.maxRounds, limitAsk: 'closed' } }
    }

    case 'failed': {
      const usage =
        event.usage === undefined || event.sessionId !== base.sessionId
          ? base.usage
          : addTotals(base.usage, event.usage, now)
      const current = matchWorkflow(base, event.workflowId, event.generation)
      if (current === null) {
        return usage === base.usage ? base : { ...base, usage }
      }

      const updated: Workflow = {
        ...current,
        phase: 'failed',
        progress: undefined,
        lastError: event.error,
        rounds: current.rounds + 1,
        usage: event.usage === undefined ? current.usage : addUsage(current.usage, event.usage),
      }
      delete updated.questionAsk
      delete updated.limitAsk
      return { ...base, usage, workflow: updated }
    }

    case 'usage': {
      // Same ownership rule as `reply`/`failed`: another session's completion
      // never moves this session's totals.
      const totals = event.sessionId === base.sessionId
        ? addTotals(base.usage, event.usage, now)
        : base.usage
      const current = matchWorkflow(base, event.workflowId, event.generation)
      if (current === null) {
        return totals === base.usage ? base : { ...base, usage: totals }
      }
      return {
        ...base,
        usage: totals,
        workflow: { ...current, usage: addUsage(current.usage, event.usage) },
      }
    }

    case 'context': {
      const current = matchWorkflow(base, event.workflowId, event.generation)
      if (current === null) return base
      return { ...base, workflow: { ...current, context: event.context } }
    }

    case 'instruct': {
      const current = base.workflow
      if (current === null || current.id !== event.workflowId) return base
      if (current.phase !== 'reviewing' && current.phase !== 'failed') return base
      // Capture the question/options before clearing them: a bare "1번" is
      // meaningless once its source is gone. Blank text is not an answer and
      // adds no ledger entry.
      const ledger = current.decisions ?? emptyLedger()
      const captured = event.text.trim() === ''
        ? null
        : appendAnswer(ledger, event.text, answerSource(current))
      const userTurn: OptimizerMessage = captured === null
        ? { role: 'user', text: event.text }
        : { role: 'user', text: event.text, decisionId: captured.decision.id }
      // Phase stays put: the caller emits `phase generating` right after.
      return {
        ...base,
        workflow: {
          ...current,
          decisions: captured === null ? current.decisions : captured.ledger,
          dialogue: [...current.dialogue, userTurn],
          question: null,
          questionId: null,
          options: [],
          questionAsk: undefined,
          limitAsk: undefined,
        },
      }
    }

    case 'cancel': {
      const current = base.workflow
      if (current === null || current.id !== event.workflowId) return base
      // Dropping the workflow is enough to strand in-flight results: a later
      // generation's reply finds neither the id nor a workflow to update.
      return { ...base, workflow: null }
    }

    case 'dismiss': {
      const current = base.workflow
      if (current === null || current.id !== event.workflowId) return base
      return { ...base, workflow: null }
    }

    case 'reset': {
      // A different session starts clean; the same session keeps its usage.
      if (event.sessionId !== base.sessionId) return initialState(event.sessionId)
      return { ...base, workflow: null, bypass: null, rawMode: null }
    }

    case 'bypass-issued': {
      if (event.ticket.sessionId !== base.sessionId) return base
      return { ...base, bypass: event.ticket }
    }

    case 'bypass-consumed':
    case 'bypass-revoked': {
      if (event.sessionId !== base.sessionId) return base
      return { ...base, bypass: null }
    }

    case 'bypass-edited': {
      const bypass = base.bypass
      if (bypass === null || bypass.sessionId !== event.sessionId) return base
      return { ...base, bypass: { ...bypass, text: event.text } }
    }

    case 'raw-mode-armed': {
      if (event.sessionId !== base.sessionId) return base
      return { ...base, rawMode: { sessionId: event.sessionId, draft: event.draft } }
    }

    case 'raw-mode-seen': {
      const mode = base.rawMode
      if (mode === null || mode.sessionId !== event.sessionId) return base
      if (mode.draft === event.draft) return base
      return { ...base, rawMode: { ...mode, draft: event.draft } }
    }

    case 'raw-mode-cleared': {
      if (event.sessionId !== base.sessionId) return base
      if (base.rawMode === null) return base
      return { ...base, rawMode: null }
    }

    default:
      return base
  }
}

/** Clears a permit whose instant has passed. */
function expireBypass(state: Readonly<RuntimeState>, now: number): RuntimeState {
  const bypass = state.bypass
  if (bypass === null || now < bypass.expiresAt) return state
  return { ...state, bypass: null }
}

/**
 * The active workflow when `workflowId`/`generation` name it, otherwise `null`.
 *
 * Returning the narrowed workflow (rather than a boolean) lets every branch
 * treat a mismatch and a missing workflow identically without a second check.
 */
function matchWorkflow(
  state: Readonly<RuntimeState>,
  workflowId: string,
  generation: number,
): Workflow | null {
  const workflow = state.workflow
  if (workflow === null || workflow.id !== workflowId || workflow.generation !== generation) return null
  return workflow
}

/** Folds one completion's tokens into the session total and stamps `now`. */
function addTotals(totals: UsageTotals, usage: ModelUsage, now: number): UsageTotals {
  return {
    calls: totals.calls + 1,
    input: totals.input + usage.input_tokens,
    output: totals.output + usage.output_tokens,
    cacheRead: totals.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: totals.cacheWrite + usage.cache_creation_input_tokens,
    updatedAt: now,
  }
}

/**
 * Captures the question/options on screen when an answer arrives. The options
 * are copied so a later workflow update cannot mutate recorded evidence.
 */
function answerSource(workflow: Readonly<Workflow>): AnswerSource {
  return {
    kind: 'user-answer',
    questionId: workflow.questionId ?? null,
    question: workflow.question ?? null,
    options: [...(workflow.options ?? [])],
    answeredAfterRound: workflow.rounds,
  }
}

/**
 * The dialogue entry for one optimizer reply. `OptimizerMessage` carries only
 * text, so the change note and the clarifying question (when any) share one
 * `optimizer` turn in the order the model produced them. A reply with nothing
 * to say adds no entry.
 */
function dialogueEntry(reply: OptimizerReply): OptimizerMessage | null {
  const parts: string[] = []
  if (reply.message !== '') parts.push(reply.message)
  if (reply.question !== null && reply.question !== '') parts.push(reply.question)
  if (parts.length === 0) return null
  return { role: 'optimizer', text: parts.join('\n') }
}
