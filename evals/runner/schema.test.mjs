import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CASE_SCHEMA_VERSION,
  MAX_CASE_BYTES,
  CaseValidationError,
  isWellFormed,
  loadCases,
  stableStringify,
  validateCase,
} from './schema.mjs'

function validCase(overrides = {}) {
  return {
    schemaVersion: CASE_SCHEMA_VERSION,
    id: 'sample-case',
    split: 'development',
    tags: ['ko'],
    provenance: { kind: 'synthetic-authored', source: 'test fixture' },
    original: '로그인 오류를 조사해줘.',
    context: { text: '# src/auth/login.ts\n1: export function login() {}\n' },
    initialDialogue: [],
    initialDraft: '',
    roundsCompleted: 0,
    settings: {
      guidanceProfile: 'common',
      maxRounds: 1,
      maxTokens: 2048,
      timeoutMs: 30000,
      cache: false,
    },
    answers: [],
    constraints: [
      {
        id: 'keep-login',
        kind: 'mustInclude',
        description: 'Keep the login scope.',
        severity: 'critical',
        literals: ['로그인'],
      },
    ],
    rules: [
      { id: 'keeps-login', kind: 'includes', round: 'final', field: 'draft', value: '로그인' },
    ],
    mockResponses: [
      {
        draft: '로그인 오류를 조사해줘.',
        message: '범위를 유지했습니다.',
        question: null,
        options: [],
      },
    ],
    ...overrides,
  }
}

async function suiteWith(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'popt-schema-'))
  const cases = path.join(root, 'cases')
  await mkdir(cases, { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    const body = typeof value === 'string' ? value : JSON.stringify(value)
    await writeFile(path.join(cases, name), body)
  }
  return root
}

test('valid case is normalized with defaults', () => {
  const parsed = validateCase(validCase())
  assert.equal(parsed.schemaVersion, 1)
  assert.deepEqual(parsed.tags, ['ko'])
  assert.deepEqual(parsed.context, { text: '# src/auth/login.ts\n1: export function login() {}\n' })
  assert.deepEqual(parsed.constraints[0].literals, ['로그인'])
  assert.deepEqual(parsed.rules[0], {
    id: 'keeps-login',
    kind: 'includes',
    round: 'final',
    field: 'draft',
    value: '로그인',
  })
  assert.equal(parsed.mockResponses[0].question, null)
})

test('unknown top-level and nested fields are rejected', () => {
  assert.throws(() => validateCase({ ...validCase(), extra: true }), /unknown field/)
  const nested = validCase()
  nested.settings = { ...nested.settings, secretFlag: true }
  assert.throws(() => validateCase(nested), /settings\.secretFlag: unknown field/)
  const provenance = validCase()
  provenance.provenance = { kind: 'synthetic-authored', source: 'x', url: 'https://example.com' }
  assert.throws(() => validateCase(provenance), /provenance\.url: unknown field/)
})

test('split must match the selected suite and split enum', () => {
  assert.throws(() => validateCase(validCase(), { split: 'holdout' }), /does not match/)
  assert.throws(() => validateCase(validCase({ split: 'other' })), /split/)
})

test('malformed roles, rules and answers are rejected', () => {
  const role = validCase()
  role.initialDialogue = [{ role: 'system', text: 'x' }]
  assert.throws(() => validateCase(role), /initialDialogue\[0\]\.role/)

  const kind = validCase()
  kind.rules = [{ id: 'x', kind: 'regex', round: 'final' }]
  assert.throws(() => validateCase(kind), /rules\[0\]\.kind/)

  const field = validCase()
  field.rules = [{ id: 'x', kind: 'questionNull', round: 'final', field: 'draft' }]
  assert.throws(() => validateCase(field), /rules\[0\]\.field: unknown field/)

  const value = validCase()
  value.rules = [{ id: 'x', kind: 'includes', round: 'final', field: 'draft' }]
  assert.throws(() => validateCase(value), /rules\[0\]\.value: expected string/)

  const answer = validCase()
  answer.settings = { ...answer.settings, maxRounds: 2 }
  answer.answers = [{ text: '1번', when: {} }]
  answer.mockResponses = [
    { draft: 'draft', message: 'm', question: 'q?', options: ['a'] },
    { draft: 'draft2', message: 'm', question: null, options: [] },
  ]
  assert.throws(() => validateCase(answer), /answers\[0\]\.when: expected at least one condition/)
})

test('mock responses and answers must be internally consistent', () => {
  const tooMany = validCase()
  tooMany.mockResponses = [
    { draft: 'a', message: 'm', question: null, options: [] },
    { draft: 'b', message: 'm', question: null, options: [] },
  ]
  assert.throws(() => validateCase(tooMany), /more responses than the remaining rounds/)

  const unreachable = validCase()
  unreachable.settings = { ...unreachable.settings, maxRounds: 2 }
  unreachable.answers = [{ text: '1번' }]
  unreachable.mockResponses = [
    { draft: 'a', message: 'm', question: null, options: [] },
    { draft: 'b', message: 'm', question: null, options: [] },
  ]
  assert.throws(() => validateCase(unreachable), /null question/)

  const nullQuestionWithOptions = validCase()
  nullQuestionWithOptions.mockResponses = [
    { draft: 'a', message: 'm', question: null, options: ['x'] },
  ]
  assert.throws(() => validateCase(nullQuestionWithOptions), /options require a non-null question/)
})

test('every answer requires the post-answer mock response', () => {
  const missing = validCase()
  missing.settings = { ...missing.settings, maxRounds: 2 }
  missing.answers = [{ text: '1번', when: { questionIncludes: 'q' } }]
  missing.mockResponses = [
    { draft: 'a', message: 'm', question: 'q?', options: ['1번'] },
  ]
  assert.throws(() => validateCase(missing), /the round after every answer exists/)

  const satisfied = validCase()
  satisfied.settings = { ...satisfied.settings, maxRounds: 2 }
  satisfied.answers = [{ text: '1번', when: { questionIncludes: 'q' } }]
  satisfied.mockResponses = [
    { draft: 'a', message: 'm', question: 'q?', options: ['1번'] },
    { draft: 'b', message: 'm', question: null, options: [] },
  ]
  const parsed = validateCase(satisfied)
  assert.equal(parsed.mockResponses.length, 2)

  const noAnswersNeedsOne = validCase()
  noAnswersNeedsOne.mockResponses = []
  assert.throws(() => validateCase(noAnswersNeedsOne), /expected at least one response/)
})

test('round-scoped rules must be reachable and in range', () => {
  const before = validCase()
  before.roundsCompleted = 1
  before.settings = { ...before.settings, maxRounds: 2 }
  before.rules = [{ id: 'old', kind: 'questionNull', round: 1 }]
  assert.throws(() => validateCase(before), /rules\[0\]\.round/)

  const past = validCase()
  past.rules = [{ id: 'late', kind: 'questionNull', round: 2 }]
  assert.throws(() => validateCase(past), /rules\[0\]\.round/)
})

test('invalid ids, lone surrogates and missing constraints are rejected', () => {
  assert.throws(() => validateCase(validCase({ id: 'Bad_ID' })), /id/)
  assert.throws(() => validateCase(validCase({ original: '\uD800' })), /valid Unicode/)
  assert.throws(() => validateCase(validCase({ constraints: [] })), /constraints/)
  assert.equal(isWellFormed('한글 👩‍💻'), true)
  assert.equal(isWellFormed('\uD800'), false)
})

test('stableStringify is independent of object key insertion order', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }))
  assert.notEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }).replace('"a"', '"x"'))
})

test('loadCases sorts by id and reads only the selected split', async () => {
  const root = await suiteWith({
    'z-file.json': validCase({ id: 'z-case' }),
    'a-file.json': validCase({ id: 'a-case' }),
  })
  const cases = await loadCases(root, 'development')
  assert.deepEqual(cases.map(item => item.id), ['a-case', 'z-case'])
})

test('loadCases rejects duplicate ids', async () => {
  const root = await suiteWith({
    'one.json': validCase({ id: 'same-id' }),
    'two.json': validCase({ id: 'same-id' }),
  })
  await assert.rejects(loadCases(root, 'development'), /duplicate case id/)
})

test('loadCases rejects a missing suite, invalid JSON and oversized files', async () => {
  const missing = await mkdtemp(path.join(tmpdir(), 'popt-schema-'))
  await assert.rejects(loadCases(missing, 'development'), /suite directory does not exist/)

  const invalid = await suiteWith({ 'bad.json': '{not json' })
  await assert.rejects(loadCases(invalid, 'development'), /invalid JSON/)

  const huge = await suiteWith({ 'huge.json': 'a'.repeat(MAX_CASE_BYTES + 1) })
  await assert.rejects(loadCases(huge, 'development'), /exceeds/)
})

test('loadCases rejects symlinked files and symlinked directories', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'popt-outside-'))
  const outsideFile = path.join(outside, 'outside.json')
  await writeFile(outsideFile, JSON.stringify(validCase()))

  const root = await suiteWith({ 'real.json': validCase() })
  await symlink(outsideFile, path.join(root, 'cases', 'link.json'))
  await assert.rejects(loadCases(root, 'development'), /symlink/)

  const root2 = await mkdtemp(path.join(tmpdir(), 'popt-schema-'))
  await symlink(path.join(root, 'cases'), path.join(root2, 'cases'))
  await assert.rejects(loadCases(root2, 'development'), /symlink/)
})

test('validation errors name the file, case and field without dumping the payload', () => {
  const caseId = 'leaky-case'
  try {
    validateCase(validCase({ id: caseId, original: '' }), { file: 'leaky-case.json' })
    assert.fail('expected a validation error')
  } catch (error) {
    assert.ok(error instanceof CaseValidationError)
    assert.match(error.message, /leaky-case\.json/)
    assert.match(error.message, /leaky-case/)
    assert.match(error.message, /original/)
    assert.equal(error.file, 'leaky-case.json')
    assert.equal(error.caseId, caseId)
    assert.equal(error.field, 'original')
  }
})
