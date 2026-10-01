/**
 * Shared contracts for the prompt-optimizer mod: the types and constants every
 * other module (C-L) imports from. Types and constants only, no runtime logic.
 */

import type { EngineInterface } from 'claude-code'

/** User settings as the manifest `userConfig` declares them, after defaults. */
export interface OptimizerConfig {
  /** Whether the optimizer intercepts eligible submissions at all. */
  enabled: boolean
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

/** One optimization run over one original prompt. */
export interface Workflow {
  /** Stable id for this run, unique per session. */
  id: string
  /** Session the run belongs to. */
  sessionId: string
  /** Always 0; workflow ids are unique per session, which is what makes late replies stale. */
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
  /** Which interface the run is using. */
  ui: 'pane' | 'composer'
  /** Tokens spent on this workflow's completions. */
  usage: ModelUsage
  /** Last failure message, when the phase is `failed`. */
  lastError?: string
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
}

/** One message in the plugin-held improvement dialogue. */
export interface OptimizerMessage {
  /** Who wrote it: the user's supplement, or the optimizer's reply. */
  role: 'user' | 'optimizer'
  /** The message text. */
  text: string
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
  /** Usage accumulated for this session. */
  usage: UsageTotals
}

/** One reducer input. Generation-bearing events are ignored when stale. */
export type OptimizerEvent =
  | { type: 'start'; workflow: Workflow }
  | { type: 'phase'; workflowId: string; generation: number; phase: Phase }
  | {
      type: 'reply'
      workflowId: string
      generation: number
      reply: OptimizerReply
      usage: ModelUsage
    }
  | { type: 'failed'; workflowId: string; generation: number; error: string; usage?: ModelUsage }
  | { type: 'usage'; workflowId: string; generation: number; usage: ModelUsage }
  | { type: 'cancel'; workflowId: string }
  | { type: 'dismiss'; workflowId: string }
  | { type: 'reset'; sessionId: string }
  | { type: 'bypass-issued'; ticket: BypassTicket }
  | { type: 'bypass-consumed'; sessionId: string; workflowId: string }
  /** The context snapshot finished collecting for this generation. */
  | { type: 'context'; workflowId: string; generation: number; context: ContextSnapshot }
  /** The user sent a refinement instruction; appended to the dialogue before the next completion. */
  | { type: 'instruct'; workflowId: string; text: string }
  /** The user edited the restored draft in the composer; the bypass follows the edited text. */
  | { type: 'bypass-edited'; sessionId: string; text: string }
  /** The bypass permit was revoked (another fill, cleared draft, session end, expiry). */
  | { type: 'bypass-revoked'; sessionId: string }

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
  triggerMode: 'always',
  triggerPrefix: '?? ',
  rawPrefix: '::raw ',
  uiMode: 'auto',
  model: 'haiku',
  maxTokens: 1024,
  timeoutMs: 12000,
  maxRounds: 3,
  contextTurns: 4,
  contextMaxChars: 6000,
  systemPromptFile: '',
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

/** Most conversation messages kept in the snapshot. */
export const CONTEXT_MESSAGES_MAX = 8

/** Cap for the selected conversation text inside the snapshot. */
export const CONTEXT_CONVERSATION_CHARS = 4000

/** Prompts longer than this are passed through untouched. */
export const MAX_REQUEST_CHARS = 16000

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
    Partial<Pick<EngineInterface['session'], 'model'>>
  /** Optional so older hosts and tests without a timer degrade to common guidance. */
  clock?: Pick<EngineInterface['clock'], 'sleep'>
  fs: Pick<EngineInterface['fs'], 'stat' | 'read'>
  env: Pick<EngineInterface['env'], 'get'>
  model: Pick<EngineInterface['model'], 'complete'>
  prompt: Pick<EngineInterface['prompt'], 'read' | 'fill' | 'submit'>
  ui: Pick<EngineInterface['ui'], 'close'>
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
export const COMMON_GUIDANCE_MAX_CHARS = 1500

/** Cap for one model-specific guidance block. */
export const MODEL_GUIDANCE_MAX_CHARS = 800

/** Cap for the assembled optimizer system prompt with the largest extra file. */
export const GUIDANCE_SYSTEM_MAX_CHARS = 7600
