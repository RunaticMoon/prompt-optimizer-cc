/**
 * Delivery: the two ways a finished draft leaves the optimizer.
 *
 * `transferDraft` hands an approved draft back to the person's prompt box
 * without overwriting text they typed themselves, and issues a one-shot bypass
 * permit only when the fill actually landed (`docs/DESIGN.md`, ③ 제출·대기 방식).
 * `sendApproved` submits the approved text explicitly, exactly once, with the
 * engine's own `origin`.
 *
 * Neither function touches the reducer: each returns an outcome for the caller
 * to fold into state, and neither retries a submit.
 */

import type { EngineInterface, PromptFilled, PromptSubmitResult } from 'claude-code'

import type {
  BypassTicket,
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
   * Draft the caller believes the box holds. Text that trims equal is treated
   * as the optimizer's own and may be replaced; absent, only the target text
   * is allowed to match.
   */
  expectedDraft?: string
  /** Pane holding the dialogue, closed before the fill. */
  paneId?: string
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
 *
 * @param $ the engine
 * @param target where the text goes and how it lands
 * @param opts restore options: `now`, the expected draft, and an optional pane
 * @returns `filled` with the bypass permit, or `refused` with the reason
 */
export async function transferDraft(
  $: EngineInterface,
  target: TransferTarget,
  opts: TransferOptions,
): Promise<TransferResult> {
  // 1. Close the pane holding the dialogue first, when one is open. A pane
  //    that is already gone (or a close that fails) must not stop the restore.
  if (opts.paneId !== undefined) {
    try {
      await $.ui.close({ id: opts.paneId })
    } catch {
      // Swallow and continue: the pane may already be closed.
    }
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
    if (!canReplace(current, opts.expectedDraft, target.text)) {
      return { kind: 'refused', reason: 'draft-conflict' }
    }
  }

  // 3. Place the text in the box.
  let filled: PromptFilled
  try {
    filled = await $.prompt.fill({ text: target.text, mode: target.mode })
  } catch {
    return { kind: 'refused', reason: 'unknown' }
  }
  if (!filled.isFilled) {
    return { kind: 'refused', reason: refusalToTransfer(filled.refusal) }
  }

  // 4. A permit is issued only for a fill that actually landed, over the text
  //    the box now holds (`append`/`insert` keep what was already there).
  let text = target.text
  if (target.mode !== 'replace') {
    try {
      text = (await $.prompt.read()).text
    } catch {
      // The fill landed but the box cannot be re-read; the fill's own view is
      // the best available record of the final text.
      text = filled.text
    }
  }
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
 * The engine stamps the origin as this plugin; it is never forged. A prompt
 * sent this way carries no `context`: `PromptSubmitArgs` omits `context`, so
 * `target.context` cannot ride along and the caller must report that.
 *
 * @param $ the engine
 * @param target the text to submit
 * @returns `sent`, `dropped` with the engine's reason, or `failed` with a message
 */
export async function sendApproved($: EngineInterface, target: SubmitTarget): Promise<SendResult> {
  let result: PromptSubmitResult
  try {
    // Exactly one call. No retry on a drop, a failure, or a timeout.
    result = await $.prompt.submit({ text: target.text })
  } catch (error) {
    return { kind: 'failed', message: messageOf(error) }
  }
  if (result.drop !== undefined) return { kind: 'dropped', reason: result.drop }
  return { kind: 'sent', text: result.text }
}

/**
 * Whether the box's current text may be replaced without losing the person's
 * own work. Empty, the expected draft, and the target text all clear the check.
 */
function canReplace(current: string, expectedDraft: string | undefined, target: string): boolean {
  const trimmed = current.trim()
  if (trimmed === '') return true
  if (expectedDraft !== undefined && trimmed === expectedDraft.trim()) return true
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
