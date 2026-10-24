/**
 * Task D — cheap, deterministic context collection.
 *
 * Reads a snapshot of the current session once, before the optimizer starts,
 * and reuses it for the whole improvement dialogue. Everything here is
 * read-only: the pure assembler {@link buildSnapshot} and the I/O wrapper
 * {@link collectContext}, which touches only `$.session.messages/cwd/root/repo`
 * and `$.fs`. It never calls `$.model.*`, `$.prompt.*` or `$.session.compact`,
 * so the main session's model turn, transcript and cache prefix stay untouched.
 */

import type { SessionMessage } from 'claude-code'

import {
  CONTEXT_CONVERSATION_CHARS,
  CONTEXT_LOCATION_CHARS,
  CONTEXT_MESSAGES_MAX,
  CONTEXT_PROJECT_CHARS,
  CONTEXT_RULES_CHARS,
  CONTEXT_TOOLS_CHARS,
  CONTEXT_TOTAL_CHARS,
  type ContextSnapshot,
  type EnginePorts,
  type OptimizerConfig,
  type RepositorySource,
} from './contracts'
import {
  PreparationCancelled,
  createLocalPreparation,
  type PreparationBudget,
  type PreparationCollectionOptions,
  type PreparationDegradation,
} from './preparation'
import { PROJECT_SCAN_MS, collectProjectEvidenceSnapshot, type ProjectEvidenceSnapshot, type ProjectScanLimits } from './project-context'

/** Per-message character cap before a long message is cut head/tail. */
export const CONTEXT_MESSAGE_CHARS = 1200

/** Inserted where the middle of an over-long message was removed. */
export const CONTEXT_MIDDLE_MARK = '[중략]'

/** Appended when a single-section cap trims the tail of its text. */
export const CONTEXT_TRUNCATION_MARK = '…'

/** Largest project rule file read whole; a bigger file is skipped. */
export const CONTEXT_MAX_RULE_BYTES = 262144

/** Everything {@link buildSnapshot} needs, already gathered. */
export interface SnapshotInput {
  /** The transcript rows, oldest first. */
  messages: readonly SessionMessage[]
  /** Project rule files already read (path and text). */
  rules: readonly { path: string; text: string }[]
  /** Working directory, absolute. */
  cwd: string
  /** Session project root, absolute. */
  root: string
  /** Repository name (`owner/name`, or its root when unnamed), or `null`. */
  repoName: string | null
  /** Recent user turns to read into the snapshot; `0` reads none. */
  contextTurns: number
  /** Character budget for the assembled text. */
  contextMaxChars: number
  /** Bounded repository excerpts collected for the current request. */
  project?: string
  /** The files behind {@link project}, as recorded by the collector. */
  projectSources?: readonly RepositorySource[]
}

/**
 * Assembles the snapshot from already-read data. Pure: no I/O, no clock.
 *
 * Conversation is selected newest-first within the last `contextTurns` user
 * turns, then reordered oldest-first. When the overall budget is exceeded the
 * oldest conversation lines are dropped first. Repository evidence keeps up
 * to two latest rows (500 chars each) by trimming the fixed-section tail when
 * the budget permits. Otherwise, with no conversation left the final
 * {@link truncateHead} cut the tail of the whole text, which may trim the
 * fixed sections too (tools, then project, location, rules in turn). Single
 * sections and single messages are trimmed with a marker, never mid-surrogate.
 */
export function buildSnapshot(input: SnapshotInput): ContextSnapshot {
  const budget = Math.max(0, Math.min(input.contextMaxChars, CONTEXT_TOTAL_CHARS))

  const window =
    input.contextTurns > 0
      ? input.messages.slice(windowStart(input.messages, input.contextTurns))
      : []

  const lines = selectConversation(window)
  const rules = truncateHead(joinRules(input.rules), CONTEXT_RULES_CHARS)
  const location = truncateHead(
    describeLocation(input.root, input.cwd, input.repoName),
    CONTEXT_LOCATION_CHARS,
  )
  const project = truncateHead(input.project ?? '', CONTEXT_PROJECT_CHARS)
  const tools = truncateHead(collectTools(window), CONTEXT_TOOLS_CHARS)

  const assemble = (conversationLines: readonly string[]): string => {
    const parts: string[] = []
    if (rules.length > 0) parts.push(`## Project rules\n${rules}`)
    if (location.length > 0) parts.push(`## Location\n${location}`)
    if (project.length > 0) parts.push(`## Repository evidence (partial, read-only)\n${project}`)
    if (conversationLines.length > 0) {
      parts.push(`## Recent conversation\n${conversationLines.join('\n')}`)
    }
    if (tools.length > 0) parts.push(`## Recent tools\n${tools}`)
    return parts.join('\n\n')
  }

  let text = assemble(lines)
  const preserveCount = project.length > 0 ? Math.min(2, lines.length) : 0
  while (text.length > budget && lines.length > preserveCount) {
    lines.shift()
    text = assemble(lines)
  }
  // Repository excerpts must not erase the latest user decision. In a tight
  // budget reserve up to two recent rows, trimming low-priority fixed tails.
  if (text.length > budget && preserveCount > 0) {
    const recent = lines.map(line => truncateHead(line, 500))
    const recentSection = `## Recent conversation\n${recent.join('\n')}`
    if (budget >= recentSection.length + 200) {
      lines.splice(0, lines.length, ...recent)
      text = `${truncateHead(assemble([]), budget - recentSection.length - 2)}\n\n${recentSection}`
    } else {
      // Very small configured budgets still prioritize rules and file evidence.
      lines.splice(0, lines.length)
      text = assemble(lines)
    }
  }
  if (text.length > budget) text = truncateHead(text, budget)

  return {
    conversation: lines.join('\n'),
    rules,
    location,
    project,
    // Carried as metadata, never parsed back out of the text; absent when the
    // caller collected no source records.
    ...(input.projectSources === undefined ? {} : { repositorySources: input.projectSources }),
    tools,
    text,
    chars: text.length,
  }
}

/** Optional collector bounds for the initial evidence excerpt. */
export interface CollectContextOptions {
  /** Forwarded only as the collector's output cap; omitted keeps its default. */
  projectMaxChars?: number
}

/**
 * Reads the session's own read-only facts and builds a snapshot. Every bounded
 * section that fails, times out or has no host timer is simply left out and the
 * rest of the collection goes on; cancellation is the one distinct outcome and
 * is never turned into an empty section. A zero character budget disables
 * collection entirely, before any transcript, filesystem or timer call.
 *
 * `request` is the original prompt, used only to pick repository evidence.
 * `options.projectMaxChars` can only lower the collector's excerpt cap; it
 * does not change any other snapshot section.
 */
export async function collectContext(
  $: EnginePorts,
  config: OptimizerConfig,
  request = '',
  options: PreparationCollectionOptions & CollectContextOptions = {},
): Promise<ContextSnapshot> {
  if (config.contextMaxChars <= 0) {
    return buildSnapshot({
      messages: [],
      rules: [],
      cwd: '',
      root: '',
      repoName: null,
      contextTurns: 0,
      contextMaxChars: 0,
      projectSources: [],
    })
  }

  const ownsBudget = options.budget === undefined
  const budget = options.budget ?? createLocalPreparation({
    clock: $.clock,
    signal: options.signal,
    now: () => Date.now(),
  })
  const degraded = (label: string, reason: PreparationDegradation): void => {
    options.onDegraded?.(label, reason)
  }

  try {
    const messages = config.contextTurns > 0
      ? await runOr(budget, 'messages', () => $.session.messages(), [], degraded)
      : []
    const cwd = await runOr(budget, 'cwd', () => $.session.cwd(), '', degraded)
    const root = await runOr(budget, 'root', () => $.session.root(), '', degraded)
    const repoName = await runOr(
      budget,
      'repo',
      async () => {
        const repo = await $.session.repo()
        return repo === null ? null : (repo.name ?? repo.root)
      },
      null,
      degraded,
    )
    const rules = root.length > 0 ? await readRules(budget, $, root, cwd, degraded) : []
    // `contextMaxChars > 0` above means repository evidence is wanted. One scan
    // produces both the text and the source records; nothing is parsed back out
    // of the text and no second scan runs. `projectMaxChars` only lowers the
    // collector's excerpt cap, never its read or stat allowances.
    const caps = options.projectMaxChars === undefined
      ? undefined
      : { maxChars: options.projectMaxChars }
    const evidence = root.length > 0
      ? await readProject(budget, $, root, cwd, request, degraded, caps)
      : { text: '', sources: [] as readonly RepositorySource[] }

    return buildSnapshot({
      messages,
      rules,
      cwd,
      root,
      repoName,
      contextTurns: config.contextTurns,
      contextMaxChars: config.contextMaxChars,
      project: evidence.text,
      projectSources: evidence.sources,
    })
  } finally {
    if (ownsBudget) budget.dispose()
  }
}

/** Index of the `contextTurns`-th text-bearing user message from the end. */
function windowStart(messages: readonly SessionMessage[], contextTurns: number): number {
  let turns = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.role === 'user' && message.text.trim().length > 0) {
      turns += 1
      if (turns >= contextTurns) return i
    }
  }
  return 0
}

/** Text-bearing messages, newest first capped, then chronologically ordered. */
function selectConversation(window: readonly SessionMessage[]): string[] {
  const candidates = window.filter(message => message.text.trim().length > 0)
  const newest = candidates.slice(-CONTEXT_MESSAGES_MAX)

  const lines: string[] = []
  let used = 0
  for (let i = newest.length - 1; i >= 0; i -= 1) {
    const message = newest[i]
    if (!message) continue
    const body = truncateMiddle(message.text.trim(), CONTEXT_MESSAGE_CHARS)
    const line = `[${message.role}] ${body}`
    const added = lines.length === 0 ? line.length : line.length + 1
    if (used + added > CONTEXT_CONVERSATION_CHARS) break
    lines.push(line)
    used += added
  }

  lines.reverse()
  return lines
}

/** Distinct tool names among `window`, most recent first, within the cap. */
function collectTools(window: readonly SessionMessage[]): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i]
    if (!message) continue
    for (const use of message.toolUses) {
      if (!seen.has(use.tool)) {
        seen.add(use.tool)
        names.push(use.tool)
      }
    }
  }

  let out = ''
  for (const name of names) {
    const next = out.length === 0 ? name : `${out}, ${name}`
    if (next.length > CONTEXT_TOOLS_CHARS) break
    out = next
  }
  return out
}

/** Rule file texts joined by a blank line; labels are dropped to save room. */
function joinRules(rules: readonly { path: string; text: string }[]): string {
  const parts: string[] = []
  for (const rule of rules) {
    const text = rule.text.trim()
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

/** `cwd` relative to root (or `.`), plus the repo name when known. */
function describeLocation(root: string, cwd: string, repoName: string | null): string {
  const lines: string[] = []
  if (cwd.length > 0) lines.push(`cwd: ${relativeToRoot(root, cwd)}`)
  if (repoName !== null && repoName.length > 0) lines.push(`repo: ${repoName}`)
  return lines.join('\n')
}

/** The cwd under root as a relative path, `.` for root itself, else absolute. */
function relativeToRoot(root: string, cwd: string): string {
  if (root.length === 0) return cwd
  if (cwd === root) return '.'
  const prefix = root.endsWith('/') ? root : `${root}/`
  return cwd.startsWith(prefix) ? cwd.slice(prefix.length) : cwd
}

/** `dir` + a relative path, keeping a lone `/` root intact. */
function joinPath(dir: string, relative: string): string {
  const base = dir === '/' ? '' : dir.replace(/\/+$/, '')
  return `${base}/${relative}`
}

/**
 * Runs one optional read under the round's budget. A timeout, budget expiry,
 * missing timer or task error yields `fallback`; cancellation propagates as
 * {@link PreparationCancelled} so a broad catch cannot turn it into a default.
 */
async function runOr<T>(
  budget: PreparationBudget,
  label: string,
  task: () => Promise<T>,
  fallback: T,
  degraded: (label: string, reason: PreparationDegradation) => void,
): Promise<T> {
  const result = await budget.run(label, task)
  if (result.kind === 'ok') return result.value
  if (result.kind === 'cancelled') throw new PreparationCancelled()
  degraded(label, result.kind)
  return fallback
}

/** Local project instructions, read only when small enough to be worth it. */
async function readRules(
  budget: PreparationBudget,
  $: EnginePorts,
  root: string,
  cwd: string,
  degraded: (label: string, reason: PreparationDegradation) => void,
): Promise<{ path: string; text: string }[]> {
  if (root.length === 0) return []

  const candidates: string[] = [
    joinPath(root, 'CLAUDE.md'),
    joinPath(root, '.claude/CLAUDE.md'),
    joinPath(root, 'AGENTS.md'),
  ]
  if (cwd.length > 0 && cwd !== root) {
    candidates.push(joinPath(cwd, 'CLAUDE.md'), joinPath(cwd, 'AGENTS.md'))
  }

  const found: { path: string; text: string }[] = []
  const seen = new Set<string>()
  for (const path of candidates) {
    if (seen.has(path)) continue
    seen.add(path)
    // A missing/denied rule file is normal and not a degradation; only an
    // inability to finish the read within the budget is reported.
    const stat = await budget.run('rule-stat', async () => {
      try {
        return { found: true as const, stat: await $.fs.stat(path) }
      } catch {
        return { found: false as const }
      }
    })
    if (stat.kind === 'cancelled') throw new PreparationCancelled()
    if (stat.kind !== 'ok') {
      degraded('rule-stat', stat.kind)
      continue
    }
    if (!stat.value.found) continue
    if (stat.value.stat.kind !== 'file' || stat.value.stat.size > CONTEXT_MAX_RULE_BYTES) continue

    const read = await budget.run('rule-read', async () => {
      try {
        return { found: true as const, text: await $.fs.read(path) }
      } catch {
        return { found: false as const }
      }
    })
    if (read.kind === 'cancelled') throw new PreparationCancelled()
    if (read.kind !== 'ok') {
      degraded('rule-read', read.kind)
      continue
    }
    if (read.value.found && typeof read.value.text === 'string' && read.value.text.trim().length > 0) {
      found.push({ path, text: read.value.text })
    }
  }
  return found
}

/** Repository evidence is optional; its own 2000 ms cap runs inside the budget. */
async function readProject(
  budget: PreparationBudget,
  $: EnginePorts,
  root: string,
  cwd: string,
  request: string,
  degraded: (label: string, reason: PreparationDegradation) => void,
  limits?: Partial<ProjectScanLimits>,
): Promise<ProjectEvidenceSnapshot> {
  const result = await budget.run(
    'project',
    signal => collectProjectEvidenceSnapshot($, root, cwd, request, signal, limits),
    PROJECT_SCAN_MS,
  )
  if (result.kind === 'ok') return result.value
  if (result.kind === 'cancelled') throw new PreparationCancelled()
  degraded('project', result.kind)
  return { text: '', sources: [] }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** First `end` characters, never splitting a surrogate pair. */
function safeHead(text: string, end: number): string {
  if (end >= text.length) return text
  let cut = end < 0 ? 0 : end
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1
  return text.slice(0, cut)
}

/** Last `length` characters, never splitting a surrogate pair. */
function safeTail(text: string, length: number): string {
  if (length >= text.length) return text
  let start = text.length - Math.max(0, length)
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1
  return text.slice(start)
}

/** Keeps the head, appends the truncation marker, within `cap` characters. */
export function truncateHead(
  text: string,
  cap: number,
  mark: string = CONTEXT_TRUNCATION_MARK,
): string {
  if (text.length <= cap) return text
  if (cap <= mark.length) return safeHead(text, Math.max(0, cap))
  return `${safeHead(text, cap - mark.length)}${mark}`
}

/** Keeps head and tail with the middle marker between them, within `cap`. */
function truncateMiddle(text: string, cap: number, mark: string = CONTEXT_MIDDLE_MARK): string {
  if (text.length <= cap) return text
  if (cap <= mark.length) return safeHead(text, Math.max(0, cap))
  const room = cap - mark.length
  const head = Math.ceil(room / 2)
  const tail = room - head
  return `${safeHead(text, head)}${mark}${safeTail(text, tail)}`
}
