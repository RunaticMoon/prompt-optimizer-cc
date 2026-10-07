/**
 * Task A — the prompt-cache minimum engine version.
 *
 * {@link supportsPromptCache} decides whether one engine build can take the
 * block-form `prompt`/`system` (a `ModelTextBlock[]` with `cache` marks) that
 * `$.model.complete` gained. The first `major.minor.patch` in the version
 * string is compared numerically against {@link PROMPT_CACHE_MIN_VERSION}; a
 * development suffix (`2.1.292-dev.20260920...`) still reads as its release
 * core, while a missing or unparseable version is treated as unsupported so the
 * caller keeps the plain string request.
 */

/** The oldest engine version whose `$.model.complete` takes cached text blocks. */
export const PROMPT_CACHE_MIN_VERSION = '2.1.292'

/** One parsed `major.minor.patch` triple, or `null` when absent. */
function parseVersion(version: string | undefined): readonly [number, number, number] | null {
  if (version === undefined) return null
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return [major, minor, patch]
}

/**
 * Whether `version` is an engine that supports cached prompt text blocks:
 * its first `major.minor.patch` is at or above
 * {@link PROMPT_CACHE_MIN_VERSION}. Anything that carries no such triple is
 * unsupported.
 */
export function supportsPromptCache(version: string | undefined): boolean {
  const parsed = parseVersion(version)
  const minimum = parseVersion(PROMPT_CACHE_MIN_VERSION)
  // `minimum` is a literal constant, so this only guards a future edit.
  if (parsed === null || minimum === null) return false
  const [major, minor, patch] = parsed
  const [minMajor, minMinor, minPatch] = minimum
  if (major !== minMajor) return major > minMajor
  if (minor !== minMinor) return minor > minMinor
  return patch >= minPatch
}
