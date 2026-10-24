/**
 * Bounded in-memory successful-revision history (#31).
 *
 * Every successful reply snapshots the workflow's review state (draft, change
 * note, question, choices, dialogue, decision ledger) so the person can
 * compare revisions and undo to an earlier success. The history lives only in
 * plugin memory: nothing is written to disk, and a failure or budget refusal
 * never creates a snapshot.
 *
 * The helpers are pure. A snapshot copies the arrays it captures and shares
 * the immutable ledger entry objects, so a later workflow update can never
 * mutate an already-recorded revision.
 */
import type { DecisionLedger, DraftRevision, OptimizerMessage, Workflow } from './contracts'

/** Most successful revisions kept on the selected branch, current included. */
export const MAX_REVISIONS = 5

/** The id an appended revision with this sequence number gets. */
export function revisionIdFor(sequence: number): string {
  return `r${sequence}`
}

/** The review state one successful reply leaves behind, ready to snapshot. */
export interface RevisionSnapshot {
  successfulRound: number
  draft: string
  message: string
  question: string | null
  questionId: string | null
  options: readonly string[]
  dialogue: readonly OptimizerMessage[]
  decisions: DecisionLedger
}

/**
 * Appends one successful revision to the workflow's history, minting the next
 * id. Only the newest {@link MAX_REVISIONS} survive on the selected branch;
 * id numbering keeps its high-water mark so ids are never recycled after an
 * undo drops newer revisions.
 */
export function recordRevision(
  workflow: Readonly<Workflow>,
  snapshot: RevisionSnapshot,
): Pick<Workflow, 'revisions' | 'currentRevisionId' | 'nextRevisionId'> {
  const nextId = workflow.nextRevisionId ?? 1
  const revision: DraftRevision = { id: revisionIdFor(nextId), ...snapshot }
  return {
    revisions: [...(workflow.revisions ?? []), revision].slice(-MAX_REVISIONS),
    currentRevisionId: revision.id,
    nextRevisionId: nextId + 1,
  }
}
