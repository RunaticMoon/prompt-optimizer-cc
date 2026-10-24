/**
 * Settings resolution for the prompt optimizer.
 *
 * The mod loader calls `register(on, options)` with a flat `PluginOptions`
 * record (`Record<string, string | number | boolean | readonly string[]>`), so
 * `resolveConfig` normalizes every known key, coerces the string spellings the
 * `/config` UI can produce, and reports each fallback as one warning line.
 *
 * `validateConfigChange` applies the same per-key rules to one runtime change
 * (for `/optimize model <id>`); it cannot see the other keys, so cross-key
 * prefix conflicts are settled only in `resolveConfig`.
 *
 * `loadSystemPromptExtra` reads an explicitly configured file through `$.fs`
 * and `$.env` only: no shell, `~` expanded by hand, the result truncated to
 * {@link SYSTEM_PROMPT_MAX_CHARS}.
 */

import type { ConfigKey, EnginePorts, OptimizerConfig } from './contracts'
import {
  CONTEXT_MAX_CHARS_RANGE,
  CONTEXT_TURNS_RANGE,
  DEFAULT_CONFIG,
  MAX_ROUNDS_RANGE,
  MAX_TOKENS_RANGE,
  SYSTEM_PROMPT_MAX_CHARS,
  TIMEOUT_MS_RANGE,
} from './contracts'
import {
  PreparationCancelled,
  createLocalPreparation,
  type PreparationCollectionOptions,
  type PreparationDegradation,
} from './preparation'

/** Every known setting key, in the order warnings are emitted. */
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[]

/** A per-key outcome: the usable value, or the fallback plus why it was used. */
interface KeyResult {
  value: OptimizerConfig[ConfigKey]
  warning?: string
}

/** Whether `value` is a plain settings object (not an array, `null`, or a primitive). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `key` names a real setting. */
function isConfigKey(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)
}

/** Coerces `true`/`false` and their string spellings to a boolean. */
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** Coerces a number, or a numeric string, to an integer; otherwise `undefined`. */
function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Number(trimmed)
    return Number.isInteger(parsed) ? parsed : undefined
  }
  return undefined
}

/** Reads one numeric setting, falling back to `fallback` outside `range`. */
function coerceNumber(
  key: ConfigKey,
  raw: unknown,
  fallback: number,
  range: { readonly min: number; readonly max: number },
): KeyResult {
  const parsed = toInteger(raw)
  if (parsed === undefined) {
    return { value: fallback, warning: `"${key}" must be an integer; using default ${fallback}` }
  }
  if (parsed < range.min || parsed > range.max) {
    return {
      value: fallback,
      warning: `"${key}" must be between ${range.min} and ${range.max}; using default ${fallback}`,
    }
  }
  return { value: parsed }
}

/** Reads one prefix setting; leading and trailing whitespace are significant. */
function coercePrefix(key: 'triggerPrefix' | 'rawPrefix', raw: unknown, fallback: string): KeyResult {
  if (typeof raw !== 'string') {
    return { value: fallback, warning: `"${key}" must be a string; using default "${fallback}"` }
  }
  if (raw.startsWith('/') || raw.startsWith('!')) {
    return {
      value: fallback,
      warning: `"${key}" must not start with "/" or "!" (it clashes with slash commands and the shell); using default "${fallback}"`,
    }
  }
  return { value: raw }
}

/** Validates one setting value in isolation, per the documented rules. */
function validateKey(key: ConfigKey, raw: unknown): KeyResult {
  switch (key) {
    case 'enabled': {
      const parsed = toBoolean(raw)
      if (parsed === undefined) {
        return { value: DEFAULT_CONFIG.enabled, warning: `"enabled" must be a boolean; using default ${DEFAULT_CONFIG.enabled}` }
      }
      return { value: parsed }
    }
    case 'modelGuidance': {
      const parsed = toBoolean(raw)
      if (parsed === undefined) {
        return {
          value: DEFAULT_CONFIG.modelGuidance,
          warning: `"modelGuidance" must be a boolean; using default ${DEFAULT_CONFIG.modelGuidance}`,
        }
      }
      return { value: parsed }
    }
    case 'triggerMode': {
      if (raw === 'always' || raw === 'prefix' || raw === 'smart') return { value: raw }
      return {
        value: DEFAULT_CONFIG.triggerMode,
        warning: `"triggerMode" must be "always", "prefix" or "smart"; using default "${DEFAULT_CONFIG.triggerMode}"`,
      }
    }
    case 'triggerPrefix':
      return coercePrefix('triggerPrefix', raw, DEFAULT_CONFIG.triggerPrefix)
    case 'refinementLevel': {
      if (raw === 'quick' || raw === 'standard' || raw === 'deep') return { value: raw }
      return {
        value: DEFAULT_CONFIG.refinementLevel,
        warning: `"refinementLevel" must be "quick", "standard" or "deep"; using default "${DEFAULT_CONFIG.refinementLevel}"`,
      }
    }
    case 'rawPrefix':
      return coercePrefix('rawPrefix', raw, DEFAULT_CONFIG.rawPrefix)
    case 'uiMode': {
      if (raw === 'auto' || raw === 'pane' || raw === 'composer') return { value: raw }
      return {
        value: DEFAULT_CONFIG.uiMode,
        warning: `"uiMode" must be "auto", "pane" or "composer"; using default "${DEFAULT_CONFIG.uiMode}"`,
      }
    }
    case 'model': {
      if (typeof raw !== 'string') {
        return { value: DEFAULT_CONFIG.model, warning: `"model" must be a string; using default "${DEFAULT_CONFIG.model}"` }
      }
      const trimmed = raw.trim()
      if (trimmed === '') {
        return { value: DEFAULT_CONFIG.model, warning: `"model" must not be empty; using default "${DEFAULT_CONFIG.model}"` }
      }
      return { value: trimmed }
    }
    case 'maxTokens':
      return coerceNumber('maxTokens', raw, DEFAULT_CONFIG.maxTokens, MAX_TOKENS_RANGE)
    case 'timeoutMs':
      return coerceNumber('timeoutMs', raw, DEFAULT_CONFIG.timeoutMs, TIMEOUT_MS_RANGE)
    case 'maxRounds':
      return coerceNumber('maxRounds', raw, DEFAULT_CONFIG.maxRounds, MAX_ROUNDS_RANGE)
    case 'contextTurns':
      return coerceNumber('contextTurns', raw, DEFAULT_CONFIG.contextTurns, CONTEXT_TURNS_RANGE)
    case 'contextMaxChars':
      return coerceNumber('contextMaxChars', raw, DEFAULT_CONFIG.contextMaxChars, CONTEXT_MAX_CHARS_RANGE)
    case 'systemPromptFile': {
      if (typeof raw !== 'string') {
        return { value: DEFAULT_CONFIG.systemPromptFile, warning: '"systemPromptFile" must be a string; using no file' }
      }
      return { value: raw }
    }
    case 'pasteBypass': {
      const parsed = toBoolean(raw)
      if (parsed === undefined) {
        return { value: DEFAULT_CONFIG.pasteBypass, warning: `"pasteBypass" must be a boolean; using default ${DEFAULT_CONFIG.pasteBypass}` }
      }
      return { value: parsed }
    }
  }
}

/** Writes one validated value onto a mutable config object. */
function assign(config: OptimizerConfig, key: ConfigKey, value: OptimizerConfig[ConfigKey]): void {
  ;(config as unknown as Record<ConfigKey, unknown>)[key] = value
}

/** Whether one prefix is a prefix of the other, or they are equal. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/**
 * Settles the prefix pair after per-key validation.
 *
 * An empty `rawPrefix` disables the raw marker and never conflicts. An empty
 * `triggerPrefix` only bites in `prefix` mode. When the two markers overlap,
 * `rawPrefix` wins and `triggerPrefix` returns to its default; if the defaults
 * still overlap (the user chose a `rawPrefix` that swallows the default
 * trigger), both return to their defaults.
 */
function settlePrefixes(config: OptimizerConfig, warnings: string[]): void {
  if (config.triggerMode === 'prefix' && config.triggerPrefix === '') {
    config.triggerPrefix = DEFAULT_CONFIG.triggerPrefix
    warnings.push(`"triggerPrefix" must not be empty in prefix mode; using default "${DEFAULT_CONFIG.triggerPrefix}"`)
  }
  if (config.triggerPrefix === '' || config.rawPrefix === '') return
  if (!overlaps(config.triggerPrefix, config.rawPrefix)) return

  config.triggerPrefix = DEFAULT_CONFIG.triggerPrefix
  warnings.push(`"triggerPrefix" overlaps "rawPrefix"; using default "${DEFAULT_CONFIG.triggerPrefix}"`)
  if (overlaps(config.triggerPrefix, config.rawPrefix)) {
    config.rawPrefix = DEFAULT_CONFIG.rawPrefix
    warnings.push(
      `prefixes still overlap; using defaults "${DEFAULT_CONFIG.triggerPrefix}" and "${DEFAULT_CONFIG.rawPrefix}"`,
    )
  }
}

/**
 * Normalizes the loader's options into a valid {@link OptimizerConfig}.
 *
 * Missing keys and unknown keys are ignored; every present, known key is
 * validated, and each fallback it needed is reported once in `warnings`.
 */
export function resolveConfig(options: unknown): { config: OptimizerConfig; warnings: string[] } {
  const config: OptimizerConfig = { ...DEFAULT_CONFIG }
  const warnings: string[] = []

  if (!isRecord(options)) return { config, warnings }

  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) continue
    const result = validateKey(key, options[key])
    assign(config, key, result.value)
    if (result.warning !== undefined) warnings.push(result.warning)
  }

  settlePrefixes(config, warnings)
  return { config, warnings }
}

/**
 * Validates one runtime setting change (`/optimize model <id>`).
 *
 * Applies the same per-key rules as {@link resolveConfig}. Cross-key prefix
 * conflicts and the mode-dependent empty `triggerPrefix` are settled only by
 * `resolveConfig`, which sees the whole config.
 */
export function validateConfigChange(
  key: string,
  value: unknown,
): { ok: true; key: ConfigKey; value: OptimizerConfig[ConfigKey] } | { ok: false; error: string } {
  if (!isConfigKey(key)) return { ok: false, error: `unknown config key "${key}"` }
  const result = validateKey(key, value)
  if (result.warning !== undefined) return { ok: false, error: result.warning }
  return { ok: true, key, value: result.value }
}

/**
 * Expands a leading `~` against `home` without a shell.
 *
 * `~` and `~/...` expand; `~user`, a relative path, and an absolute path are
 * returned unchanged. With no known home, the path is returned unchanged.
 */
export function expandHome(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  return path
}

/** Best-effort message from a rejected read/stat. */
function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Reads the explicitly configured system prompt file, if any.
 *
 * An empty `systemPromptFile` reads nothing, not even a timer. `~` is expanded
 * with `$.env`'s `HOME` and read through `$.fs`; each read runs under the
 * round's preparation budget, and text beyond {@link SYSTEM_PROMPT_MAX_CHARS}
 * is dropped with a warning. An ordinary missing/unreadable file falls back to
 * the built-in prompt with a warning naming the file; a read that outlived the
 * budget is reported through `onDegraded` and returns no text.
 */
export async function loadSystemPromptExtra(
  $: EnginePorts,
  config: OptimizerConfig,
  options: PreparationCollectionOptions = {},
): Promise<{ text: string; warning?: string }> {
  const file = config.systemPromptFile
  if (file === '') return { text: '' }

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
    // An absolute or relative path needs no HOME lookup at all. A tilde path
    // must resolve HOME first; reading the literal `~` would be a wrong file.
    const needsHome = file === '~' || file.startsWith('~/')
    let home: string | undefined
    if (needsHome) {
      const homeResult = await budget.run('extra-home', async () => {
        try {
          return await $.env.get('HOME')
        } catch {
          return null
        }
      })
      if (homeResult.kind === 'cancelled') throw new PreparationCancelled()
      if (homeResult.kind !== 'ok') {
        // A timed-out, failed or unavailable lookup is already announced through
        // `onDegraded`; a second warning would duplicate the round's one notice.
        degraded('extra-home', homeResult.kind)
        return { text: '' }
      }
      if (homeResult.value == null || homeResult.value === '') {
        return {
          text: '',
          warning: `could not resolve the home directory for system prompt file "${file}"; using the built-in prompt`,
        }
      }
      home = homeResult.value
    }
    const path = expandHome(file, home)

    // Expected file failures are caught inside the task so they keep their
    // specific warning; only a budget failure reaches the degraded path.
    const stat = await budget.run('extra-stat', async () => {
      try {
        await $.fs.stat(path)
        return { ok: true as const }
      } catch (cause) {
        return { ok: false as const, message: describeError(cause) }
      }
    })
    if (stat.kind === 'cancelled') throw new PreparationCancelled()
    if (stat.kind !== 'ok') {
      degraded('extra-stat', stat.kind)
      return { text: '' }
    }
    if (!stat.value.ok) {
      return {
        text: '',
        warning: `could not read system prompt file "${path}" (${stat.value.message}); using the built-in prompt`,
      }
    }

    const read = await budget.run('extra-read', async () => {
      try {
        return { ok: true as const, text: await $.fs.read(path) }
      } catch (cause) {
        return { ok: false as const, message: describeError(cause) }
      }
    })
    if (read.kind === 'cancelled') throw new PreparationCancelled()
    if (read.kind !== 'ok') {
      degraded('extra-read', read.kind)
      return { text: '' }
    }
    if (!read.value.ok) {
      return {
        text: '',
        warning: `could not read system prompt file "${path}" (${read.value.message}); using the built-in prompt`,
      }
    }
    const raw = read.value.text

    if (raw.length > SYSTEM_PROMPT_MAX_CHARS) {
      return {
        text: raw.slice(0, SYSTEM_PROMPT_MAX_CHARS),
        warning: `system prompt file "${path}" is longer than ${SYSTEM_PROMPT_MAX_CHARS} characters; the extra text is ignored`,
      }
    }
    return { text: raw }
  } finally {
    if (ownsBudget) budget.dispose()
  }
}
