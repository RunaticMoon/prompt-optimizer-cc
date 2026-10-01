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
  CONTEXT_MEMORY_CHARS,
  CONTEXT_MESSAGES_MAX,
  CONTEXT_RULES_CHARS,
  CONTEXT_TOOLS_CHARS,
  CONTEXT_TOTAL_CHARS,
  type ContextSnapshot,
  type EnginePorts,
  type OptimizerConfig,
} from './contracts'

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
  /** Injected long-term memory text, already rendered; empty injects nothing. */
  memory: string
}

/**
 * Assembles the snapshot from already-read data. Pure: no I/O, no clock.
 *
 * Conversation is selected newest-first within the last `contextTurns` user
 * turns, then reordered oldest-first. When the overall budget is exceeded the
 * oldest conversation lines are dropped first; the fixed sections (rules,
 * location, memory, tools) stay. Single sections and single messages are
 * trimmed with a marker, never mid-surrogate.
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
  const memory = truncateHead(input.memory, CONTEXT_MEMORY_CHARS)
  const tools = truncateHead(collectTools(window), CONTEXT_TOOLS_CHARS)

  const assemble = (conversationLines: readonly string[]): string => {
    const parts: string[] = []
    if (rules.length > 0) parts.push(`## Project rules\n${rules}`)
    if (location.length > 0) parts.push(`## Location\n${location}`)
    if (memory.length > 0) {
      parts.push(`## Long-term memory (injected by other plugins)\n${memory}`)
    }
    if (conversationLines.length > 0) {
      parts.push(`## Recent conversation\n${conversationLines.join('\n')}`)
    }
    if (tools.length > 0) parts.push(`## Recent tools\n${tools}`)
    return parts.join('\n\n')
  }

  let text = assemble(lines)
  while (text.length > budget && lines.length > 0) {
    lines.shift()
    text = assemble(lines)
  }
  if (text.length > budget) text = truncateHead(text, budget)

  return {
    conversation: lines.join('\n'),
    rules,
    location,
    memory,
    tools,
    text,
    chars: text.length,
  }
}

/**
 * Reads the session's own read-only facts and builds a snapshot. Every I/O
 * failure empties only the section it feeds and the read goes on.
 *
 * `memory` is the already-rendered injected-memory text; it joins the snapshot
 * only when `config.memoryContext` is on, so the read itself never changes.
 */
export async function collectContext(
  $: EnginePorts,
  config: OptimizerConfig,
  memory = '',
): Promise<ContextSnapshot> {
  const messages = await readMessages($)
  const cwd = await readText(() => $.session.cwd())
  const root = await readText(() => $.session.root())
  const repoName = await readRepoName($)
  const rules = await readRules($, root, cwd)

  return buildSnapshot({
    messages,
    rules,
    cwd,
    root,
    repoName,
    contextTurns: config.contextTurns,
    contextMaxChars: config.contextMaxChars,
    memory: config.memoryContext ? memory : '',
  })
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

async function readMessages($: EnginePorts): Promise<readonly SessionMessage[]> {
  try {
    return await $.session.messages()
  } catch {
    return []
  }
}

async function readText(read: () => Promise<string>): Promise<string> {
  try {
    return await read()
  } catch {
    return ''
  }
}

async function readRepoName($: EnginePorts): Promise<string | null> {
  try {
    const repo = await $.session.repo()
    return repo === null ? null : (repo.name ?? repo.root)
  } catch {
    return null
  }
}

/** The three CLAUDE.md candidates, read only when small enough to be worth it. */
async function readRules(
  $: EnginePorts,
  root: string,
  cwd: string,
): Promise<{ path: string; text: string }[]> {
  if (root.length === 0) return []

  const candidates: string[] = [
    joinPath(root, 'CLAUDE.md'),
    joinPath(root, '.claude/CLAUDE.md'),
  ]
  if (cwd.length > 0 && cwd !== root) candidates.push(joinPath(cwd, 'CLAUDE.md'))

  const found: { path: string; text: string }[] = []
  const seen = new Set<string>()
  for (const path of candidates) {
    if (seen.has(path)) continue
    seen.add(path)
    try {
      const stat = await $.fs.stat(path)
      if (stat.kind !== 'file' || stat.size > CONTEXT_MAX_RULE_BYTES) continue
      const text = await $.fs.read(path)
      if (typeof text === 'string' && text.trim().length > 0) found.push({ path, text })
    } catch {
      // Missing, unreadable or denied: that rule candidate is simply absent.
    }
  }
  return found
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
function truncateHead(text: string, cap: number, mark: string = CONTEXT_TRUNCATION_MARK): string {
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
