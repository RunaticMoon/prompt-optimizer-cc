/**
 * Pure accounting for bounded, follow-up-only repository evidence.
 *
 * The original snapshot stays fixed. A fresh refine answer may add at most two
 * supplementary scans per workflow, each limited to newly named targets. This
 * module decides whether a scan is justified and keeps its accumulated text
 * inside the reserve carved out of the snapshot budget; it performs no I/O and
 * reads no clock (callers pass an ISO timestamp).
 *
 * Targets are lexical signals, never semantic certainty. A scan failure or a
 * budget stop must be reported as unverified, not as proof of absence.
 */

import { CONTEXT_PROJECT_CHARS, CONTEXT_TOTAL_CHARS } from './contracts'
import {
  type AliasGroup,
  SEARCH_WEIGHT,
  canonicalGroupKey,
  extractSearchTerms,
  extractTargets,
  mergeAliasGroups,
} from './search-terms'

/** The workflow generation a refresh cache belongs to. */
export interface RefreshOwner {
  sessionId: string
  workflowId: string
  generation: number
}

/** One retained supplementary scan. */
export interface RefreshEntry {
  /** ISO collection timestamp supplied by the controller. */
  collectedAt: string
  /** Round number the evidence was collected for. */
  round: number
  /** Canonical targets the scan was asked to find. */
  targets: readonly string[]
  /** Scanner output; already partial and read-only. */
  text: string
}

/** Private, owner-scoped refresh state; never a reducer/config field. */
export interface RefreshState {
  owner: RefreshOwner
  /** Canonical concepts already searched or already present in the snapshot. */
  seen: readonly string[]
  /** Supplementary scans planned so far, including failed ones. */
  attempts: number
  /** Characters reserved for supplementary headers and evidence together. */
  reserveChars: number
  /** Built-in and project alias groups available to this workflow. */
  aliases: readonly AliasGroup[]
  /** Newest first, deduplicated, within the reserve budget. */
  entries: readonly RefreshEntry[]
}

/** Frozen allocation for one workflow's original and follow-up evidence. */
export interface RefreshAllocation {
  /** Clamped total snapshot budget. */
  total: number
  /** Reserved for all follow-up blocks. */
  reserve: number
  /** Initial snapshot text budget (`total - reserve`). */
  initial: number
  /** Reserved for supplementary project evidence. */
  projectReserve: number
  /** Initial project excerpt budget (`3000 - projectReserve`). */
  projectInitial: number
}

/** Largest number of supplementary scans in one workflow. */
export const REFRESH_MAX_ATTEMPTS = 2

/** Largest number of new targets sent to one scan. */
export const REFRESH_MAX_TARGETS = 8

/** Largest number of prior explicit identifiers added as hints. */
export const REFRESH_PRIOR_HINTS = 4

/** Largest supplementary block reserved for follow-up evidence. */
export const REFRESH_RESERVE_MAX_CHARS = 1000

/** Longest one target label in a rendered entry header. */
const REFRESH_LABEL_MAX_CHARS = 80

/**
 * Freezes `B` and `R` when the original workflow starts.
 *
 * `B = clamp(contextMaxChars, 0, CONTEXT_TOTAL_CHARS)` and
 * `R = min(1000, floor(B / 6))`. The initial snapshot gets `B - R`, the initial
 * project excerpt gets `CONTEXT_PROJECT_CHARS - R`, so no follow-up can push
 * either aggregate past its published cap.
 */
export function refreshAllocation(contextMaxChars: number): RefreshAllocation {
  const requested = Number.isFinite(contextMaxChars) ? Math.floor(contextMaxChars) : 0
  const total = Math.max(0, Math.min(requested, CONTEXT_TOTAL_CHARS))
  const reserve = Math.min(REFRESH_RESERVE_MAX_CHARS, Math.floor(total / 6))
  const projectReserve = Math.min(reserve, CONTEXT_PROJECT_CHARS)
  return {
    total,
    reserve,
    initial: total - reserve,
    projectReserve,
    projectInitial: CONTEXT_PROJECT_CHARS - projectReserve,
  }
}

/**
 * Builds the initial refresh state from the original request and only the
 * explicitly present user conversation text. Assistant suggestions are not
 * promoted to user decisions. `seen` uses canonical concept keys, so Korean
 * login and English login count as the same concept.
 */
export function initialRefreshState(
  owner: RefreshOwner,
  request: string,
  conversation: string,
  projectAliases: readonly AliasGroup[],
  reserveChars: number,
): RefreshState {
  const aliases = mergeAliasGroups(projectAliases)
  const userText = conversationUserText(conversation)
  const seen: string[] = []
  for (const key of extractTargets(`${request}\n${userText}`, aliases)) {
    if (!seen.includes(key)) seen.push(key)
  }
  return {
    owner,
    seen,
    attempts: 0,
    reserveChars: normalizeReserve(reserveChars),
    aliases,
    entries: [],
  }
}

/**
 * Decides whether a fresh answer justifies one scan.
 *
 * Returns `null` for a repeated alias, an option number, a deictic choice, a
 * style change, an exhausted attempt budget, or a zero reserve. A plan already
 * counts the attempt and the newly seen targets, so the caller may await the
 * scan without allowing a bare retry or a failure to start another one.
 */
export function planRefresh(
  state: RefreshState,
  freshAnswer: string,
): { nextState: RefreshState; query: string; newTargets: readonly string[] } | null {
  if (state.attempts >= REFRESH_MAX_ATTEMPTS || state.reserveChars <= 0) return null
  if (freshAnswer.trim() === '') return null
  const extracted = extractTargets(freshAnswer, state.aliases)
  const newTargets = extracted.filter(key => !state.seen.includes(key)).slice(0, REFRESH_MAX_TARGETS)
  if (newTargets.length === 0) return null

  const hints = extractSearchTerms(freshAnswer, state.aliases)
    .filter(term => term.weight >= SEARCH_WEIGHT.identifier && state.seen.includes(term.key) && !newTargets.includes(term.key))
    .map(term => term.key)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .slice(0, REFRESH_PRIOR_HINTS)

  return {
    nextState: { ...state, attempts: state.attempts + 1, seen: [...state.seen, ...newTargets] },
    query: queryText([...newTargets, ...hints], state.aliases),
    newTargets,
  }
}

/**
 * Appends one scan result and bounds the accumulated block to the reserve.
 *
 * Newest entries stay first; identical evidence payloads deduplicate; older
 * entries are dropped before the latest body is clipped. Labels are bounded
 * too, and clipping never splits a surrogate pair.
 */
export function appendRefresh(
  state: RefreshState,
  entry: { collectedAt: string; round: number; targets: readonly string[]; text: string },
): RefreshState {
  if (state.reserveChars <= 0 || entry.text.trim() === '') return state
  const next: RefreshEntry = {
    collectedAt: entry.collectedAt,
    round: Number.isFinite(entry.round) ? Math.max(0, Math.floor(entry.round)) : 0,
    targets: [...new Set(entry.targets.filter(target => typeof target === 'string' && target !== ''))],
    text: entry.text,
  }
  const entries: RefreshEntry[] = [next]
  for (const old of state.entries) {
    if (old.text === next.text) continue
    entries.push(old)
  }
  while (entries.length > 1 && renderedLength(entries) > state.reserveChars) entries.pop()
  const newest = entries[0]
  if (newest !== undefined && entryLength(newest) > state.reserveChars) {
    entries[0] = fitEntry(newest, state.reserveChars)
  }
  return { ...state, entries }
}

/**
 * Renders the retained entries for the variable request block. The result is
 * bounded to the reserve; the model wraps it in `<repository_followup>`.
 */
export function renderRefresh(state: RefreshState): string {
  if (state.reserveChars <= 0 || state.entries.length === 0) return ''
  return clip(state.entries.map(entryText).join('\n\n'), state.reserveChars)
}

/** One entry header plus body, with every label bounded. */
export function entryText(entry: RefreshEntry): string {
  const time = entry.collectedAt.trim() === '' ? 'unknown' : clip(entry.collectedAt.trim(), REFRESH_LABEL_MAX_CHARS)
  const targets = entry.targets.length === 0
    ? 'none'
    : clip(entry.targets.map(target => clip(target, REFRESH_LABEL_MAX_CHARS)).join(', '), REFRESH_LABEL_MAX_CHARS * 2)
  return `collected: ${time}; round: ${entry.round}; targets: ${targets}; partial, read-only\n${entry.text}`
}

/** Only lines explicitly marked as the person's own text seed `seen`. */
function conversationUserText(conversation: string): string {
  const lines: string[] = []
  for (const line of conversation.split('\n')) {
    if (!line.startsWith('[user] ')) continue
    lines.push(line.slice('[user] '.length))
  }
  return lines.join('\n')
}

/** Expands canonical keys back to surface members for the scan query. */
function queryText(keys: readonly string[], aliases: readonly AliasGroup[]): string {
  const words: string[] = []
  for (const key of keys) {
    const group = aliases.find(members => canonicalGroupKey(members) === key)
    if (group === undefined) {
      if (!words.includes(key)) words.push(key)
      continue
    }
    for (const member of group) if (!words.includes(member)) words.push(member)
  }
  return words.join(' ')
}

/** Clamps a caller-supplied reserve to the published maximum. */
function normalizeReserve(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(Math.floor(value), REFRESH_RESERVE_MAX_CHARS))
}

/** Rendered length of every entry plus the separators between them. */
function renderedLength(entries: readonly RefreshEntry[]): number {
  return entries.reduce((sum, entry, index) => sum + entryText(entry).length + (index === 0 ? 0 : 2), 0)
}

/** Length of one rendered entry. */
function entryLength(entry: RefreshEntry): number {
  return entryText(entry).length
}

/** Shrinks one entry's body, then its header, to fit `cap`. */
function fitEntry(entry: RefreshEntry, cap: number): RefreshEntry {
  const full = entryText(entry)
  if (full.length <= cap) return entry
  const time = entry.collectedAt.trim() === '' ? 'unknown' : clip(entry.collectedAt.trim(), REFRESH_LABEL_MAX_CHARS)
  const targets = entry.targets.length === 0
    ? 'none'
    : clip(entry.targets.map(target => clip(target, REFRESH_LABEL_MAX_CHARS)).join(', '), REFRESH_LABEL_MAX_CHARS * 2)
  const header = `collected: ${time}; round: ${entry.round}; targets: ${targets}; partial, read-only`
  if (header.length >= cap) {
    return { ...entry, text: '', targets: [], collectedAt: time }
  }
  return { ...entry, text: clip(entry.text, cap - header.length - 1), targets: entry.targets, collectedAt: time }
}

/** First `cap` characters with an ellipsis, never splitting a surrogate pair. */
function clip(text: string, cap: number): string {
  if (text.length <= cap) return text
  if (cap <= 0) return ''
  if (cap === 1) return safeHead(text, 1)
  let cut = Math.max(0, cap - 1)
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1] ?? '')) cut -= 1
  return `${text.slice(0, cut)}…`
}

/** First `end` characters without splitting a surrogate pair. */
function safeHead(text: string, end: number): string {
  let cut = Math.max(0, end)
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1] ?? '')) cut -= 1
  return text.slice(0, cut)
}
