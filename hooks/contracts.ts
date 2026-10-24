/**
 * Shared contracts for the prompt-optimizer mod: the types and constants every
 * other module (C-L) imports from. Types and constants only, no runtime logic.
 */

import type { EngineInterface } from 'claude-code'

/** User settings as the manifest `userConfig` declares them, after defaults. */
export interface OptimizerConfig {
  /** Whether the optimizer intercepts eligible submissions at all. */
  enabled: boolean
  /** Whether the main session's model selects model-specific rewrite guidance. */
  modelGuidance: boolean
  /** `always` intercepts every eligible prompt; `prefix` only prefixed ones. */
  triggerMode: TriggerMode
  /** Prefix that starts an optimization when `triggerMode` is `prefix`. */
  triggerPrefix: string
  /** Leading marker stripped before sending the rest of a prompt straight through. */
  rawPrefix: string
  /** Which interface holds the improvement dialogue. */
  uiMode: UiMode
  /** Model alias or id for the optimizer's own completions. */
  model: string
  /** Output cap for one optimizer completion, within {@link MAX_TOKENS_RANGE}. */
  maxTokens: number
  /** Time limit for one optimizer completion, within {@link TIMEOUT_MS_RANGE}. */
  timeoutMs: number
  /** Most completions allowed in one workflow, within {@link MAX_ROUNDS_RANGE}. */
  maxRounds: number
  /** Recent user turns read into the snapshot, within {@link CONTEXT_TURNS_RANGE}. */
  contextTurns: number
  /** Character budget for the snapshot, within {@link CONTEXT_MAX_CHARS_RANGE}. */
  contextMaxChars: number
  /** File with extra system instructions; empty keeps the built-in prompt. */
  systemPromptFile: string
  /**
   * Whether a prompt that was only pasted, or injected by another app, and
   * submitted without typing goes to the main session as-is.
   */
  pasteBypass: boolean
}

/** A key of {@link OptimizerConfig}, as `config.set` reports it. */
export type ConfigKey = keyof OptimizerConfig

/** How a submission qualifies for interception. */
export type TriggerMode = 'always' | 'prefix'

/** Which interface holds the improvement dialogue. */
export type UiMode = 'auto' | 'pane' | 'composer'

/** Lifecycle stage of one optimization workflow. */
export type Phase =
  | 'idle'
  | 'collecting'
  | 'generating'
  | 'reviewing'
  | 'failed'
  | 'transferring'
  | 'sending'

/** Actual work within a round; the model API does not expose streaming tokens. */
export type ProgressStage = 'context' | 'instructions' | 'target-model' | 'generating'

/** Per-round clock for progress rendering, independent of completed token usage. */
export interface WorkflowProgress {
  stage: ProgressStage
  startedAt: number
  updatedAt: number
}

/**
 * Provenance for one user-authored answer: the question and choices that were
 * on screen when the person answered. Captured before `instruct` clears them.
 */
export interface AnswerSource {
  kind: 'user-answer'
  /** Id minted with the question (null when the answer had no question). */
  questionId: string | null
  /** The question exactly as the model returned it, or null. */
  question: string | null
  /** The answer choices exactly as offered, empty when there were none. */
  options: readonly string[]
  /** Round count at the time (a failed attempt is still recorded as a round). */
  answeredAfterRound: number
}

/** One user-authored decision, kept verbatim with its source. */
export interface UserDecision {
  /** Workflow-local id (`d1`, `d2`, …); never reused. */
  id: string
  /** The exact user text after the existing input normalization. */
  text: string
  source: AnswerSource
  /** The choice the answer resolved to, when it matched an option exactly. */
  selectedOption?: { index: number; text: string }
  /** Earlier decision this entry explicitly replaced. */
  supersedes?: string
}

/** Every decision a workflow has recorded, including replaced history. */
export interface DecisionLedger {
  entries: readonly UserDecision[]
  /** Next id number to mint; a high-water mark, never reused. */
  nextId: number
}

/**
 * One successful reply, kept in memory so the person can compare against it
 * and undo to it (#31). Snapshot fields are the workflow state exactly as the
 * successful reply left it; `context`/`original` stay workflow-constant and
 * are not copied per revision.
 */
export interface DraftRevision {
  /** Workflow-local id (`r1`, `r2`, …); never reused, even after undo. */
  id: string
  /** The workflow's round counter at the moment this success was recorded. */
  successfulRound: number
  /** The draft exactly as this reply delivered it. */
  draft: string
  /** The reply's change note. */
  message: string
  /** The reply's clarifying question as offered then, or null. */
  question: string | null
  /** The question id minted with that question, or null. */
  questionId: string | null
  /** The answer choices offered with that question. */
  options: readonly string[]
  /** The improvement dialogue as it stood after this reply. */
  dialogue: readonly OptimizerMessage[]
  /** The decision ledger as it stood after this reply. */
  decisions: DecisionLedger
}

/** One optimization run over one original prompt. */
export interface Workflow {
  /** Stable id for this run, unique per session. */
  id: string
  /** Session the run belongs to. */
  sessionId: string
  /**
   * Monotonic state epoch for this run. Unique workflow ids already make a
   * late result from another run stale; undo also bumps this epoch, so a
   * pre-undo reply, answer or scheduled callback is rejected even when the
   * round count and question text still match. Snapshots never restore an
   * older epoch.
   */
  generation: number
  /** Current stage (see {@link Phase}). */
  phase: Phase
  /** The prompt as the user first submitted it. */
  original: string
  /** Submission context blocks preserved for a later send. */
  originalContext: readonly string[]
  /** The latest improved prompt. */
  draft: string
  /** Context snapshot, once collected; `null` before collection. */
  context: ContextSnapshot | null
  /** Improvement dialogue held in plugin state, never in the main transcript. */
  dialogue: OptimizerMessage[]
  /** Completions spent on this workflow so far. */
  rounds: number
  /** Absolute round ceiling approved for this workflow; the configured limit still applies. */
  roundLimit?: number
  /** Approval dialog for extending this workflow's round limit. */
  limitAsk?: 'pending' | 'closed' | 'declined'
  /** Which interface the run is using. */
  ui: 'pane' | 'composer'
  /** Tokens spent on this workflow's completions. */
  usage: ModelUsage
  /** Live activity and elapsed time while collecting/generating; absent at rest. */
  progress?: WorkflowProgress
  /** Last failure message, when the phase is `failed`. */
  lastError?: string
  /** The latest reply's change note (always Korean); absent before the first reply. */
  message?: string
  /** The latest reply's clarifying question awaiting an answer; `null`/absent when none. Cleared by `instruct`. */
  question?: string | null
  /** Answer choices for {@link Workflow.question}, offered as pane buttons; empty/absent when none. Cleared by `instruct`. */
  options?: readonly string[]
  /** Engine question dialog for this reply; absent when only the pane is used. */
  questionAsk?: 'pending' | 'closed'
  /** Recorded user-authored answers with their exact question/option provenance. */
  decisions?: DecisionLedger
  /**
   * A correction recorded after the newest successful draft has not been
   * applied yet; the next successful reply clears it. Failures and budget
   * refusals keep it, so an extension can still approve the applying round.
   */
  correctionPending?: boolean
  /** Id of the question awaiting an answer; minted by a successful reply, null when none. */
  questionId?: string | null
  /** Last preflight refusal whose protected evidence exceeded the request budget. */
  budgetError?: BudgetFailure
  /** Newest-last successful revisions kept for comparison and undo (newest five). */
  revisions?: readonly DraftRevision[]
  /** Id of the revision the workflow currently shows; the last of {@link revisions}. */
  currentRevisionId?: string
  /** Next revision id number to mint; a high-water mark, never reused after undo. */
  nextRevisionId?: number
}

/** Counts and decision ids for one local preflight budget refusal. */
export interface BudgetFailure {
  /** Prompt plus system length the protected content needed. */
  requiredChars: number
  /** The request limit it exceeded. */
  limitChars: number
  /** Active decision ids that were protected. */
  decisionIds: readonly string[]
}

/** A one-shot permit that lets one restored draft bypass interception. */
export interface BypassTicket {
  /** Session the permit belongs to. */
  sessionId: string
  /** Workflow whose restoration issued the permit. */
  workflowId: string
  /** Draft text the permit releases. */
  text: string
  /** Epoch milliseconds after which the permit is void. */
  expiresAt: number
}

/** The optimizer-off mode the person armed by typing `rawPrefix` at the start of the prompt box. */
export interface RawMode {
  /** Session the mode belongs to. */
  sessionId: string
  /** The prompt box text as last seen after an edit; an edit whose prior text differs means the box changed out of sight. */
  draft: string
}

/** The metadata an approved draft needs to be submitted by the plugin. */
export interface SubmitTicket {
  /** Session the submission belongs to. */
  sessionId: string
  /** Workflow whose draft is being sent. */
  workflowId: string
  /** Text to submit. */
  text: string
  /** Context blocks to attach beside the text. */
  context: readonly string[]
}

/** The optimizer model's parsed reply, per the fixed JSON contract. */
export interface OptimizerReply {
  /** The complete prompt the user could send. */
  draft: string
  /** Short description of what changed. */
  message: string
  /** At most one clarifying question, or `null`. */
  question: string | null
  /**
   * Short answer choices for `question` (at most {@link MAX_REPLY_OPTIONS}),
   * each a complete answer the person can pick as-is. Empty or absent when
   * there is no question or it is open-ended.
   */
  options?: readonly string[]
}

/** Most answer choices one reply may offer for its question. */
export const MAX_REPLY_OPTIONS = 4

/** Longest answer choice kept, in UTF-16 code units; longer ones are dropped. */
export const MAX_REPLY_OPTION_CHARS = 80

/** One message in the plugin-held improvement dialogue. */
export interface OptimizerMessage {
  /** Who wrote it: the user's supplement, or the optimizer's reply. */
  role: 'user' | 'optimizer'
  /** The message text. */
  text: string
  /** Ledger entry for a user turn captured as a decision (absent for optimizer turns). */
  decisionId?: string
}

/** Token counts for one or more completions (mirrors the engine's usage). */
export interface ModelUsage {
  /** Uncached input tokens. */
  input_tokens: number
  /** Generated output tokens. */
  output_tokens: number
  /** Input tokens served from the prompt cache. */
  cache_read_input_tokens: number
  /** Input tokens written to the prompt cache. */
  cache_creation_input_tokens: number
}

/**
 * One repository file the collector actually read and selected for the
 * snapshot (#31). The path is the collector's own record — never a path
 * parsed out of model or file text — and the excerpt is exactly what the
 * snapshot text carries for it.
 */
export interface RepositorySource {
  /** The relative path the collector read, as labelled in the excerpt. */
  path: string
  /** The final selected excerpt (clipped to the snapshot budget), verbatim. */
  excerpt: string
  /** What kind of file it is. */
  kind: 'domain' | 'scripts' | 'source'
}

/** The deterministic, size-bounded context read once at the start of a run. */
export interface ContextSnapshot {
  /** Selected recent conversation, newest first then reordered. */
  conversation: string
  /** Project rule text (`CLAUDE.md` candidates), capped by {@link CONTEXT_RULES_CHARS}. */
  rules: string
  /** Working directory and repository location, capped by {@link CONTEXT_LOCATION_CHARS}. */
  location: string
  /** Recent tool metadata, capped by {@link CONTEXT_TOOLS_CHARS}. */
  tools: string
  /** Bounded, path-labelled repository evidence relevant to the original request. */
  project?: string
  /**
   * The repository files behind {@link project}: only paths the collector
   * actually read and selected. Inclusion of any excerpt in the current
   * request is a separate matter (later trimming may exclude it).
   */
  repositorySources?: readonly RepositorySource[]
  /** The assembled snapshot text under the configured character budget. */
  text: string
  /** Length of {@link text} in characters. */
  chars: number
}

/** Why a submission is left untouched by the optimizer. */
export type PassReason =
  | 'disabled'
  | 'not-composer'
  | 'empty'
  | 'attachments'
  | 'mid-turn'
  | 'queued'
  | 'slash-command'
  | 'shell'
  | 'over-limit'
  | 'no-trigger'
  | 'pasted'

/**
 * What the plugin saw build the submitted draft since the box was last empty
 * (`hooks/composition.ts`). Optional: a caller that saw no edit or autocomplete
 * events for the draft passes nothing and keeps the older rules only.
 */
export interface SubmissionFacts {
  /** The draft was only pasted, or injected by another app, and never typed in. */
  pasted: boolean
}

/** What the classifier decides for one submission. */
export type SubmissionDecision =
  | { kind: 'optimize'; text: string; trigger: OptimizeTrigger }
  | { kind: 'pass'; reason: PassReason }
  | { kind: 'raw'; text: string }
  | { kind: 'bypass'; text: string; ticket: BypassTicket }
  | { kind: 'reply'; workflowId: string; text: string }
  /** A workflow is already running (or holds the pane): the caller drops the submission, never passes it to the main session. */
  | { kind: 'busy'; workflowId: string }

/** How an interception was requested. */
export type OptimizeTrigger = 'auto' | 'prefix' | 'command'

/** Why a model completion did not yield a usable draft. */
export type RewriteFailureReason =
  | 'api-error'
  | 'empty-reply'
  | 'invalid-json'
  | 'empty-draft'
  | 'aborted'
  | 'rejected'

/** One completion's outcome: a parsed reply plus its cost, or a failure arm. */
export type RewriteResult =
  | { kind: 'ok'; reply: OptimizerReply; usage: ModelUsage }
  | { kind: 'failed'; reason: RewriteFailureReason; message: string; usage: ModelUsage }

/** Aggregated per-session usage kept in the plugin's store. */
export interface UsageTotals {
  /** Number of completions recorded. */
  calls: number
  /** Summed input tokens. */
  input: number
  /** Summed output tokens. */
  output: number
  /** Summed cache-read tokens. */
  cacheRead: number
  /** Summed cache-write tokens. */
  cacheWrite: number
  /** Epoch milliseconds of the last update. */
  updatedAt: number
}

/** The serializable state the reducer owns; timers and signals stay outside it. */
export interface RuntimeState {
  /** Session this state belongs to. */
  sessionId: string
  /** The single active workflow, or `null`. */
  workflow: Workflow | null
  /** The outstanding bypass permit, or `null`. */
  bypass: BypassTicket | null
  /** The armed optimizer-off mode, or `null`. */
  rawMode: RawMode | null
  /** Usage accumulated for this session. */
  usage: UsageTotals
}

/** One reducer input. Generation-bearing events are ignored when stale. */
export type OptimizerEvent =
  | { type: 'start'; workflow: Workflow }
  | { type: 'phase'; workflowId: string; generation: number; phase: Phase }
  | { type: 'progress'; workflowId: string; generation: number; stage?: ProgressStage }
  | { type: 'question-ask'; workflowId: string; round: number; question: string; status: 'pending' | 'closed' }
  | {
      type: 'reply'
      workflowId: string
      generation: number
      /** Session the completion was issued for; its usage belongs there. */
      sessionId: string
      reply: OptimizerReply
      usage: ModelUsage
    }
  | { type: 'failed'; workflowId: string; generation: number; sessionId: string; error: string; usage?: ModelUsage }
  /**
   * A local preflight refusal: the protected decisions and inputs cannot fit.
   * No completion was made, so no usage is charged and no round is spent.
   */
  | {
      type: 'budget-blocked'
      workflowId: string
      generation: number
      sessionId: string
      requiredChars: number
      limitChars: number
      decisionIds: readonly string[]
    }
  | { type: 'limit-ask'; workflowId: string; round: number; status: 'pending' | 'closed' | 'declined' }
  | { type: 'limit-extended'; workflowId: string; round: number; maxRounds: number }
  | { type: 'usage'; workflowId: string; generation: number; sessionId: string; usage: ModelUsage }
  | { type: 'cancel'; workflowId: string }
  | { type: 'dismiss'; workflowId: string }
  | { type: 'reset'; sessionId: string }
  | { type: 'bypass-issued'; ticket: BypassTicket }
  | { type: 'bypass-consumed'; sessionId: string; workflowId: string }
  /** The context snapshot finished collecting for this generation. */
  | { type: 'context'; workflowId: string; generation: number; context: ContextSnapshot }
  /** The user sent a refinement instruction; appended to the dialogue before the next completion. */
  | { type: 'instruct'; workflowId: string; text: string }
  /** The user explicitly replaced one active decision; state only, no model call. */
  | { type: 'decision-corrected'; workflowId: string; targetId: string; text: string }
  /**
   * The user undid to the preceding successful revision; state only, no model
   * call. Independently gated: the reducer re-checks the session, the epoch
   * and the revision pointer the caller saw.
   */
  | { type: 'undo'; sessionId: string; workflowId: string; generation: number; currentRevisionId: string }
  /** The user edited the restored draft in the composer; the bypass follows the edited text. */
  | { type: 'bypass-edited'; sessionId: string; text: string }
  /** The bypass permit was revoked (another fill, cleared draft, session end, expiry). */
  | { type: 'bypass-revoked'; sessionId: string }
  /** The optimizer-off mode was armed by typing `rawPrefix` at the start of the prompt box. */
  | { type: 'raw-mode-armed'; sessionId: string; draft: string }
  /** A later edit was seen while the mode was armed; the draft follows the box. */
  | { type: 'raw-mode-seen'; sessionId: string; draft: string }
  /** The optimizer-off mode was cleared (submit, ctrl+u, fill, or session end). */
  | { type: 'raw-mode-cleared'; sessionId: string }

/** Where a finished draft is written back. */
export interface TransferTarget {
  /** Session to restore into. */
  sessionId: string
  /** Workflow whose draft is being restored. */
  workflowId: string
  /** Text to place in the prompt box. */
  text: string
  /** How the text lands in the box. */
  mode: TransferMode
}

/** How restored text lands in the prompt box. */
export type TransferMode = 'replace' | 'append' | 'insert'

/** Why a restore did not place text in the prompt box. */
export type TransferRefusal = 'no_composer' | 'dialog' | 'draft-conflict' | 'hook-refused' | 'unknown'

/** The outcome of restoring a draft: filled (with its permit) or refused. */
export type TransferResult =
  | { kind: 'filled'; text: string; ticket: BypassTicket }
  | { kind: 'refused'; reason: TransferRefusal }

/** What an approved send should submit and where its metadata comes from. */
export interface SubmitTarget {
  /** Session to submit into. */
  sessionId: string
  /** Workflow whose text is being sent. */
  workflowId: string
  /** Text to submit. */
  text: string
  /** Context blocks to attach beside the text. */
  context: readonly string[]
  /** Whether the text is the improved draft or the stored original. */
  source: 'draft' | 'original'
}

/** Default settings; the manifest `userConfig` states the same values. */
export const DEFAULT_CONFIG: OptimizerConfig = {
  enabled: true,
  modelGuidance: true,
  triggerMode: 'always',
  triggerPrefix: '?? ',
  rawPrefix: '>> ',
  uiMode: 'auto',
  model: 'sonnet',
  maxTokens: 2048,
  timeoutMs: 30000,
  maxRounds: 5,
  contextTurns: 4,
  contextMaxChars: 6000,
  systemPromptFile: '',
  pasteBypass: true,
}

/** Effort sent with every optimizer completion. */
export const DEFAULT_EFFORT = 'low'

/** Allowed `maxTokens` range. */
export const MAX_TOKENS_RANGE = { min: 128, max: 2048 } as const

/** Allowed `timeoutMs` range. */
export const TIMEOUT_MS_RANGE = { min: 1000, max: 30000 } as const

/** Allowed `maxRounds` range. */
export const MAX_ROUNDS_RANGE = { min: 1, max: 5 } as const

/** Allowed `contextTurns` range. */
export const CONTEXT_TURNS_RANGE = { min: 0, max: 8 } as const

/** Allowed `contextMaxChars` range. */
export const CONTEXT_MAX_CHARS_RANGE = { min: 0, max: 8000 } as const

/** Base cap for the assembled context snapshot. */
export const CONTEXT_TOTAL_CHARS = 6000

/** Cap for project rule text inside the snapshot. */
export const CONTEXT_RULES_CHARS = 1200

/** Cap for working-directory/repository text inside the snapshot. */
export const CONTEXT_LOCATION_CHARS = 400

/** Cap for tool metadata inside the snapshot. */
export const CONTEXT_TOOLS_CHARS = 400

/** Cap for task-relevant source and domain-document excerpts in the snapshot. */
export const CONTEXT_PROJECT_CHARS = 3000

/** Most conversation messages kept in the snapshot. */
export const CONTEXT_MESSAGES_MAX = 8

/** Cap for the selected conversation text inside the snapshot. */
export const CONTEXT_CONVERSATION_CHARS = 4000

/** Prompts longer than this are passed through untouched. */
export const MAX_REQUEST_CHARS = 18000

/** An original prompt longer than this is not optimized; it passes through unchanged (DESIGN ④). */
export const MAX_ORIGINAL_CHARS = 6000

/** Cap for an explicitly configured system prompt file. */
export const SYSTEM_PROMPT_MAX_CHARS = 4000

/**
 * The slice of the engine interface the helper modules use. The mod loader
 * refuses a `$` passed across an import, so `register.ts` builds this object
 * from `$.noun.method(...)` closures and hands it to the helpers instead.
 */
export type EnginePorts = {
  session: Pick<EngineInterface['session'], 'messages' | 'cwd' | 'root' | 'repo'> &
    Partial<Pick<EngineInterface['session'], 'model' | 'version'>>
  /** Without every, stages still render but elapsed time does not tick between changes. */
  clock?: Pick<EngineInterface['clock'], 'sleep'> & Partial<Pick<EngineInterface['clock'], 'every'>>
  fs: Pick<EngineInterface['fs'], 'stat' | 'read'> &
    Partial<Pick<EngineInterface['fs'], 'list'>>
  env: Pick<EngineInterface['env'], 'get'>
  model: Pick<EngineInterface['model'], 'complete'>
  prompt: Pick<EngineInterface['prompt'], 'read' | 'fill' | 'submit'>
  ui: Pick<EngineInterface['ui'], 'close'> & Partial<Pick<EngineInterface['ui'], 'ask' | 'log'>>
}

/**
 * Guidance profile chosen from the main session's model (DESIGN-model-guidance §5).
 * `common` applies the shared rewrite guidance only.
 */
export type GuidanceProfile =
  | 'common'
  | 'fable-5-1'
  | 'fable-5'
  | 'opus-5-5'
  | 'opus-5'
  | 'opus-4-8'
  | 'sonnet-5-5'
  | 'sonnet-5'

/** Why a target-model snapshot ended up with its profile. */
export type ModelResolutionReason =
  | 'matched'
  | 'alias'
  | 'unlisted'
  | 'unknown'
  | 'empty'
  | 'disabled'
  | 'unavailable'
  | 'error'
  | 'timeout'
  | 'cancelled'

/** The main session's model as read for one optimizer round. */
export interface TargetModelSnapshot {
  /** The getter's string exactly as returned; null when nothing was read. */
  readonly raw: string | null
  /** Lookup key (no `[1m]`, no date suffix); null when not a versioned model. */
  readonly normalizedId: string | null
  readonly profile: GuidanceProfile
  readonly reason: ModelResolutionReason
}

/** The target model applied to the last request actually sent. */
export interface GuidanceStatus {
  readonly workflowId: string
  /** `current.rounds + 1` at the time the request was sent. */
  readonly round: number
  readonly target: TargetModelSnapshot
}

/** How long one round waits for `session.model()` before using common guidance. */
export const TARGET_MODEL_TIMEOUT_MS = 500

/** Cap for the shared rewrite guidance text. */
export const COMMON_GUIDANCE_MAX_CHARS = 2400

/** Cap for one model-specific guidance block. */
export const MODEL_GUIDANCE_MAX_CHARS = 800

/** Cap for the built-in base prompt outside the shared guidance it embeds. */
export const BASE_PROMPT_MAX_CHARS = 1300

/** Cap for the fixed role-limit and JSON output contract. */
export const FIXED_CONTRACT_MAX_CHARS = 700

/**
 * Cap for the assembled optimizer system prompt with the largest extra file:
 * the four caps above, 200 characters of headings and separators, and
 * {@link SYSTEM_PROMPT_MAX_CHARS}.
 */
export const GUIDANCE_SYSTEM_MAX_CHARS = 9400
