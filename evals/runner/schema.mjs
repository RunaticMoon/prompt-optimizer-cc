/**
 * Case schema v1: strict, dependency-free validation and loading.
 *
 * One JSON file per case lives under `<suiteRoot>/cases` (development) or
 * `<suiteRoot>/holdout` (holdout). Unknown fields fail, so a typo cannot turn
 * into an ignored setting. The loader treats the suite directory as fixed
 * root: only regular `.json` files directly inside it are read, never
 * symlinks, traversal or files above the per-case size cap.
 *
 * This module never imports a hook, a model module or a transport.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

export const CASE_SCHEMA_VERSION = 1
export const MAX_CASE_FILES = 128
export const MAX_CASE_BYTES = 128 * 1024
export const MAX_ORIGINAL_CHARS = 6000
export const MAX_CONTEXT_CHARS = 6000
export const MAX_HISTORY_TURNS = 64
export const MAX_ANSWERS = 5
export const MAX_MOCK_RESPONSES = 8
export const MAX_CONSTRAINTS = 12
export const MAX_RULES = 20
export const MAX_TAGS = 8

export const SPLITS = ['development', 'holdout']
export const GUIDANCE_PROFILES = [
  'common',
  'fable-5-1',
  'fable-5',
  'opus-5-5',
  'opus-5',
  'opus-4-8',
  'sonnet-5-5',
  'sonnet-5',
]
export const PROVENANCE_KINDS = ['synthetic-reconstruction', 'synthetic-authored']
export const CONSTRAINT_KINDS = ['mustPreserve', 'mustNotInfer', 'mustInclude']
export const SEVERITIES = ['critical', 'major', 'minor']
export const RULE_KINDS = [
  'includes',
  'excludes',
  'questionNull',
  'questionPresent',
  'maxOptions',
  'jsonContract',
]
export const RULE_FIELDS = ['draft', 'message', 'question', 'options']

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CASE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.json$/

/** An error naming the file, case id and field, never dumping the payload. */
export class CaseValidationError extends Error {
  constructor(message, { file = null, caseId = null, field = null } = {}) {
    const where = [file, caseId === null ? null : `case "${caseId}"`, field].filter(Boolean).join(' ')
    super(where === '' ? message : `${where}: ${message}`)
    this.name = 'CaseValidationError'
    this.file = file
    this.caseId = caseId
    this.field = field
  }
}

/** True when a string is well-formed Unicode (no lone surrogates). */
export function isWellFormed(text) {
  if (typeof text !== 'string') return false
  if (typeof text.isWellFormed === 'function') return text.isWellFormed()
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
}

/** Stable JSON: object keys sorted recursively, array order preserved. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function makeChecker(fail) {
  function text(value, field, { min = 1, max = 2000, pattern = null, label = 'string' } = {}) {
    if (typeof value !== 'string') fail(field, `expected ${label}`)
    if (!isWellFormed(value)) fail(field, 'string is not valid Unicode')
    if (/[\u0000]/.test(value)) fail(field, 'string contains NUL')
    const length = [...value].length
    if (length < min) fail(field, `string is shorter than ${min} character(s)`)
    if (length > max) fail(field, `string is longer than ${max} characters`)
    if (pattern !== null && !pattern.test(value)) fail(field, 'string has an invalid format')
    return value
  }

  function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, 'expected an integer')
    if (value < min || value > max) fail(field, `expected an integer between ${min} and ${max}`)
    return value
  }

  function boolean(value, field) {
    if (typeof value !== 'boolean') fail(field, 'expected a boolean')
    return value
  }

  function object(value, field, allowed, required) {
    if (!isPlainObject(value)) fail(field, 'expected an object')
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(field === '' ? key : `${field}.${key}`, 'unknown field')
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        fail(field === '' ? key : `${field}.${key}`, 'missing required field')
      }
    }
    return value
  }

  function array(value, field, { min = 0, max = Infinity } = {}) {
    if (!Array.isArray(value)) fail(field, 'expected an array')
    if (value.length < min || value.length > max) {
      fail(field, `expected between ${min} and ${max} item(s)`)
    }
    return value
  }

  function enumValue(value, field, allowed) {
    if (!allowed.includes(value)) fail(field, `expected one of: ${allowed.join(', ')}`)
    return value
  }

  return { text, integer, boolean, object, array, enumValue }
}

/** Validates one parsed case and returns a normalized, frozen copy. */
export function validateCase(value, { file = null, split = null } = {}) {
  const caseId = isPlainObject(value) && typeof value.id === 'string' ? value.id : null
  const fail = (field, message) => {
    throw new CaseValidationError(message, { file, caseId, field })
  }
  const check = makeChecker(fail)

  check.object(
    value,
    '',
    [
      'schemaVersion',
      'id',
      'split',
      'tags',
      'provenance',
      'original',
      'context',
      'initialDialogue',
      'initialDraft',
      'roundsCompleted',
      'settings',
      'answers',
      'constraints',
      'rules',
      'mockResponses',
    ],
    [
      'schemaVersion',
      'id',
      'split',
      'provenance',
      'original',
      'context',
      'initialDialogue',
      'initialDraft',
      'roundsCompleted',
      'settings',
      'answers',
      'constraints',
      'rules',
      'mockResponses',
    ],
  )

  check.integer(value.schemaVersion, 'schemaVersion', {
    min: CASE_SCHEMA_VERSION,
    max: CASE_SCHEMA_VERSION,
  })
  const id = check.text(value.id, 'id', { min: 1, max: 64, pattern: ID_PATTERN })
  const caseSplit = check.enumValue(value.split, 'split', SPLITS)
  if (split !== null && caseSplit !== split) {
    fail('split', `case split "${caseSplit}" does not match the selected "${split}" suite`)
  }

  const tags = value.tags === undefined
    ? []
    : check.array(value.tags, 'tags', { min: 1, max: MAX_TAGS }).map((tag, index) =>
        check.text(tag, `tags[${index}]`, { min: 1, max: 32, pattern: TAG_PATTERN }),
      )

  check.object(value.provenance, 'provenance', ['kind', 'source'], ['kind', 'source'])
  const provenance = {
    kind: check.enumValue(value.provenance.kind, 'provenance.kind', PROVENANCE_KINDS),
    source: check.text(value.provenance.source, 'provenance.source', { min: 1, max: 300 }),
  }

  const original = check.text(value.original, 'original', { min: 1, max: MAX_ORIGINAL_CHARS })

  check.object(value.context, 'context', ['text'], ['text'])
  const contextText = check.text(value.context.text, 'context.text', {
    min: 0,
    max: MAX_CONTEXT_CHARS,
  })

  const initialDialogue = check
    .array(value.initialDialogue, 'initialDialogue', { min: 0, max: MAX_HISTORY_TURNS })
    .map((turn, index) => {
      const field = `initialDialogue[${index}]`
      check.object(turn, field, ['role', 'text'], ['role', 'text'])
      return {
        role: check.enumValue(turn.role, `${field}.role`, ['user', 'optimizer']),
        text: check.text(turn.text, `${field}.text`, { min: 1, max: 4000 }),
      }
    })

  const initialDraft = check.text(value.initialDraft, 'initialDraft', {
    min: 0,
    max: MAX_ORIGINAL_CHARS,
  })

  check.object(
    value.settings,
    'settings',
    ['guidanceProfile', 'maxRounds', 'maxTokens', 'timeoutMs', 'cache'],
    ['guidanceProfile', 'maxRounds', 'maxTokens', 'timeoutMs', 'cache'],
  )
  const settings = {
    guidanceProfile: check.enumValue(
      value.settings.guidanceProfile,
      'settings.guidanceProfile',
      GUIDANCE_PROFILES,
    ),
    maxRounds: check.integer(value.settings.maxRounds, 'settings.maxRounds', { min: 1, max: 5 }),
    maxTokens: check.integer(value.settings.maxTokens, 'settings.maxTokens', {
      min: 128,
      max: 2048,
    }),
    timeoutMs: check.integer(value.settings.timeoutMs, 'settings.timeoutMs', {
      min: 1000,
      max: 30000,
    }),
    cache: check.boolean(value.settings.cache, 'settings.cache'),
  }

  const roundsCompleted = check.integer(value.roundsCompleted, 'roundsCompleted', {
    min: 0,
    max: MAX_HISTORY_TURNS,
  })
  if (roundsCompleted > settings.maxRounds) {
    fail('roundsCompleted', 'cannot exceed settings.maxRounds')
  }
  const remainingRounds = settings.maxRounds - roundsCompleted

  const answers = check
    .array(value.answers, 'answers', { min: 0, max: MAX_ANSWERS })
    .map((answer, index) => {
      const field = `answers[${index}]`
      check.object(answer, field, ['text', 'when'], ['text'])
      const when = answer.when
      if (when !== undefined) {
        check.object(when, `${field}.when`, ['questionIncludes', 'option1Includes'], [])
        if (Object.keys(when).length === 0) fail(`${field}.when`, 'expected at least one condition')
        if (when.questionIncludes !== undefined) {
          check.text(when.questionIncludes, `${field}.when.questionIncludes`, { min: 1, max: 200 })
        }
        if (when.option1Includes !== undefined) {
          check.text(when.option1Includes, `${field}.when.option1Includes`, { min: 1, max: 200 })
        }
      }
      return {
        text: check.text(answer.text, `${field}.text`, { min: 1, max: 2000 }),
        ...(when === undefined
          ? {}
          : {
              when: {
                ...(when.questionIncludes === undefined
                  ? {}
                  : { questionIncludes: when.questionIncludes }),
                ...(when.option1Includes === undefined
                  ? {}
                  : { option1Includes: when.option1Includes }),
              },
            }),
      }
    })
  if (answers.length > Math.max(0, remainingRounds - 1)) {
    fail('answers', 'more answers than the available new rounds can ask questions for')
  }

  const constraintIds = new Set()
  const constraints = check
    .array(value.constraints, 'constraints', { min: 1, max: MAX_CONSTRAINTS })
    .map((constraint, index) => {
      const field = `constraints[${index}]`
      check.object(
        constraint,
        field,
        ['id', 'kind', 'description', 'severity', 'literals'],
        ['id', 'kind', 'description', 'severity'],
      )
      const constraintId = check.text(constraint.id, `${field}.id`, {
        min: 1,
        max: 64,
        pattern: ID_PATTERN,
      })
      if (constraintIds.has(constraintId)) fail(`${field}.id`, 'duplicate constraint id')
      constraintIds.add(constraintId)
      const literals = constraint.literals === undefined
        ? []
        : check
            .array(constraint.literals, `${field}.literals`, { min: 1, max: 8 })
            .map((literal, literalIndex) =>
              check.text(literal, `${field}.literals[${literalIndex}]`, { min: 1, max: 200 }),
            )
      return {
        id: constraintId,
        kind: check.enumValue(constraint.kind, `${field}.kind`, CONSTRAINT_KINDS),
        description: check.text(constraint.description, `${field}.description`, {
          min: 1,
          max: 500,
        }),
        severity: check.enumValue(constraint.severity, `${field}.severity`, SEVERITIES),
        literals,
      }
    })
  if (!constraints.some(constraint => constraint.severity !== 'minor')) {
    fail('constraints', 'at least one constraint must be critical or major')
  }

  const ruleIds = new Set()
  const rules = check
    .array(value.rules, 'rules', { min: 0, max: MAX_RULES })
    .map((rule, index) => {
      const field = `rules[${index}]`
      const kind = isPlainObject(rule)
        ? check.enumValue(rule.kind, `${field}.kind`, RULE_KINDS)
        : fail(`${field}.kind`, `expected one of: ${RULE_KINDS.join(', ')}`)
      const allowed = kind === 'includes' || kind === 'excludes'
        ? ['id', 'kind', 'round', 'field', 'value']
        : kind === 'maxOptions'
          ? ['id', 'kind', 'round', 'max']
          : ['id', 'kind', 'round']
      check.object(rule, field, allowed, ['id', 'kind', 'round'])

      const ruleId = check.text(rule.id, `${field}.id`, { min: 1, max: 64, pattern: ID_PATTERN })
      if (ruleIds.has(ruleId)) fail(`${field}.id`, 'duplicate rule id')
      ruleIds.add(ruleId)

      let round
      if (rule.round === 'each' || rule.round === 'final') {
        round = rule.round
      } else {
        round = check.integer(rule.round, `${field}.round`, {
          min: roundsCompleted + 1,
          max: settings.maxRounds,
        })
      }

      if (kind === 'includes' || kind === 'excludes') {
        return {
          id: ruleId,
          kind,
          round,
          field: check.enumValue(rule.field, `${field}.field`, RULE_FIELDS),
          value: check.text(rule.value, `${field}.value`, { min: 1, max: 200 }),
        }
      }
      if (kind === 'maxOptions') {
        return { id: ruleId, kind, round, max: check.integer(rule.max, `${field}.max`, { min: 0, max: 4 }) }
      }
      return { id: ruleId, kind, round }
    })

  const mockResponses = check
    .array(value.mockResponses, 'mockResponses', { min: 0, max: MAX_MOCK_RESPONSES })
    .map((response, index) => {
      const field = `mockResponses[${index}]`
      check.object(response, field, ['draft', 'message', 'question', 'options'], [
        'draft',
        'message',
        'question',
      ])
      const question = response.question === null
        ? null
        : check.text(response.question, `${field}.question`, { min: 1, max: 1000 })
      const options = response.options === undefined
        ? []
        : check
            .array(response.options, `${field}.options`, { min: 0, max: 4 })
            .map((option, optionIndex) =>
              check.text(option, `${field}.options[${optionIndex}]`, { min: 1, max: 80 }),
            )
      if (new Set(options).size !== options.length) fail(`${field}.options`, 'duplicate option')
      if (question === null && options.length > 0) {
        fail(`${field}.options`, 'options require a non-null question')
      }
      return {
        draft: check.text(response.draft, `${field}.draft`, { min: 1, max: MAX_ORIGINAL_CHARS }),
        message: check.text(response.message, `${field}.message`, { min: 0, max: 1000 }),
        question,
        options,
      }
    })

  if (remainingRounds === 0 && mockResponses.length > 0) {
    fail('mockResponses', 'a case with no remaining rounds has no mock responses to replay')
  }
  if (remainingRounds > 0) {
    if (mockResponses.length < 1) fail('mockResponses', 'expected at least one response')
    if (mockResponses.length > Math.min(MAX_MOCK_RESPONSES, remainingRounds)) {
      fail('mockResponses', 'more responses than the remaining rounds')
    }
  }
  for (let index = 0; index < answers.length; index += 1) {
    if (index >= mockResponses.length) {
      fail(`answers[${index}]`, 'no mock response exists to ask the question this answer replies to')
    }
    if (mockResponses[index].question === null) {
      fail(
        `answers[${index}]`,
        'the preceding mock response has a null question, so the answer cannot be fed',
      )
    }
    if (answers[index].when?.option1Includes !== undefined && mockResponses[index].options.length === 0) {
      fail(`answers[${index}].when.option1Includes`, 'the preceding mock response has no options')
    }
  }

  return Object.freeze({
    schemaVersion: CASE_SCHEMA_VERSION,
    id,
    split: caseSplit,
    tags,
    provenance,
    original,
    context: { text: contextText },
    initialDialogue,
    initialDraft,
    roundsCompleted,
    settings,
    answers,
    constraints,
    rules,
    mockResponses,
  })
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Loads and validates every case file for one split under a fixed suite root.
 * The directory itself must not be a symlink, entries must be regular `.json`
 * files directly inside it, and the size cap is enforced before the read.
 */
export async function loadCases(suiteRoot, split) {
  if (!SPLITS.includes(split)) {
    throw new CaseValidationError(`split must be one of: ${SPLITS.join(', ')}`, { field: 'split' })
  }
  const root = path.resolve(suiteRoot)
  const suiteReal = await realpath(root).catch(() => {
    throw new CaseValidationError(`suite root does not exist: ${root}`, { field: 'suiteRoot' })
  })
  const directory = path.join(suiteReal, split === 'development' ? 'cases' : 'holdout')
  const directoryReal = await realpath(directory).catch(() => {
    throw new CaseValidationError(`suite directory does not exist: ${directory}`, {
      file: directory,
    })
  })
  if (directoryReal !== directory) {
    throw new CaseValidationError('suite directory must not be a symlink', { file: directory })
  }

  let entries
  try {
    entries = await readdir(directoryReal, { withFileTypes: true })
  } catch (cause) {
    throw new CaseValidationError(`could not list suite directory: ${cause.message}`, {
      file: directory,
    })
  }

  const files = entries
    .filter(entry => entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort()
  if (files.length === 0) {
    throw new CaseValidationError('suite directory has no case JSON files', { file: directoryReal })
  }
  if (files.length > MAX_CASE_FILES) {
    throw new CaseValidationError(`suite has more than ${MAX_CASE_FILES} files`, {
      file: directoryReal,
    })
  }

  const cases = []
  for (const name of files) {
    if (!CASE_FILE_PATTERN.test(name)) {
      throw new CaseValidationError('case file name must be lowercase kebab-case with .json', {
        file: name,
      })
    }
    const filePath = path.join(directoryReal, name)
    const info = await lstat(filePath).catch(() => null)
    if (info === null) throw new CaseValidationError('case file is missing', { file: name })
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new CaseValidationError('case file must be a regular file, not a symlink', { file: name })
    }
    if (info.size > MAX_CASE_BYTES) {
      throw new CaseValidationError(`case file exceeds ${MAX_CASE_BYTES} bytes`, { file: name })
    }
    const resolved = await realpath(filePath)
    if (!isInside(directoryReal, resolved) || path.dirname(resolved) !== directoryReal) {
      throw new CaseValidationError('case file resolves outside the suite directory', { file: name })
    }
    const raw = await readFile(resolved, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new CaseValidationError(`invalid JSON: ${cause.message}`, { file: name })
    }
    try {
      cases.push(validateCase(parsed, { file: name, split }))
    } catch (cause) {
      if (cause instanceof CaseValidationError) throw cause
      throw new CaseValidationError(`could not validate: ${cause.message}`, { file: name })
    }
  }

  const ids = new Set()
  for (const item of cases) {
    if (ids.has(item.id)) {
      throw new CaseValidationError('duplicate case id in the selected suite', {
        caseId: item.id,
        field: 'id',
      })
    }
    ids.add(item.id)
  }
  cases.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return cases
}
