/**
 * One round's target-model lookup (DESIGN-model-guidance §6.1 step 4, §6.4).
 *
 * `resolveTargetModel` reads the main session's model through the optional
 * `session.model` port and races the returned promise against
 * `clock.sleep(TARGET_MODEL_TIMEOUT_MS, { signal })` so a slow or broken
 * getter never blocks the optimizer. Ordinary detection failures (timeout,
 * rejection, synchronous throw, empty value, missing port) degrade to the
 * common profile instead of throwing.
 *
 * The function always resolves and never rejects: the optimizer may proceed
 * with common guidance whatever the engine reports. It owns the timer's
 * `AbortController`, removes its listener from the caller's signal on every
 * exit, and absorbs every late getter or timer settlement so no unhandled
 * rejection is left behind. Nothing is cached between calls; each round reads
 * the model afresh. It touches no `$` and performs no I/O.
 */

import type {
  EnginePorts,
  ModelResolutionReason,
  TargetModelSnapshot,
} from './contracts'
import { TARGET_MODEL_TIMEOUT_MS } from './contracts'
import { normalizeTargetModel } from './target-model'

/** The shared-profile snapshot every non-`matched` reason falls back to. */
function common(reason: ModelResolutionReason): TargetModelSnapshot {
  return { raw: null, normalizedId: null, profile: 'common', reason }
}

/**
 * True when `value` can be awaited. A `sleep` that returns anything else has
 * not really started a timer; awaiting it with `value.then` would instead throw
 * synchronously and reject the outer promise, breaking the "always resolve"
 * contract.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Resolves the target model for one optimizer round.
 *
 * @param ports the session and (optional) timer ports; only `session.model`
 *   and `clock.sleep` are read
 * @param enabled the `modelGuidance` toggle; false skips every call
 * @param signal the round's cancellation signal
 * @returns a snapshot that always names a profile; failures use `common`
 */
export function resolveTargetModel(
  ports: Pick<EnginePorts, 'session' | 'clock'>,
  enabled: boolean,
  signal: AbortSignal,
): Promise<TargetModelSnapshot> {
  // 1. Off: neither the getter nor the timer is touched.
  if (!enabled) {
    return Promise.resolve(common('disabled'))
  }

  // 2. Already cancelled: report the cancellation without any call.
  if (signal.aborted) {
    return Promise.resolve(common('cancelled'))
  }

  // 3. A missing getter cannot be awaited; a missing timer would wait forever.
  //    Both are `unavailable`, and the getter is not called when the timer is
  //    absent.
  const getter = ports.session.model
  if (getter === undefined) {
    return Promise.resolve(common('unavailable'))
  }
  const sleep = ports.clock?.sleep
  if (sleep === undefined) {
    return Promise.resolve(common('unavailable'))
  }

  return new Promise<TargetModelSnapshot>((resolve) => {
    // The resolver owns this controller so it can end the sleep on any exit.
    const timerController = new AbortController()
    let settled = false

    function finish(snapshot: TargetModelSnapshot): void {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onExternalAbort)
      timerController.abort()
      resolve(snapshot)
    }

    function onExternalAbort(): void {
      finish(common('cancelled'))
    }

    // The caller may abort before or during the race; either way we report
    // cancellation and never let the optimizer send with a stale profile.
    signal.addEventListener('abort', onExternalAbort)
    if (signal.aborted) {
      finish(common('cancelled'))
      return
    }

    // 4. Start the timer. A synchronous throw is an `error`, not a hang.
    let timer: unknown
    try {
      timer = sleep(TARGET_MODEL_TIMEOUT_MS, { signal: timerController.signal })
    } catch {
      finish(common('error'))
      return
    }
    // Resolution is the elapsed 500 ms; a late rejection (our own abort once
    // another branch has settled, or a host failure) is absorbed here. The
    // `isThenable` guard keeps a non-thenable return out of `timer.then`, which
    // would throw synchronously and reject this promise. Such a return means
    // the sleep never started: an `error`, reported after the getter below.
    if (isThenable(timer)) {
      timer.then(
        () => finish(common('timeout')),
        () => finish(common('error')),
      )
    }

    // 5. Read the model. A synchronous throw is an `error`.
    let answer: Promise<unknown>
    try {
      answer = getter()
    } catch {
      finish(common('error'))
      return
    }
    Promise.resolve(answer).then(
      raw => finish(normalizeTargetModel(raw)),
      () => finish(common('error')),
    )

    // A timer that could not be awaited cannot bound the wait. Report it now
    // that the getter's reaction is queued, so an already-ready getter keeps
    // priority while a pending getter still ends in `common/error` rather than
    // hanging forever.
    if (!isThenable(timer)) {
      Promise.resolve().then(() => finish(common('error')))
    }
  })
}
