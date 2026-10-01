/**
 * Deterministic mapping from the main session's raw model string to a guidance
 * snapshot (DESIGN-model-guidance §5, 결정 c). Pure and synchronous: it touches
 * no engine port and performs no I/O.
 *
 * The raw string is preserved exactly; only a private lookup copy is trimmed,
 * lowercased and stripped of a single `[1m]` marker and a single trailing build
 * date. Lookup is full-string on an exact allowlist and never falls back to a
 * nearby version or a partial/substring match.
 */

import type {
  GuidanceProfile,
  ModelResolutionReason,
  TargetModelSnapshot,
} from './contracts'

/** Longest accepted raw model string (UTF-16 code units); longer is `unknown`. */
const MAX_RAW_LENGTH = 256

/** Controls that make a raw string unusable for lookup. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** A single trailing 1M-context marker, removed from the lookup copy. */
const LONG_CONTEXT_SUFFIX = /\[1m\]$/

/** A single trailing `-YYYYMMDD` build date, removed from the lookup copy. */
const DATED_SUFFIX = /-\d{8}$/

/**
 * The whole lookup copy must be exactly an optional `claude` prefix, a known
 * family, and an optional major/minor version. Substrings never map.
 */
const MODEL_GRAMMAR =
  /^(?:claude[ -])?(fable|mythos|opus|sonnet|haiku)(?:[ -](\d+)(?:[. -](\d+))?)?$/

/**
 * The exact allowlist of canonical ids that get a model-specific profile.
 * Every other formally valid id stays on `common` with reason `unlisted`.
 */
export const MODEL_PROFILE_BY_ID: Readonly<Record<string, GuidanceProfile>> = {
  'claude-fable-5-1': 'fable-5-1',
  'claude-mythos-5-1': 'fable-5-1',
  'claude-fable-5': 'fable-5',
  'claude-mythos-5': 'fable-5',
  'claude-opus-5-5': 'opus-5-5',
  'claude-opus-5': 'opus-5',
  'claude-opus-4-8': 'opus-4-8',
  'claude-sonnet-5-5': 'sonnet-5-5',
  'claude-sonnet-5': 'sonnet-5',
}

function snapshot(
  raw: string | null,
  normalizedId: string | null,
  profile: GuidanceProfile,
  reason: ModelResolutionReason,
): TargetModelSnapshot {
  return { raw, normalizedId, profile, reason }
}

/**
 * Maps one `session.model()` result to a guidance snapshot.
 *
 * @param raw the getter's value, of unknown shape
 * @returns a snapshot whose `raw` is the untouched input (or `null` when the
 *   input was not a string); unknown input degrades to `common`.
 */
export function normalizeTargetModel(raw: unknown): TargetModelSnapshot {
  // 1. Only strings can carry a model id; everything else is empty input.
  if (typeof raw !== 'string') {
    return snapshot(null, null, 'common', 'empty')
  }

  // 1. Blank strings carry no id; the original is preserved verbatim.
  if (raw.trim() === '') {
    return snapshot(raw, null, 'common', 'empty')
  }

  // 1. Control characters and over-long values are refused whole, never cut.
  if (raw.length > MAX_RAW_LENGTH || CONTROL_CHARS.test(raw)) {
    return snapshot(raw, null, 'common', 'unknown')
  }

  // 2. Normalize only the lookup copy: trim, lowercase, drop one `[1m]` and one
  //    trailing build date. Other suffixes/prefixes are intentionally rejected.
  let lookup = raw.trim().toLowerCase()
  lookup = lookup.replace(LONG_CONTEXT_SUFFIX, '')
  lookup = lookup.replace(DATED_SUFFIX, '')

  // 3. Full-string match only; mixed or partial model strings are rejected.
  const match = MODEL_GRAMMAR.exec(lookup)
  if (match === null) {
    return snapshot(raw, null, 'common', 'unknown')
  }

  // The family group is mandatory in the grammar, so it is always present.
  const family = match[1] ?? ''
  const major = match[2]
  const minor = match[3]

  // 4. A bare alias has no version to resolve; never hardcode a default one.
  if (major === undefined) {
    return snapshot(raw, null, 'common', 'alias')
  }

  const normalizedId =
    minor === undefined
      ? `claude-${family}-${major}`
      : `claude-${family}-${major}-${minor}`

  // 5. Exact allowlist lookup; known-but-unlisted versions stay on common.
  const profile = MODEL_PROFILE_BY_ID[normalizedId]
  if (profile === undefined) {
    return snapshot(raw, normalizedId, 'common', 'unlisted')
  }
  return snapshot(raw, normalizedId, profile, 'matched')
}
