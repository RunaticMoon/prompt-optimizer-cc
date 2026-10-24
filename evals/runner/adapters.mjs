/**
 * Explicit live-adapter loading and response normalization.
 *
 * There is no default adapter, no shell execution and no credential lookup.
 * A live adapter is trusted local code imported by absolute path only after
 * the caller has validated the mode, caps and CI guard. This module caps the
 * adapter's logical `complete` invocations; it cannot cap opaque retries
 * inside a provider transport, which remains a documented limitation.
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_ADAPTER_BYTES = 1024 * 1024

/** A local adapter could not be loaded or has an invalid shape. */
export class AdapterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdapterError'
  }
}

/**
 * The adapter explicitly could not apply a request setting. The runner records
 * this as `unsupported`, never as a successful call.
 */
export class UnsupportedSettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsupportedSettingsError'
    this.code = 'unsupported-settings'
  }
}

/** SHA-256 of a file's bytes. */
export async function hashFile(filePath) {
  const source = await readFile(filePath)
  return createHash('sha256').update(source).digest('hex')
}

/**
 * Imports an explicitly named adapter module. The path must be absolute and a
 * regular non-symlink file under the size cap.
 */
export async function loadAdapter(adapterPath) {
  if (typeof adapterPath !== 'string' || adapterPath === '') {
    throw new AdapterError('adapter path must be a nonempty string')
  }
  if (!path.isAbsolute(adapterPath)) throw new AdapterError('adapter path must be absolute')
  const info = await lstat(adapterPath).catch(() => null)
  if (info === null) throw new AdapterError(`adapter does not exist: ${adapterPath}`)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AdapterError('adapter must be a regular file, not a symlink')
  }
  if (info.size > MAX_ADAPTER_BYTES) {
    throw new AdapterError(`adapter exceeds ${MAX_ADAPTER_BYTES} bytes`)
  }
  const resolved = await realpath(adapterPath)
  const hash = await hashFile(resolved)
  let module
  try {
    module = await import(pathToFileURL(resolved).href)
  } catch (cause) {
    throw new AdapterError(`could not import adapter: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const complete =
    typeof module.complete === 'function'
      ? module.complete
      : typeof module.default?.complete === 'function'
        ? module.default.complete
        : null
  if (complete === null) {
    throw new AdapterError('adapter must export complete(request, {signal})')
  }
  return {
    kind: 'trusted',
    path: adapterPath,
    identity: path.basename(adapterPath),
    hash,
    complete,
  }
}

/**
 * Calls an adapter once and validates the envelope. No retry, no fallback.
 * Adapter-provided error bodies are never returned to the caller.
 */
export async function callAdapter(adapter, request, { signal } = {}) {
  let response
  try {
    response = await adapter.complete(request, { signal })
  } catch (cause) {
    if (cause?.code === 'unsupported-settings' || cause instanceof UnsupportedSettingsError) {
      throw new UnsupportedSettingsError('adapter reported unsupported request settings')
    }
    throw cause
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new AdapterError('adapter response must be an object')
  }
  if (Array.isArray(response.unsupportedSettings) && response.unsupportedSettings.length > 0) {
    throw new UnsupportedSettingsError('adapter reported unsupported request settings')
  }
  if (typeof response.text !== 'string') {
    throw new AdapterError('adapter response is missing a text string')
  }
  return response
}

/**
 * Normalizes a live usage block. A missing block is `{known:false}` with null
 * counts, never a false zero. A partially supplied block is also
 * `{known:false}`: zero-filling the missing counts would dress unknown values
 * up as measured zeros.
 */
export function normalizeUsage(raw) {
  const source = raw?.counts ?? raw
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return { known: false, counts: null }
  }
  const keys = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]
  const counts = {}
  for (const key of keys) {
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) {
      return { known: false, counts: null }
    }
    counts[key] = source[key]
  }
  return { known: true, counts }
}

/**
 * Validates what a live adapter reports as applied. `settingsApplied` is an
 * observation: a mismatched maxTokens/effort/cache means the transport
 * silently dropped or changed a requested setting, and a missing
 * `settingsApplied` (or a missing key) means nothing proves the settings were
 * applied. Both fail as unsupported instead of being recorded as successful,
 * so a silent transport can never pass as a verified call.
 */
export function normalizeAppliedSettings(request, response) {
  const raw = response?.settingsApplied
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnsupportedSettingsError('adapter did not report settingsApplied for the request')
  }
  const expected = {
    maxTokens: request.maxTokens,
    effort: request.effort,
    cache: Array.isArray(request.prompt),
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new UnsupportedSettingsError(`adapter did not report whether ${key} was applied`)
    }
    if (raw[key] !== value) {
      throw new UnsupportedSettingsError(`adapter applied an unexpected ${key}`)
    }
  }
  return {
    known: true,
    values: {
      model: typeof raw.model === 'string' ? raw.model : null,
      maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : null,
      effort: typeof raw.effort === 'string' ? raw.effort : null,
      cache: typeof raw.cache === 'boolean' ? raw.cache : null,
      timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : null,
    },
  }
}
