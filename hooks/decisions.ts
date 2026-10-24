/**
 * Deterministic user-decision evidence (#26).
 *
 * Every user-authored answer is kept verbatim, together with the exact
 * question and choices that were on screen when it arrived. Nothing here asks
 * a model what the person meant: an answer resolves to a choice only through
 * an exact option match or a bare number (`1`..`4`, optionally `1번`) that
 * names an offered choice. Supersession is recorded only when the person
 * explicitly targets an earlier decision.
 *
 * The helpers are pure and return new objects; a ledger entry or its source
 * arrays are never mutated after they are recorded.
 */
import type {
  AnswerSource,
  DecisionLedger,
  UserDecision,
  Workflow,
} from './contracts'

/** Prefix of every decision id (`d1`, `d2`, …). */
const DECISION_PREFIX = 'd'

/** Prefix of every minted question id. */
const QUESTION_PREFIX = 'q'

/** A ledger with no entries; safe to reuse as an empty default. */
export function emptyLedger(): DecisionLedger {
  return { entries: [], nextId: 1 }
}

/**
 * The workflow's ledger, or an empty one for a fixture/test workflow that
 * predates decisions. Real workflows initialize their ledger at `start`.
 */
export function ledgerOf(workflow: Readonly<Workflow> | null | undefined): DecisionLedger {
  return workflow?.decisions ?? emptyLedger()
}

/** The id an entry with this sequence number gets. */
export function decisionIdFor(sequence: number): string {
  return `${DECISION_PREFIX}${sequence}`
}

/**
 * The fresh id for one successful reply's question. Derived from the workflow,
 * its generation epoch and the attempt number, so two replies never share it.
 */
export function questionIdFor(workflowId: string, generation: number, attempt: number): string {
  return `${QUESTION_PREFIX}:${workflowId}:${generation}:${attempt}`
}

/**
 * The choice an answer resolves to, or `undefined` when it is not an exact
 * option or a bare offered number. "the former", "1, 2", an out-of-range index
 * and every other phrase stay unresolved (the raw text is still retained).
 */
export function resolveOption(
  text: string,
  options: readonly string[],
): { index: number; text: string } | undefined {
  const answer = text.trim()
  if (answer === '') return undefined
  const exact = options.indexOf(answer)
  if (exact !== -1) return { index: exact + 1, text: options[exact] as string }
  const match = /^([1-4])(?:번)?$/.exec(answer)
  if (match === null) return undefined
  const index = Number(match[1])
  if (index < 1 || index > options.length) return undefined
  return { index, text: options[index - 1] as string }
}

/**
 * Appends one user answer, minting the next id. The source is stored as given
 * (its arrays are assumed immutable) and the raw text is never rewritten.
 */
export function appendAnswer(
  ledger: Readonly<DecisionLedger>,
  text: string,
  source: AnswerSource,
): { ledger: DecisionLedger; decision: UserDecision } {
  const id = decisionIdFor(ledger.nextId)
  const selectedOption = resolveOption(text, source.options)
  const decision: UserDecision = {
    id,
    text,
    source,
    ...(selectedOption === undefined ? {} : { selectedOption }),
  }
  return { ledger: { entries: [...ledger.entries, decision], nextId: ledger.nextId + 1 }, decision }
}

/** Maps a replaced decision id to the id that replaced it. */
export function supersededBy(ledger: Readonly<DecisionLedger>): ReadonlyMap<string, string> {
  const replaced = new Map<string, string>()
  for (const entry of ledger.entries) {
    if (entry.supersedes !== undefined && !replaced.has(entry.supersedes)) {
      replaced.set(entry.supersedes, entry.id)
    }
  }
  return replaced
}

/** Every entry not replaced by another entry in the current ledger. */
export function activeDecisions(ledger: Readonly<DecisionLedger>): readonly UserDecision[] {
  const replaced = supersededBy(ledger)
  return ledger.entries.filter(entry => !replaced.has(entry.id))
}

/** The entry with this id, whether or not it is still active. */
export function findDecision(ledger: Readonly<DecisionLedger>, id: string): UserDecision | undefined {
  return ledger.entries.find(entry => entry.id === id)
}

/** Whether `id` exists and has not been replaced. */
export function isActiveDecision(ledger: Readonly<DecisionLedger>, id: string): boolean {
  return findDecision(ledger, id) !== undefined && !supersededBy(ledger).has(id)
}

/**
 * Whether the newest explicit correction has not been applied to a draft yet:
 * its user turn exists in the dialogue but no optimizer turn follows it. A
 * correction clears the answered question, so the usual "unresolved question"
 * test cannot decide whether another round would still change the draft.
 */
export function hasPendingCorrection(workflow: Readonly<Workflow> | null | undefined): boolean {
  if (workflow === null || workflow === undefined) return false
  // The reducer records the ledger-vs-last-successful-reply relation directly:
  // an empty optimizer turn adds no dialogue entry, so the fallback below could
  // not see that the correction was already applied.
  if (workflow.correctionPending !== undefined) return workflow.correctionPending
  if (workflow.decisions === undefined) return false
  const correctionIds = new Set(
    workflow.decisions.entries
      .filter(entry => entry.supersedes !== undefined)
      .map(entry => entry.id),
  )
  if (correctionIds.size === 0) return false
  const lastCorrection = workflow.dialogue.findLastIndex(
    message => message.decisionId !== undefined && correctionIds.has(message.decisionId),
  )
  if (lastCorrection === -1) return false
  return !workflow.dialogue.slice(lastCorrection + 1).some(message => message.role === 'optimizer')
}

/**
 * Appends an explicit correction of one active decision. The new entry keeps
 * the replaced decision's exact source and names it in `supersedes`; the old
 * entry stays in the ledger as inspectable history.
 */
export function appendCorrection(
  ledger: Readonly<DecisionLedger>,
  target: UserDecision,
  text: string,
): { ledger: DecisionLedger; decision: UserDecision } {
  const decision: UserDecision = {
    id: decisionIdFor(ledger.nextId),
    text,
    source: target.source,
    supersedes: target.id,
  }
  return { ledger: { entries: [...ledger.entries, decision], nextId: ledger.nextId + 1 }, decision }
}
