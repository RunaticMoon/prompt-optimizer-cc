/**
 * Submission classifier: decides what one `prompt.submit` means for the
 * optimizer. Pure and synchronous: it reads `config` and `state` and returns a
 * decision, mutating neither, so a caller can inspect the result before it acts
 * (opening a pane, reserving a workflow, consuming a bypass ticket).
 *
 * The order below is fixed by the design (`docs/DESIGN.md`, ① 가로채기 트리거,
 * ③ 제출·대기 방식). The first matching rule wins.
 */

import type { PromptSubmitInput } from 'claude-code'

import { MAX_ORIGINAL_CHARS } from './contracts'
import type {
  OptimizerConfig,
  PassReason,
  RuntimeState,
  SubmissionDecision,
  SubmissionFacts,
} from './contracts'

/**
 * Classifies one submission.
 *
 * @param e the engine's `prompt.submit` input
 * @param config resolved user settings
 * @param state the session's current optimizer state
 * @param now epoch milliseconds, for bypass expiry
 * @param facts what the plugin saw build this draft, when it kept a tracker
 * @returns what the caller should do with this submission
 */
export function classifySubmission(
  e: PromptSubmitInput,
  config: OptimizerConfig,
  state: Readonly<RuntimeState>,
  now: number,
  facts?: SubmissionFacts,
): SubmissionDecision {
  // 1. Only the user's own terminal Enter is a candidate.
  if (e.origin.kind !== 'composer') return pass('not-composer')

  // 2. A prompt typed over a running turn, or one asked to wait its turn, is
  //    left to the engine's own queue: a queued submission is delivered
  //    untouched, never intercepted.
  if (e.turnId !== undefined) return pass('mid-turn')
  if (e.wait === true) return pass('queued')

  // 3. Non-text items cannot be reconstructed after a drop, so they pass.
  if (e.attachments !== undefined && e.attachments.length > 0) return pass('attachments')

  // 4. Nothing to improve.
  if (e.text.trim() === '') return pass('empty')

  // 5. The optimizer-off mode the person armed in the composer: the prompt goes
  //    to the main session exactly as typed. No text comparison here: a paste
  //    placeholder may already have expanded, so the submission need not equal
  //    the remembered draft.
  if (state.rawMode !== null && state.rawMode.sessionId === state.sessionId) {
    return { kind: 'raw', text: e.text }
  }

  // 6. A live bypass permit releases exactly its own draft, once. The CLI
  //    trims a composer submission (and the Enter can reach the box as an edit
  //    first), so the draft is compared as submitted, not byte for byte.
  const ticket = state.bypass
  if (
    ticket !== null &&
    ticket.sessionId === state.sessionId &&
    now < ticket.expiresAt &&
    sameSubmittedText(e.text, ticket.text)
  ) {
    return { kind: 'bypass', text: e.text, ticket }
  }

  // 7. Commands and shell input belong to the engine, even while a dialogue
  //    is active (`/optimize accept`, `/optimize cancel`, ...). Defensive: the
  //    engine likely handled them before this hook ran.
  if (e.text.startsWith('/')) return pass('slash-command')
  if (e.text.startsWith('!')) return pass('shell')

  // 8. While a workflow is active, the composer can only be answering it.
  const workflow = state.workflow
  if (workflow !== null) {
    if (
      workflow.ui === 'composer' &&
      (workflow.phase === 'reviewing' || workflow.phase === 'failed')
    ) {
      return { kind: 'reply', workflowId: workflow.id, text: e.text }
    }
    // In progress (collecting/generating/transferring/sending) or held by the
    // pane: the design allows one workflow per session. The caller drops this
    // submission rather than let a second one reach the main session.
    return { kind: 'busy', workflowId: workflow.id }
  }

  // 8b. A refined draft this plugin already delivered is never optimized
  //     again, even once its one-shot permit is spent, edited or expired.
  //     An active dialogue (8) still owns the composer first.
  if (facts?.delivered === true) return pass('already-optimized')

  // 9. The optimizer is off. The raw mode (5) and an active reply (8) above
  //    still win.
  if (config.enabled === false) return pass('disabled')

  // 10. Originals too long to improve are left alone.
  if (e.text.length > MAX_ORIGINAL_CHARS) return pass('over-limit')

  // 11. Prefix mode improves only what carries the trigger.
  if (config.triggerMode === 'prefix') {
    return triggerDecision(e.text, config.triggerPrefix) ?? pass('no-trigger')
  }

  // 12. The opt-in smart mode: the explicit trigger prefix first (above paste
  //     and matching), then the conservative whole-input approvals, then the
  //     ordinary paste and optimize rules. Uncertain text still optimizes, so
  //     a wrong guess can only cost a completion, never drop a requirement.
  if (config.triggerMode === 'smart') {
    const triggered = triggerDecision(e.text, config.triggerPrefix)
    if (triggered !== null) return triggered
    if (config.pasteBypass && facts?.pasted === true) return pass('pasted')
    if (isSmartContinuation(e.text)) return pass('smart-continuation')
    return { kind: 'optimize', text: e.text, trigger: 'auto' }
  }

  // 13. A draft the person never typed — only pasted, or put in by another app
  //     such as Orca — is not their own prompt, so it goes to the main session
  //     as-is. The reply (8), raw (5), bypass (6), prefix (11) and smart
  //     explicit-trigger (12) rules above still win.
  if (config.pasteBypass && facts?.pasted === true) return pass('pasted')

  // 14. `always` mode improves everything left, on the text as typed.
  return { kind: 'optimize', text: e.text, trigger: 'auto' }
}

/**
 * A submission's text as the composer sends it: line endings unified and the
 * surrounding whitespace trimmed, the way the CLI trims a composer submission.
 */
export function submittedForm(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** Whether two texts are the same submission once the composer has sent them. */
export function sameSubmittedText(a: string, b: string): boolean {
  return submittedForm(a) === submittedForm(b)
}

/**
 * The existing prefix behavior, shared by `prefix` and `smart` modes: a
 * nonempty prefix recognized exactly at the text's head, the remainder trimmed,
 * and only the trigger (or the CLI-trimmed bare trigger) returned as a blank
 * raw escape. `null` when this text carries no trigger.
 */
function triggerDecision(text: string, prefix: string): SubmissionDecision | null {
  if (prefix !== '' && text.startsWith(prefix)) {
    const rest = text.slice(prefix.length).trim()
    // Only the trigger was typed: nothing to improve. Return a blank raw
    // escape so the controller drops it (보낼 내용이 없습니다.) rather than
    // letting the bare prefix reach the main session.
    if (rest === '') return { kind: 'raw', text: '' }
    return { kind: 'optimize', text: rest, trigger: 'prefix' }
  }
  // The CLI trims trailing whitespace before the hook sees the text, so the
  // bare trigger arrives without its trailing space. Recognize it as empty
  // input, not as untriggered text.
  const bareTrigger = prefix.trimEnd()
  if (bareTrigger !== '' && text.trimEnd() === bareTrigger) return { kind: 'raw', text: '' }
  return null
}

/**
 * The exact whole-input approvals smart mode passes through untouched
 * (`smart-continuation`). Deliberately tiny and conservative: any variant needs
 * its own reviewed fixtures first, since one wrong entry lets consequential
 * text slip past the optimizer.
 */
const SMART_CONTINUATIONS: ReadonlySet<string> = new Set(['응', '계속', '진행해'])

/** Whether the whole trimmed input is exactly one of the smart-mode approvals. */
function isSmartContinuation(text: string): boolean {
  return SMART_CONTINUATIONS.has(text.trim())
}

/** A pass decision, by reason. */
function pass(reason: PassReason): SubmissionDecision {
  return { kind: 'pass', reason }
}
