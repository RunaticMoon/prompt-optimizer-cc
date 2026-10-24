/**
 * Test-only fake adapter: zero network, zero credentials.
 *
 * Behavior is selected by POPT_FAKE_ADAPTER_MODE (ok, refuse, malformed,
 * unsupported, no-usage, no-settings, partial-settings, slow). Calls may be
 * logged as JSONL to the temporary path in POPT_FAKE_ADAPTER_LOG. This file is
 * never a production transport.
 */

import { appendFile } from 'node:fs/promises'

const REPLY = { draft: 'fake draft', message: '가짜 응답입니다.', question: null, options: [] }

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

export async function complete(request, { signal } = {}) {
  const log = process.env.POPT_FAKE_ADAPTER_LOG
  if (typeof log === 'string' && log !== '') {
    await appendFile(
      log,
      `${JSON.stringify({
        model: request.model,
        maxTokens: request.maxTokens,
        effort: request.effort,
        timeoutMs: request.timeoutMs,
        cachedPrompt: Array.isArray(request.prompt),
      })}\n`,
    )
  }
  const mode = process.env.POPT_FAKE_ADAPTER_MODE ?? 'ok'
  if (mode === 'refuse') throw new Error('fake adapter refused this call')
  if (mode === 'unsupported') {
    throw Object.assign(new Error('fake adapter cannot apply effort'), { code: 'unsupported-settings' })
  }
  if (mode === 'malformed') return { text: 42 }
  if (mode === 'slow') await delay(400, signal)
  const enrichment =
    mode === 'no-usage'
      ? {}
      : {
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
        }
  const settingsApplied =
    mode === 'no-settings'
      ? undefined
      : mode === 'partial-settings'
        ? { model: request.model, maxTokens: request.maxTokens }
        : {
            model: request.model,
            maxTokens: request.maxTokens,
            effort: request.effort,
            cache: Array.isArray(request.prompt),
          }
  return {
    text: JSON.stringify(REPLY),
    modelId: 'fake-model-1',
    provider: 'fake-provider',
    settingsApplied,
    ...enrichment,
  }
}
