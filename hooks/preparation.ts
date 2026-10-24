/**
 * One round's preparation clock (issue #32).
 *
 * Preparation (context, system instructions, target model, engine version) is
 * optional work that used to wait on host reads with no bound of its own. This
 * module gives those reads one shared budget: an absolute deadline, one overall
 * timer, and a short per-step timer. A step that runs out of time settles as
 * `timeout` (its own limit) or `budget` (the round's deadline) and the caller
 * continues with a fallback. Cancelling the round settles every pending step at
 * once, so a host read that never resolves can no longer keep the scheduled
 * round alive.
 *
 * The helper deliberately owns no controller state and calls no callbacks
 * inside the race: a step returns data, and the caller checks that its own
 * workflow still owns the round before applying anything. Timers come from the
 * engine's optional `clock.sleep`; when the host has no usable timer the helper
 * fails closed (`unavailable`/`error`) instead of awaiting a task unbounded.
 * Aborting a step's signal is a request, not a guarantee: host I/O that ignores
 * signals still finishes late, and its result is simply no longer awaited.
 */

import type { EnginePorts } from './contracts'

/** Whole preparation window for one round, before the model request starts. */
export const PREPARATION_TOTAL_MS = 5000

/** Usual per-step limit for one optional read or getter. */
export const PREPARATION_STEP_MS = 500

/** How a bounded preparation step ended. */
export type PreparationFailure = 'timeout' | 'budget' | 'cancelled' | 'error' | 'unavailable'

/** One step's outcome: its value, or why preparation gave it up. */
export type PreparationResult<T> = { kind: 'ok'; value: T } | { kind: PreparationFailure }

/** A reason a caller may report as a degraded optional section (never `ok`). */
export type PreparationDegradation = Exclude<PreparationResult<never>['kind'], 'ok' | 'cancelled'>

/**
 * Thrown by collectors when the shared budget was cancelled, so a broad
 * `catch` that turns failures into empty defaults cannot swallow a cancel.
 */
export class PreparationCancelled extends Error {
  constructor() {
    super('preparation cancelled')
    this.name = 'PreparationCancelled'
  }
}

/** Every helper that accepts the round's shared budget. */
export interface PreparationCollectionOptions {
  /** The round's budget; when omitted the collector creates and owns one. */
  budget?: PreparationBudget
  /** Cancellation signal when no budget is supplied. */
  signal?: AbortSignal
  /** Reports a fallback that actually happened; never called for success/cancel. */
  onDegraded?: (label: string, reason: PreparationDegradation) => void
}

/** The shared preparation window for one round. */
export interface PreparationBudget {
  /**
   * Runs `task` under the next step timer and the round's overall deadline.
   * Once the budget is disposed, exhausted or cancelled, the task is not
   * invoked. A `timeout`/`budget`/`cancelled`/`error` result aborts the step
   * signal before returning.
   */
  run<T>(
    label: string,
    task: (stepSignal: AbortSignal) => Promise<T>,
    limitMs?: number,
  ): Promise<PreparationResult<T>>
  /** Milliseconds left before the overall deadline; 0 once it has passed. */
  remainingMs(): number
  /** Cancels pending steps, aborts owned timers and refuses future work. */
  dispose(): void
}

/** What {@link createPreparationBudget} needs from the host. */
export interface PreparationOptions {
  /** The engine's optional timer port. */
  clock?: EnginePorts['clock']
  /** The round's cancellation signal. */
  signal: AbortSignal
  /** Epoch milliseconds; the caller's clock, so a fake can advance it. */
  now: () => number
  /** Whole window, {@link PREPARATION_TOTAL_MS} by default. */
  totalMs?: number
  /** Usual per-step limit, {@link PREPARATION_STEP_MS} by default. */
  stepMs?: number
}

/** True when `value` can be awaited. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === 'function'
}

/** One in-flight step, settled by the overall timer or cancellation. */
interface PendingStep {
  settle(kind: PreparationFailure): void
}

/**
 * Creates one round's budget. The overall timer starts immediately so the
 * deadline covers the whole preparation, not just the steps that began.
 */
export function createPreparationBudget(options: PreparationOptions): PreparationBudget {
  const totalMs = options.totalMs ?? PREPARATION_TOTAL_MS
  const stepMs = options.stepMs ?? PREPARATION_STEP_MS
  const deadline = options.now() + Math.max(0, totalMs)
  const signal = options.signal
  const sleep = options.clock?.sleep

  const pending = new Set<PendingStep>()
  const overallTimer = new AbortController()
  let disposed = false
  let expired = false
  let timerFailure: PreparationFailure | null = null

  function settlePending(kind: PreparationFailure): void {
    for (const step of [...pending]) step.settle(kind)
  }

  function onAbort(): void {
    if (disposed) return
    expired = true
    // The budget is cancelled for good; the signal has no further work to stop.
    signal.removeEventListener('abort', onAbort)
    settlePending('cancelled')
  }

  signal.addEventListener('abort', onAbort)
  if (signal.aborted) onAbort()

  // The overall timer is owned here: a failure to start it is a fail-closed
  // state, never a licence to run optional work unbounded.
  if (sleep === undefined) {
    timerFailure = 'unavailable'
  } else if (!disposed && !signal.aborted) {
    let timer: unknown
    try {
      timer = sleep(Math.max(0, totalMs), { signal: overallTimer.signal })
    } catch {
      timerFailure = 'error'
    }
    if (timerFailure === null) {
      if (!isThenable(timer)) {
        timerFailure = 'error'
      } else {
        Promise.resolve(timer).then(
          () => {
            if (disposed || signal.aborted) return
            expired = true
            settlePending('budget')
          },
          () => {
            if (disposed || signal.aborted) return
            timerFailure = 'error'
            settlePending('error')
          },
        )
      }
    }
  }

  function remainingMs(): number {
    if (expired || disposed || signal.aborted) return 0
    return Math.max(0, deadline - options.now())
  }

  function run<T>(
    _label: string,
    task: (stepSignal: AbortSignal) => Promise<T>,
    limitMs: number = stepMs,
  ): Promise<PreparationResult<T>> {
    // No new work starts once the round ended or the budget is unusable.
    if (disposed || signal.aborted) return Promise.resolve({ kind: 'cancelled' })
    if (expired) return Promise.resolve({ kind: 'budget' })
    if (timerFailure !== null) return Promise.resolve({ kind: timerFailure })
    if (remainingMs() <= 0 || sleep === undefined) {
      expired = true
      return Promise.resolve({ kind: 'budget' })
    }

    return new Promise<PreparationResult<T>>(resolve => {
      const stepTimer = new AbortController()
      const stepSignal = new AbortController()
      let settled = false

      const settle = (kind: PreparationFailure): void => {
        if (settled) return
        settled = true
        pending.delete(step)
        try {
          stepSignal.abort()
        } catch {
          // A refusing listener must not keep the wrapper from settling.
        }
        try {
          stepTimer.abort()
        } catch {
          // The timer is already done or the host refused; nothing is awaited.
        }
        resolve({ kind } as PreparationResult<T>)
      }

      const succeed = (value: T): void => {
        if (settled) return
        settled = true
        pending.delete(step)
        try {
          stepTimer.abort()
        } catch {
          // As above: late timer settlements are absorbed by the guard.
        }
        resolve({ kind: 'ok', value })
      }

      const step: PendingStep = { settle }
      pending.add(step)

      // Per-step limit is capped by what the round has left, so a later step
      // can never extend the overall window.
      const limit = Math.max(0, Math.min(limitMs, remainingMs()))
      if (limit <= 0) {
        settle('budget')
        return
      }

      let timer: unknown
      try {
        timer = sleep(limit, { signal: stepTimer.signal })
      } catch {
        settle('error')
        return
      }
      if (!isThenable(timer)) {
        settle('error')
        return
      }
      Promise.resolve(timer).then(
        () => settle('timeout'),
        () => settle('error'),
      )

      let answer: Promise<T>
      try {
        answer = task(stepSignal.signal)
      } catch {
        settle('error')
        return
      }
      Promise.resolve(answer).then(
        value => succeed(value),
        () => settle('error'),
      )
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    signal.removeEventListener('abort', onAbort)
    settlePending('cancelled')
    try {
      overallTimer.abort()
    } catch {
      // A refused timer cleanup must not surface to the round's finally.
    }
  }

  return { run, remainingMs, dispose }
}

/**
 * Creates and owns a budget for a standalone helper call. The caller disposes
 * it once the collection settles; a step that ignores cancellation still
 * cannot keep the calling round alive.
 */
export function createLocalPreparation(
  options: Omit<PreparationOptions, 'signal'> & { signal?: AbortSignal },
): PreparationBudget {
  return createPreparationBudget({
    ...options,
    signal: options.signal ?? new AbortController().signal,
  })
}
