import { describe, expect, test } from 'claude-code/testing'

import { PROMPT_CACHE_MIN_VERSION, supportsPromptCache } from '../hooks/engine-version'

describe('supportsPromptCache', () => {
  test('accepts the minimum version and everything above it', () => {
    expect(supportsPromptCache('2.1.292')).toBe(true)
    expect(supportsPromptCache('2.1.293')).toBe(true)
    expect(supportsPromptCache('2.2.0')).toBe(true)
    expect(supportsPromptCache('3.0.0')).toBe(true)
    expect(supportsPromptCache('2.10.0')).toBe(true)
  })

  test('refuses versions below the minimum', () => {
    expect(supportsPromptCache('2.1.291')).toBe(false)
    expect(supportsPromptCache('2.0.999')).toBe(false)
    expect(supportsPromptCache('1.99.99')).toBe(false)
    expect(supportsPromptCache('2.1.0')).toBe(false)
  })

  test('reads the first triple in a development build', () => {
    expect(supportsPromptCache('2.1.292-dev.20260920.t101500.sha1a2b3c4')).toBe(true)
    expect(supportsPromptCache('2.1.291-dev.20260920.t101500.sha1a2b3c4')).toBe(false)
  })

  test('treats a missing or unparseable version as unsupported', () => {
    expect(supportsPromptCache(undefined)).toBe(false)
    expect(supportsPromptCache('')).toBe(false)
    expect(supportsPromptCache('dev')).toBe(false)
    expect(supportsPromptCache('2.1')).toBe(false)
    expect(supportsPromptCache('v2.x.292')).toBe(false)
  })

  test('names the minimum version the runtime gates on', () => {
    expect(PROMPT_CACHE_MIN_VERSION).toBe('2.1.292')
  })
})
