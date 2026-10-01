import { describe, expect, test } from 'claude-code/testing'

import type {
  GuidanceProfile,
  ModelResolutionReason,
  TargetModelSnapshot,
} from '../hooks/contracts'
import { MODEL_PROFILE_BY_ID, normalizeTargetModel } from '../hooks/target-model'

function snap(
  raw: string | null,
  normalizedId: string | null,
  profile: GuidanceProfile,
  reason: ModelResolutionReason,
): TargetModelSnapshot {
  return { raw, normalizedId, profile, reason }
}

describe('normalizeTargetModel — allowlisted profiles', () => {
  const cases: ReadonlyArray<[input: string, id: string, profile: GuidanceProfile]> = [
    ['claude-fable-5-1', 'claude-fable-5-1', 'fable-5-1'],
    ['Claude Fable 5.1', 'claude-fable-5-1', 'fable-5-1'],
    ['claude-mythos-5-1', 'claude-mythos-5-1', 'fable-5-1'],
    ['claude-fable-5', 'claude-fable-5', 'fable-5'],
    ['claude-mythos-5', 'claude-mythos-5', 'fable-5'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5', 'opus-5-5'],
    ['Opus 5.5', 'claude-opus-5-5', 'opus-5-5'],
    ['claude-opus-5-5-20260901[1m]', 'claude-opus-5-5', 'opus-5-5'],
    ['claude-opus-5-5-20260901', 'claude-opus-5-5', 'opus-5-5'],
    ['claude-opus-5', 'claude-opus-5', 'opus-5'],
    ['Claude Opus 4.8', 'claude-opus-4-8', 'opus-4-8'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'sonnet-5-5'],
    ['Sonnet 5', 'claude-sonnet-5', 'sonnet-5'],
  ]

  for (const [input, id, profile] of cases) {
    test(`${JSON.stringify(input)} -> ${profile}`, () => {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, id, profile, 'matched'))
    })
  }

  test('the allowlist covers exactly the design profiles', () => {
    expect(new Set(Object.values(MODEL_PROFILE_BY_ID))).toStrictEqual(
      new Set<GuidanceProfile>([
        'fable-5-1',
        'fable-5',
        'opus-5-5',
        'opus-5',
        'opus-4-8',
        'sonnet-5-5',
        'sonnet-5',
      ]),
    )
  })

  test('the allowlist is frozen against accidental mutation', () => {
    expect(Object.isFrozen(MODEL_PROFILE_BY_ID)).toBe(true)
  })
})

describe('normalizeTargetModel — aliases without a version', () => {
  const aliases = ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'OPUS[1m]', 'MyThOs', 'claude-sonnet']

  for (const input of aliases) {
    test(`${JSON.stringify(input)} -> common/alias`, () => {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, null, 'common', 'alias'))
    })
  }
})

describe('normalizeTargetModel — valid grammar outside the allowlist', () => {
  const cases: ReadonlyArray<[input: string, id: string]> = [
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-opus-5-6', 'claude-opus-5-6'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['opus-5-50', 'claude-opus-5-50'],
    ['fable-7-2', 'claude-fable-7-2'],
  ]

  for (const [input, id] of cases) {
    test(`${JSON.stringify(input)} -> ${id} common/unlisted`, () => {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, id, 'common', 'unlisted'))
    })
  }
})

describe('normalizeTargetModel — rejected grammar', () => {
  const inputs = [
    'opusplan',
    'default',
    'claude-opus-5-5-preview',
    'foo-claude-opus-5-5',
    'claude-opus-5-5x',
    'claude-claude-5',
    'sonnet-opus-5',
    'claude-opus-5-5-2026',
    '[2m]opus',
    'claude/opus-5-5',
    'claude-opus-5.5.1',
    'claude',
  ]

  for (const input of inputs) {
    test(`${JSON.stringify(input)} -> common/unknown`, () => {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, null, 'common', 'unknown'))
    })
  }
})

describe('normalizeTargetModel — empty and non-string input', () => {
  test('blank strings keep the original and report empty', () => {
    for (const input of ['', '   ', '\t']) {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, null, 'common', 'empty'))
    }
  })

  test('non-strings have no raw and report empty', () => {
    for (const input of [null, undefined, 42, 5.5, true, {}, [], Symbol('opus')]) {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(null, null, 'common', 'empty'))
    }
  })
})

describe('normalizeTargetModel — guard rails', () => {
  test('a string longer than 256 code units is refused whole', () => {
    const long = 'a'.repeat(257)
    expect(normalizeTargetModel(long)).toStrictEqual(snap(long, null, 'common', 'unknown'))
  })

  test('control characters anywhere in the raw string are refused', () => {
    for (const input of ['claude-opus-5-5\n', '\u0000opus', 'claude\topus-5-5']) {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, null, 'common', 'unknown'))
    }
  })

  test('C1 control characters are refused whole, preserving the raw value', () => {
    for (const input of ['claude-opus-5-5\u0085', '\u0080opus', 'claude\u009fopus-5-5']) {
      expect(normalizeTargetModel(input)).toStrictEqual(snap(input, null, 'common', 'unknown'))
      expect(normalizeTargetModel(input).raw).toBe(input)
    }
  })
})

describe('normalizeTargetModel — raw is preserved verbatim', () => {
  const inputs = [
    'claude-opus-5-5[1m]',
    'CLAUDE-OPUS-5-5',
    '  Claude Fable 5.1  ',
    'claude-opus-5-5-20260901[1m]',
    'OPUS[1m]',
    'opusplan',
    '   ',
    'a'.repeat(257),
  ]

  for (const input of inputs) {
    test(`raw stays ${JSON.stringify(input.slice(0, 24))}`, () => {
      expect(normalizeTargetModel(input).raw).toBe(input)
    })
  }

  test('the raw value is never mutated or trimmed in the snapshot', () => {
    const input = '  Claude Opus 4.8  '
    const result = normalizeTargetModel(input)
    expect(result.raw).toBe(input)
    expect(result.normalizedId).toBe('claude-opus-4-8')
  })
})
