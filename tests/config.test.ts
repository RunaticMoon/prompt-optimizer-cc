import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { OptimizerConfig } from '../hooks/contracts'
import { DEFAULT_CONFIG, SYSTEM_PROMPT_MAX_CHARS } from '../hooks/contracts'
import {
  expandHome,
  loadSystemPromptExtra,
  resolveConfig,
  validateConfigChange,
} from '../hooks/config'

/** A stand-in engine exposing only the `$.fs` / `$.env` members the loader uses. */
interface FakeEngineOptions {
  home?: string | undefined
  files?: Record<string, string>
  statError?: Error
  readError?: Error
  onStat?: (path: string) => void
  onRead?: (path: string) => void
}

function fakeEngine(options: FakeEngineOptions = {}): EngineInterface {
  const files = options.files ?? {}
  const engine = {
    env: {
      get: async (name: string) => (name === 'HOME' ? options.home : undefined),
    },
    fs: {
      stat: async (path: string) => {
        options.onStat?.(path)
        if (options.statError !== undefined) throw options.statError
        const content = files[path]
        if (content === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
        return { kind: 'file' as const, size: content.length, mtimeMs: 0, isLink: false }
      },
      read: async (path: string) => {
        options.onRead?.(path)
        if (options.readError !== undefined) throw options.readError
        const content = files[path]
        if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return content
      },
    },
  }
  return engine as unknown as EngineInterface
}

function configWith(over: Partial<OptimizerConfig>): OptimizerConfig {
  return { ...DEFAULT_CONFIG, ...over }
}

describe('resolveConfig — whole-options shapes', () => {
  test('undefined, null and non-objects fall back to defaults without warnings', () => {
    for (const options of [undefined, null, 'nope', 42, true]) {
      const { config, warnings } = resolveConfig(options)
      expect(config).toEqual(DEFAULT_CONFIG)
      expect(warnings).toEqual([])
    }
  })

  test('an array is not an options object', () => {
    const { config, warnings } = resolveConfig(['enabled', false])
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnings).toEqual([])
  })

  test('an empty object yields the defaults', () => {
    const { config, warnings } = resolveConfig({})
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnings).toEqual([])
  })

  test('unknown keys are ignored and add no warning', () => {
    const { config, warnings } = resolveConfig({ notion: 'x', enabled: true, extra: 1 })
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnings).toEqual([])
  })
})

describe('resolveConfig — enabled', () => {
  test('accepts a boolean', () => {
    expect(resolveConfig({ enabled: false }).config.enabled).toBe(false)
    expect(resolveConfig({ enabled: true }).config.enabled).toBe(true)
  })

  test('coerces the string spellings the config UI writes', () => {
    expect(resolveConfig({ enabled: 'true' }).config.enabled).toBe(true)
    expect(resolveConfig({ enabled: 'false' }).config.enabled).toBe(false)
  })

  test('falls back on any other value with one warning', () => {
    for (const value of ['yes', 1, 0, null, undefined, ['true']]) {
      const { config, warnings } = resolveConfig({ enabled: value })
      expect(config.enabled).toBe(DEFAULT_CONFIG.enabled)
      expect(warnings).toHaveLength(1)
    }
  })
})

describe('resolveConfig — modelGuidance', () => {
  test('defaults to true (matching the manifest default)', () => {
    expect(DEFAULT_CONFIG.modelGuidance).toBe(true)
    expect(resolveConfig({}).config.modelGuidance).toBe(true)
    expect(resolveConfig(undefined).config.modelGuidance).toBe(true)
  })

  test('accepts a boolean', () => {
    expect(resolveConfig({ modelGuidance: false }).config.modelGuidance).toBe(false)
    expect(resolveConfig({ modelGuidance: true }).config.modelGuidance).toBe(true)
  })

  test('coerces the string spellings the config UI writes', () => {
    expect(resolveConfig({ modelGuidance: 'true' }).config.modelGuidance).toBe(true)
    expect(resolveConfig({ modelGuidance: 'false' }).config.modelGuidance).toBe(false)
  })

  test('falls back on any other value with one warning', () => {
    for (const value of ['maybe', 3, 'yes', 1, 0, null, undefined, ['true']]) {
      const { config, warnings } = resolveConfig({ modelGuidance: value })
      expect(config.modelGuidance).toBe(DEFAULT_CONFIG.modelGuidance)
      expect(warnings).toHaveLength(1)
    }
  })
})

describe('resolveConfig — enums', () => {
  test('triggerMode accepts only its two values', () => {
    expect(resolveConfig({ triggerMode: 'prefix' }).config.triggerMode).toBe('prefix')
    expect(resolveConfig({ triggerMode: 'always' }).config.triggerMode).toBe('always')
    for (const value of ['sometimes', '', 1, null]) {
      const { config, warnings } = resolveConfig({ triggerMode: value })
      expect(config.triggerMode).toBe(DEFAULT_CONFIG.triggerMode)
      expect(warnings).toHaveLength(1)
    }
  })

  test('uiMode accepts only auto, pane and composer', () => {
    for (const value of ['auto', 'pane', 'composer'] as const) {
      expect(resolveConfig({ uiMode: value }).config.uiMode).toBe(value)
    }
    for (const value of ['pane2', '', 0, null]) {
      const { config, warnings } = resolveConfig({ uiMode: value })
      expect(config.uiMode).toBe(DEFAULT_CONFIG.uiMode)
      expect(warnings).toHaveLength(1)
    }
  })
})

describe('resolveConfig — model', () => {
  test('trims surrounding whitespace', () => {
    expect(resolveConfig({ model: '  opus  ' }).config.model).toBe('opus')
  })

  test('falls back for empty, whitespace-only and non-string values', () => {
    for (const value of ['', '   ', 42, null, ['haiku']]) {
      const { config, warnings } = resolveConfig({ model: value })
      expect(config.model).toBe(DEFAULT_CONFIG.model)
      expect(warnings).toHaveLength(1)
    }
  })
})

describe('resolveConfig — numeric ranges', () => {
  const cases: Array<{
    key: 'maxTokens' | 'timeoutMs' | 'maxRounds' | 'contextTurns' | 'contextMaxChars'
    min: number
    max: number
  }> = [
    { key: 'maxTokens', min: 128, max: 2048 },
    { key: 'timeoutMs', min: 1000, max: 30000 },
    { key: 'maxRounds', min: 1, max: 5 },
    { key: 'contextTurns', min: 0, max: 8 },
    { key: 'contextMaxChars', min: 0, max: 8000 },
  ]

  for (const { key, min, max } of cases) {
    test(`${key} accepts its inclusive boundaries`, () => {
      expect(resolveConfig({ [key]: min }).config[key]).toBe(min)
      expect(resolveConfig({ [key]: max }).config[key]).toBe(max)
      // Boundary values arriving as strings take the same path.
      expect(resolveConfig({ [key]: String(min) }).config[key]).toBe(min)
      expect(resolveConfig({ [key]: String(max) }).config[key]).toBe(max)
    })

    test(`${key} falls back outside its range with one warning`, () => {
      for (const value of [min - 1, max + 1]) {
        const { config, warnings } = resolveConfig({ [key]: value })
        expect(config[key]).toBe(DEFAULT_CONFIG[key])
        expect(warnings).toHaveLength(1)
      }
    })

    test(`${key} falls back on non-integer values with one warning`, () => {
      for (const value of [min + 0.5, `${min}.5`, 'abc', '', true, null, [min]]) {
        const { config, warnings } = resolveConfig({ [key]: value })
        expect(config[key]).toBe(DEFAULT_CONFIG[key])
        expect(warnings).toHaveLength(1)
      }
    })
  }
})

describe('resolveConfig — prefixes', () => {
  test('accepts custom prefixes verbatim, keeping trailing whitespace', () => {
    const { config, warnings } = resolveConfig({ triggerMode: 'prefix', triggerPrefix: '>> ', rawPrefix: '## ' })
    expect(config.triggerPrefix).toBe('>> ')
    expect(config.rawPrefix).toBe('## ')
    expect(warnings).toEqual([])
  })

  test('does not strip leading whitespace', () => {
    const { config } = resolveConfig({ triggerPrefix: ' ?? ' })
    expect(config.triggerPrefix).toBe(' ?? ')
  })

  test('rejects a prefix starting with "/" or "!"', () => {
    for (const value of ['/opt ', '!raw ']) {
      const trigger = resolveConfig({ triggerMode: 'prefix', triggerPrefix: value })
      expect(trigger.config.triggerPrefix).toBe(DEFAULT_CONFIG.triggerPrefix)
      expect(trigger.warnings).toHaveLength(1)

      const raw = resolveConfig({ rawPrefix: value })
      expect(raw.config.rawPrefix).toBe(DEFAULT_CONFIG.rawPrefix)
      expect(raw.warnings).toHaveLength(1)
    }
  })

  test('falls back on a non-string prefix', () => {
    const { config, warnings } = resolveConfig({ rawPrefix: 7 })
    expect(config.rawPrefix).toBe(DEFAULT_CONFIG.rawPrefix)
    expect(warnings).toHaveLength(1)
  })

  test('lets rawPrefix win when triggerPrefix is its prefix', () => {
    const { config, warnings } = resolveConfig({ triggerMode: 'prefix', triggerPrefix: '::', rawPrefix: '::raw ' })
    expect(config.triggerPrefix).toBe(DEFAULT_CONFIG.triggerPrefix)
    expect(config.rawPrefix).toBe('::raw ')
    expect(warnings).toHaveLength(1)
  })

  test('lets rawPrefix win when the two are equal', () => {
    const { config, warnings } = resolveConfig({ triggerMode: 'prefix', triggerPrefix: '::raw ', rawPrefix: '::raw ' })
    expect(config.triggerPrefix).toBe(DEFAULT_CONFIG.triggerPrefix)
    expect(config.rawPrefix).toBe('::raw ')
    expect(warnings).toHaveLength(1)
  })

  test('resets both when the default trigger still collides with rawPrefix', () => {
    // rawPrefix "?? " equals the default trigger prefix, so the pair resets.
    const { config, warnings } = resolveConfig({ triggerMode: 'prefix', triggerPrefix: '??', rawPrefix: '?? ' })
    expect(config.triggerPrefix).toBe(DEFAULT_CONFIG.triggerPrefix)
    expect(config.rawPrefix).toBe(DEFAULT_CONFIG.rawPrefix)
    expect(warnings).toHaveLength(2)
  })

  test('an empty rawPrefix disables the marker without conflicting', () => {
    const { config, warnings } = resolveConfig({ triggerMode: 'prefix', triggerPrefix: '?? ', rawPrefix: '' })
    expect(config.rawPrefix).toBe('')
    expect(config.triggerPrefix).toBe('?? ')
    expect(warnings).toEqual([])
  })

  test('an empty triggerPrefix is invalid in prefix mode but harmless in always mode', () => {
    const prefix = resolveConfig({ triggerMode: 'prefix', triggerPrefix: '' })
    expect(prefix.config.triggerPrefix).toBe(DEFAULT_CONFIG.triggerPrefix)
    expect(prefix.warnings).toHaveLength(1)

    const always = resolveConfig({ triggerMode: 'always', triggerPrefix: '', rawPrefix: '::raw ' })
    expect(always.config.triggerPrefix).toBe('')
    expect(always.warnings).toEqual([])
  })
})

describe('resolveConfig — systemPromptFile', () => {
  test('accepts any string, empty included', () => {
    expect(resolveConfig({ systemPromptFile: '' }).config.systemPromptFile).toBe('')
    expect(resolveConfig({ systemPromptFile: '~/notes.md' }).config.systemPromptFile).toBe('~/notes.md')
  })

  test('falls back on a non-string value', () => {
    const { config, warnings } = resolveConfig({ systemPromptFile: 5 })
    expect(config.systemPromptFile).toBe(DEFAULT_CONFIG.systemPromptFile)
    expect(warnings).toHaveLength(1)
  })
})

describe('validateConfigChange', () => {
  test('returns the coerced value for a valid single change', () => {
    expect(validateConfigChange('model', '  opus  ')).toEqual({ ok: true, key: 'model', value: 'opus' })
    expect(validateConfigChange('enabled', 'false')).toEqual({ ok: true, key: 'enabled', value: false })
    expect(validateConfigChange('modelGuidance', false)).toEqual({ ok: true, key: 'modelGuidance', value: false })
    expect(validateConfigChange('modelGuidance', 'true')).toEqual({ ok: true, key: 'modelGuidance', value: true })
    expect(validateConfigChange('maxTokens', '2048')).toEqual({ ok: true, key: 'maxTokens', value: 2048 })
    expect(validateConfigChange('maxTokens', 128)).toEqual({ ok: true, key: 'maxTokens', value: 128 })
  })

  test('rejects an unknown key', () => {
    expect(validateConfigChange('bogus', 1)).toEqual({ ok: false, error: 'unknown config key "bogus"' })
  })

  test('rejects values that would fall back', () => {
    for (const [key, value] of [
      ['maxTokens', 99],
      ['model', ''],
      ['enabled', 'maybe'],
      ['modelGuidance', 'maybe'],
      ['modelGuidance', 3],
      ['triggerMode', 'sometimes'],
      ['triggerPrefix', '/x'],
      ['rawPrefix', '!x'],
    ] as const) {
      const result = validateConfigChange(key, value)
      expect(result.ok).toBe(false)
    }
  })

  test('accepts an empty rawPrefix (disables the marker)', () => {
    expect(validateConfigChange('rawPrefix', '')).toEqual({ ok: true, key: 'rawPrefix', value: '' })
  })
})

describe('expandHome', () => {
  test('expands a bare ~ to the home directory', () => {
    expect(expandHome('~', '/home/tester')).toBe('/home/tester')
  })

  test('expands a leading ~/ against the home directory', () => {
    expect(expandHome('~/notes.md', '/home/tester')).toBe('/home/tester/notes.md')
  })

  test('leaves absolute and relative paths alone', () => {
    expect(expandHome('/etc/hosts', '/home/tester')).toBe('/etc/hosts')
    expect(expandHome('notes.md', '/home/tester')).toBe('notes.md')
    expect(expandHome('./notes.md', '/home/tester')).toBe('./notes.md')
  })

  test('does not expand ~user', () => {
    expect(expandHome('~other/notes.md', '/home/tester')).toBe('~other/notes.md')
  })

  test('returns the path unchanged when home is unknown', () => {
    expect(expandHome('~/notes.md', undefined)).toBe('~/notes.md')
    expect(expandHome('~', undefined)).toBe('~')
  })
})

describe('loadSystemPromptExtra', () => {
  test('reads nothing when no file is configured', async () => {
    let touched = false
    const $ = fakeEngine({ onStat: () => (touched = true), onRead: () => (touched = true) })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '' }))
    expect(result).toEqual({ text: '' })
    expect(touched).toBe(false)
  })

  test('reads a configured file', async () => {
    const $ = fakeEngine({ files: { '/etc/prompt.md': 'extra instructions' } })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '/etc/prompt.md' }))
    expect(result).toEqual({ text: 'extra instructions' })
  })

  test('expands ~ with HOME before reading', async () => {
    const paths: string[] = []
    const $ = fakeEngine({
      home: '/home/tester',
      files: { '/home/tester/.claude/prompt-optimizer/system-prompt.md': 'from home' },
      onStat: path => paths.push(path),
    })
    const result = await loadSystemPromptExtra(
      $,
      configWith({ systemPromptFile: '~/.claude/prompt-optimizer/system-prompt.md' }),
    )
    expect(result.text).toBe('from home')
    expect(paths).toEqual(['/home/tester/.claude/prompt-optimizer/system-prompt.md'])
  })

  test('truncates a file past the cap and warns', async () => {
    const over = SYSTEM_PROMPT_MAX_CHARS + 50
    const $ = fakeEngine({ files: { '/big.md': 'x'.repeat(over) } })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '/big.md' }))
    expect(result.text).toHaveLength(SYSTEM_PROMPT_MAX_CHARS)
    expect(result.warning).toBeDefined()
  })

  test('keeps a file exactly at the cap without a warning', async () => {
    const $ = fakeEngine({ files: { '/exact.md': 'y'.repeat(SYSTEM_PROMPT_MAX_CHARS) } })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '/exact.md' }))
    expect(result.text).toHaveLength(SYSTEM_PROMPT_MAX_CHARS)
    expect(result.warning).toBeUndefined()
  })

  test('warns and uses no extra prompt when the file is missing', async () => {
    const $ = fakeEngine({ files: {} })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '/missing.md' }))
    expect(result.text).toBe('')
    expect(result.warning).toContain('built-in prompt')
  })

  test('warns and uses no extra prompt when stat fails', async () => {
    const $ = fakeEngine({ statError: new Error('EACCES: permission denied') })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '/locked.md' }))
    expect(result.text).toBe('')
    expect(result.warning).toContain('built-in prompt')
  })

  test('warns and uses no extra prompt when the read fails', async () => {
    const $ = fakeEngine({ files: { '/broken.md': 'text' }, readError: new Error('EIO: i/o error') })
    const result = await loadSystemPromptExtra($, configWith({ systemPromptFile: '/broken.md' }))
    expect(result.text).toBe('')
    expect(result.warning).toContain('built-in prompt')
  })
})
