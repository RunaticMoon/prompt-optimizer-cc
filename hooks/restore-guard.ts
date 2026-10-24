/**
 * Private tracker behind one controller's restore guard (#28).
 *
 * The host exposes no conditional fill, so protection is limited to what this
 * plugin actually observed: `prompt.edit` entry/completion, a foreign
 * `prompt.fill` entry/completion, autocomplete display changes and the
 * session/workflow lifecycle. The tracker owns no host call and no timers; the
 * controller asks it for a guard per restore and settles the tokens the hooks
 * hand back.
 *
 * Two counters make the contract narrow and testable:
 *
 * - `epoch` is ownership. It moves on a session start/end, on a replacement
 *   workflow and on every newer restore, so an in-flight restore either keeps
 *   its epoch or is `stale`. It deliberately does not move when a cancel
 *   removes the workflow, because that cancel's own restore runs afterwards.
 * - `revision` is the monotonic observed-state counter. It never resets, so a
 *   small value is never reused after a session change, and a restore refuses
 *   on any change even if the box's text later returns to its old value.
 *
 * A pending token is deliberately not tied to one restore operation: an edit
 * that began before a newer restore is still a real external observation, so
 * settling it invalidates that restore conservatively. Only a session or
 * workflow change clears pending tokens.
 */

import type { BypassTicket, RestoreCheck, RestoreGuard } from './contracts'

/** One restore's guard, plus the tickets whose lineage it owns. */
export interface RestoreOperation extends RestoreGuard {
  /**
   * The provisional permit and every later form edited from it. A late
   * conflict revokes only a permit in this set, so a newer run's ticket is
   * never touched.
   */
  readonly tickets: Set<BypassTicket>
}

/** What settling one observation token produced. */
export interface SettleResult {
  /** False for a token cleared by a session/workflow change, or already settled. */
  accepted: boolean
  /** Captured text a retained, already-conflicted operation was waiting for. */
  lateText?: string
}

/** The tracker the controller owns; one instance per controller. */
export interface RestoreTracker {
  /** Starts a newer restore, superseding (and staling) any earlier one. */
  begin(): RestoreOperation
  /** Ends an operation if it is still the current one. */
  end(operation: RestoreOperation): void
  /** Drops ownership and observed text: session start/end or a new workflow. */
  invalidate(): void
  /** Notes one `prompt.edit` hook entering; settle it when the hook returns. */
  beginEdit(): number
  /** Notes one foreign `prompt.fill` entering; it invalidates immediately. */
  beginForeignFill(): number
  /**
   * Settles one token. `text` is the exact complete box result when known;
   * `undefined` still invalidates the observed revision but claims no snapshot.
   * A token cleared by `invalidate` (session/workflow change) or settled twice
   * is refused, so its completion changes nothing.
   */
  settle(token: number | undefined, text: string | undefined): SettleResult
  /** Notes one autocomplete display; an unchanged repeat changes nothing. */
  observeDisplay(text: string): void
  /** Extends an active operation's ticket lineage to an edited form. */
  trackTicket(before: BypassTicket, after: BypassTicket | null): void
  /** Whether any observed edit/fill is still in flight. */
  hasPending(): boolean
  /** Keeps the operation alive until its last pending token settles. */
  retain(operation: RestoreOperation): void
}

interface Token {
  kind: 'edit' | 'fill'
}

/** Builds one controller's restore tracker. */
export function createRestoreTracker(): RestoreTracker {
  let epoch = 0
  let revision = 0
  let current: RestoreOperation | null = null
  /** The current operation already refused with a draft conflict. */
  let retained = false
  const pending = new Map<number, Token>()
  let nextToken = 0
  /** The latest complete external box text, with the revision that saw it. */
  let observed: { revision: number; text: string } | null = null
  /** The last autocomplete display, so an identical repeat does not invalidate. */
  let lastDisplay: string | undefined

  function begin(): RestoreOperation {
    epoch += 1
    const capturedEpoch = epoch
    const capturedRevision = revision
    const tickets = new Set<BypassTicket>()
    const operation: RestoreOperation = {
      tickets,
      check(): RestoreCheck {
        // A superseded operation or a newer owner outranks any edit: the caller
        // must not even report a conflict into the new session's UI.
        if (current !== operation || epoch !== capturedEpoch) return 'stale'
        if (pending.size > 0) return 'edited'
        if (revision !== capturedRevision) return 'edited'
        return 'current'
      },
      recoveryText(): string | undefined {
        // Only a complete observation made after this capture can be the
        // text the person typed during it; an older one is not recovery.
        if (observed === null || observed.revision <= capturedRevision) return undefined
        return observed.text
      },
    }
    current = operation
    retained = false
    return operation
  }

  function end(operation: RestoreOperation): void {
    if (current !== operation) return
    current = null
    retained = false
  }

  function invalidate(): void {
    epoch += 1
    pending.clear()
    current = null
    retained = false
    observed = null
    lastDisplay = undefined
  }

  function beginEdit(): number {
    nextToken += 1
    pending.set(nextToken, { kind: 'edit' })
    return nextToken
  }

  function beginForeignFill(): number {
    // A foreign fill invalidates before its `next`, so a restore never fills
    // over a box another plugin is already rewriting.
    revision += 1
    nextToken += 1
    pending.set(nextToken, { kind: 'fill' })
    return nextToken
  }

  function settle(token: number | undefined, text: string | undefined): SettleResult {
    const entry = token === undefined ? undefined : pending.get(token)
    // A token from a previous session (or a duplicate settle) changes nothing,
    // so an old edit's completion can never leak into the new session.
    if (token !== undefined && entry === undefined) return { accepted: false }
    if (token !== undefined) pending.delete(token)
    // An edit's completion is the observation; a foreign fill already bumped
    // its revision on entry, so its completion only attaches the captured box.
    if (entry === undefined || entry.kind === 'edit') revision += 1
    if (text !== undefined) {
      observed = { revision, text }
      lastDisplay = text
    }

    if (current === null || !retained) return { accepted: true }
    // Defined text is always a complete box snapshot: an edit's full result, a
    // whole-box read after a foreign fill, or an untracked caller observation.
    // Fill fragments are passed as `undefined`, so they are never published.
    const late = text
    if (pending.size === 0) end(current)
    return late === undefined ? { accepted: true } : { accepted: true, lateText: late }
  }

  function observeDisplay(text: string): void {
    // The same display repeated is not a new observation. A changed one is a
    // complete box view, so it can invalidate and later serve as recovery.
    if (text === lastDisplay) return
    lastDisplay = text
    revision += 1
    observed = { revision, text }
  }

  function trackTicket(before: BypassTicket, after: BypassTicket | null): void {
    const operation = current
    if (operation === null || after === null) return
    if (!operation.tickets.has(before)) return
    operation.tickets.add(after)
  }

  return {
    begin,
    end,
    invalidate,
    beginEdit,
    beginForeignFill,
    settle,
    observeDisplay,
    trackTicket,
    hasPending: () => pending.size > 0,
    retain(operation) {
      if (current !== operation) return
      retained = true
    },
  }
}
