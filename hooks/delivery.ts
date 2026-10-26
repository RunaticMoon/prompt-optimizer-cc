/**
 * Delivery: the two ways a finished draft leaves the optimizer.
 *
 * `transferDraft` hands an approved draft back to the person's prompt box
 * without overwriting text they typed themselves, and issues a one-shot bypass
 * permit only when the fill actually landed (`docs/DESIGN.md`, ③ 제출·대기 방식).
 * `sendApproved` submits the approved text explicitly, exactly once, under the
 * engine's own `origin` (never forged). It passes `asUser: true`, so the model
 * reads the text bare as the person's own words, without the engine's
 * "The <plugin> plugin sent a message" frame.
 *
 * Neither function touches the reducer: each returns an outcome for the caller
 * to fold into state, and neither retries a submit.
 */

import type { PromptFilled, PromptSubmitResult } from 'claude-code'

import type {
  BypassTicket,
  EnginePorts,
  RestoreGuard,
  SubmitTarget,
  TransferRefusal,
  TransferResult,
  TransferTarget,
} from './contracts'

/** How long a restored draft may bypass interception before it is void. */
export const BYPASS_TTL_MS = 10 * 60 * 1000

/** Options for one restore. */
export interface TransferOptions {
  /** Epoch milliseconds stamped on the issued permit's expiry. */
  now: number
  /**
   * Draft, or equivalent draft forms, the caller believes the box holds. Text
   * that trims equal to any candidate is treated as the optimizer's own and
   * may be replaced; absent, only the target text is allowed to match.
   */
  expectedDraft?: string | readonly string[]
  /** Pane holding the dialogue, closed before the fill. */
  paneId?: string
  /**
   * Best-effort ownership/observed-edit guard. When supplied, every async
   * boundary re-checks it and a changed box stops the restore before (or, for
   * a change during the fill, right after) the dispatch; the host exposes no
   * compare-and-set, so a change not yet observed can still land. Absent, the
   * helper keeps its original read/fill behavior for standalone callers.
   */
  guard?: RestoreGuard
}

/** The outcome of an explicit send. */
export type SendResult =
  | { kind: 'sent'; text: string }
  | { kind: 'dropped'; reason: string }
  | { kind: 'failed'; message: string }

/**
 * Restores an approved draft into the prompt box.
 *
 * Order (fixed by the design): close the pane, refuse to overwrite a fresh
 * draft the person typed, fill, and issue a permit only for a fill that landed.
 * With a {@link RestoreGuard}, the same boundaries also re-check ownership and
 * observed edits: a change before the fill stops it, a change during it is
 * reported as a conflict (never repaired with a second fill).
 *
 * @param $ the engine
 * @param target where the text goes and how it lands
 * @param opts restore options: `now`, the expected draft, an optional pane and guard
 * @returns `filled` with the bypass permit, or `refused` with the reason
 */
export async function transferDraft(
  $: EnginePorts,
  target: TransferTarget,
  opts: TransferOptions,
): Promise<TransferResult> {
  const guard = opts.guard

  // A restore that is already obsolete, or whose box changed before this call,
  // does no work at all: no pane close, no read, no fill.
  const entered = guardRefusal(guard)
  if (entered !== null) return entered

  // 1. Close the pane holding the dialogue first, when one is open. A pane
  //    that is already gone (or a close that fails) must not stop the restore.
  if (opts.paneId !== undefined) {
    try {
      await $.ui.close({ id: opts.paneId })
    } catch {
      // Swallow and continue: the pane may already be closed.
    }
    const closed = guardRefusal(guard)
    if (closed !== null) return closed
  }

  // 2. Never overwrite text the person typed themselves. `append` and `insert`
  //    only add to the box, so the draft stays and the conflict check is moot.
  if (target.mode === 'replace') {
    let current: string
    try {
      current = (await $.prompt.read()).text
    } catch {
      // The box could not be read, so it cannot be safely replaced.
      return { kind: 'refused', reason: 'unknown' }
    }
    // The read's snapshot is already old once an edit was observed while it
    // was pending: a changed revision refuses even if the text is unchanged
    // (a person could have typed and undone it, ABA).
    const read = guardRefusal(guard)
    if (read !== null) return read
    if (!canReplace(current, opts.expectedDraft, target.text)) {
      return { kind: 'refused', reason: 'draft-conflict' }
    }
  }

  // 3. Place the text in the box. The final synchronous check leaves no await
  //    between it and the dispatch; a change during the fill is caught below.
  const dispatched = guardRefusal(guard)
  if (dispatched !== null) return dispatched
  let filled: PromptFilled
  try {
    filled = await $.prompt.fill({ text: target.text, mode: target.mode })
  } catch {
    // An obsolete call reports the stronger cause; otherwise nothing landed.
    const after = guardRefusal(guard)
    return after !== null && after.kind === 'refused' && (after.reason === 'stale-owner' || after.reason === 'submitted')
      ? after
      : { kind: 'refused', reason: 'unknown' }
  }

  if (!filled.isFilled) {
    // A refusal keeps the engine's own cause, unless the caller no longer owns
    // the box at all (then the outcome is moot).
    const after = guardRefusal(guard)
    if (after !== null && after.kind === 'refused' && (after.reason === 'stale-owner' || after.reason === 'submitted')) {
      return after
    }
    return { kind: 'refused', reason: refusalToTransfer(filled.refusal) }
  }

  // A conflict here may already have overwritten the person's text: the host
  // offers no conditional fill. Do not fill again; report it with the observed
  // recovery text so the caller can publish it.
  const landed = guardRefusal(guard)
  if (landed !== null) return landed

  // 4. A permit is issued only for a fill that actually landed, over the text
  //    the box now holds (`append`/`insert` keep what was already there). The
  //    fill's own view comes first, for `replace` too: the engine drops the
  //    code points a terminal cannot draw (zero-width and the like) when it
  //    fills and again when the composer sends, so `target.text` may not be
  //    what a later submission carries. A box that cannot be read falls back
  //    to the text the caller asked for.
  let text = filled.text
  if (text === '') {
    try {
      text = (await $.prompt.read()).text
    } catch {
      // The fill landed but the box cannot be re-read; the requested text is
      // the last available record of what the caller meant to place.
      text = ''
    }
    // The fallback read must not outrun the guard: a box observed as changed
    // during it means the restored text is no longer the box's content.
    const reread = guardRefusal(guard)
    if (reread !== null) return reread
  }
  if (text === '') text = target.text
  const ticket: BypassTicket = {
    sessionId: target.sessionId,
    workflowId: target.workflowId,
    text,
    expiresAt: opts.now + BYPASS_TTL_MS,
  }
  return { kind: 'filled', text, ticket }
}

/**
 * Submits an approved draft explicitly, exactly once.
 *
 * The engine stamps the origin as this plugin; it is never forged. The submit
 * passes `asUser: true`, so the model reads the text bare as the person's own
 * words instead of the engine's "The <plugin> plugin sent a message" frame; the
 * origin every hook sees still names the plugin. A prompt sent this way carries
 * no `context`: `PromptSubmitArgs` omits `context`, so `target.context` cannot
 * ride along and the caller must report that.
 *
 * @param $ the engine
 * @param target the text to submit
 * @returns `sent`, `dropped` with the engine's reason, or `failed` with a message
 */
export async function sendApproved($: EnginePorts, target: SubmitTarget): Promise<SendResult> {
  let result: PromptSubmitResult
  try {
    // Exactly one call. No retry on a drop, a failure, or a timeout.
    result = await $.prompt.submit({ text: target.text, asUser: true })
  } catch (error) {
    return { kind: 'failed', message: messageOf(error) }
  }
  if (result.drop !== undefined) return { kind: 'dropped', reason: result.drop }
  return { kind: 'sent', text: result.text }
}

/**
 * The refusal for a guard that is no longer current, or `null` when it still
 * is (or no guard was supplied). Stale ownership outranks the person's own
 * submit of the restored text, which outranks an observed edit.
 */
function guardRefusal(guard: RestoreGuard | undefined): TransferResult | null {
  if (guard === undefined) return null
  const verdict = guard.check()
  if (verdict === 'current') return null
  if (verdict === 'stale') return { kind: 'refused', reason: 'stale-owner' }
  if (verdict === 'submitted') return { kind: 'refused', reason: 'submitted' }
  const recoveryText = guard.recoveryText()
  return recoveryText === undefined
    ? { kind: 'refused', reason: 'draft-conflict' }
    : { kind: 'refused', reason: 'draft-conflict', recoveryText }
}

/**
 * Whether the box's current text may be replaced without losing the person's
 * own work. Empty, the expected draft, and the target text all clear the check.
 */
function canReplace(current: string, expectedDraft: TransferOptions['expectedDraft'], target: string): boolean {
  const trimmed = current.trim()
  if (trimmed === '') return true
  const candidates = typeof expectedDraft === 'string' ? [expectedDraft] : expectedDraft ?? []
  if (candidates.some(candidate => trimmed === candidate.trim())) return true
  return trimmed === target.trim()
}

/** Maps a fill's refusal cause onto the transfer refusal vocabulary. */
function refusalToTransfer(refusal: PromptFilled['refusal']): TransferRefusal {
  if (refusal === 'no_composer') return 'no_composer'
  if (refusal === 'dialog') return 'dialog'
  // An absent cause is a hook's own refusal; anything else is unrecognised.
  if (refusal === undefined) return 'hook-refused'
  return 'unknown'
}

/** A thrown value's message, for a failed send. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
