import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CALL_MS,
  MAX_CALLS,
  MAX_REPEATS,
  MAX_ROUNDS,
  ArgsError,
  detectCi,
  parseArgs,
  validateBudget,
} from './args.mjs'

test('empty argv defaults to a safe mock run', () => {
  const args = parseArgs([])
  assert.equal(args.mode, 'mock')
  assert.equal(args.suite, 'development')
  assert.equal(args.repeats, 1)
  assert.equal(args.maxRounds, MAX_ROUNDS)
  assert.equal(args.maxCalls, null)
  assert.equal(args.maxCallMs, MAX_CALL_MS)
  assert.equal(args.out, null)
  assert.equal(args.adapter, null)
  assert.equal(args.model, null)
})

test('mode, suite and caps are parsed with both flag forms', () => {
  const args = parseArgs([
    '--mock',
    '--suite=holdout',
    '--repeats',
    '2',
    '--max-calls=7',
    '--max-rounds',
    '3',
    '--out',
    '/tmp/result.json',
  ])
  assert.equal(args.mode, 'mock')
  assert.equal(args.suite, 'holdout')
  assert.equal(args.repeats, 2)
  assert.equal(args.maxCalls, 7)
  assert.equal(args.maxRounds, 3)
  assert.equal(args.out, '/tmp/result.json')
})

test('--validate accepts only the suite selector', () => {
  assert.equal(parseArgs(['--validate', '--suite', 'holdout']).mode, 'validate')
  assert.throws(() => parseArgs(['--validate', '--out', '/tmp/x.json']), /not used with --validate/)
  assert.throws(() => parseArgs(['--validate', '--max-calls', '3']), /not used with --validate/)
  assert.throws(() => parseArgs(['--validate', '--max-rounds', '3']), /not used with --validate/)
})

test('modes are mutually exclusive and unknown flags fail', () => {
  assert.throws(() => parseArgs(['--mock', '--live']), /mutually exclusive/)
  assert.throws(() => parseArgs(['--validate', '--mock']), /mutually exclusive/)
  assert.throws(() => parseArgs(['--mystery']), /unknown flag/)
  assert.throws(() => parseArgs(['positional']), /unexpected argument/)
})

test('numeric caps reject zero, fractions, NaN, negatives and overflows', () => {
  for (const value of ['0', '1.5', 'NaN', '-1', '1e3', '']) {
    assert.throws(() => parseArgs(['--mock', `--repeats=${value}`]), /positive integer/)
  }
  assert.throws(
    () => parseArgs(['--mock', `--repeats=${MAX_REPEATS + 1}`]),
    new RegExp(`at most ${MAX_REPEATS}`),
  )
  assert.throws(
    () => parseArgs(['--mock', `--max-calls=${MAX_CALLS + 1}`]),
    new RegExp(`at most ${MAX_CALLS}`),
  )
  assert.throws(
    () => parseArgs(['--mock', `--max-rounds=${MAX_ROUNDS + 1}`]),
    new RegExp(`at most ${MAX_ROUNDS}`),
  )
  assert.throws(
    () => parseArgs(['--mock', `--max-call-ms=${MAX_CALL_MS + 1}`]),
    new RegExp(`at most ${MAX_CALL_MS}`),
  )
})

test('live requires every explicit gate', () => {
  const base = ['--live']
  assert.throws(() => parseArgs(base, {}), /requires --adapter/)
  assert.throws(
    () => parseArgs([...base, '--adapter', 'relative/adapter.mjs'], {}),
    /absolute path/,
  )
  assert.throws(
    () => parseArgs([...base, '--adapter', '/tmp/adapter.txt'], {}),
    /\.mjs or \.js/,
  )
  const withAdapter = [...base, '--adapter', '/tmp/adapter.mjs']
  assert.throws(() => parseArgs(withAdapter, {}), /requires --model/)
  const withModel = [...withAdapter, '--model', 'explicit-model']
  assert.throws(() => parseArgs(withModel, {}), /requires --max-calls/)
  const withCalls = [...withModel, '--max-calls', '2']
  assert.throws(() => parseArgs(withCalls, {}), /requires --max-rounds/)
  const complete = parseArgs([...withCalls, '--max-rounds', '2'], {})
  assert.equal(complete.mode, 'live')
  assert.equal(complete.maxCalls, 2)
  assert.equal(complete.maxRounds, 2)
})

test('live is rejected in a nonempty CI environment before adapter work', () => {
  assert.equal(detectCi({}), null)
  assert.equal(detectCi({ CI: 'false' }), 'CI')
  assert.equal(detectCi({ GITHUB_ACTIONS: 'true' }), 'GITHUB_ACTIONS')
  assert.throws(
    () =>
      parseArgs(
        [
          '--live',
          '--adapter',
          '/tmp/adapter.mjs',
          '--model',
          'explicit-model',
          '--max-calls',
          '1',
          '--max-rounds',
          '1',
        ],
        { CI: '1' },
      ),
    /CI/,
  )
})

test('mock never accepts adapter or model flags', () => {
  assert.throws(() => parseArgs(['--mock', '--adapter', '/tmp/a.mjs']), /only valid with --live/)
  assert.throws(() => parseArgs(['--mock', '--model', 'm']), /only valid with --live/)
})

test('--help returns help without requiring live flags', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

function fakeCases() {
  return [
    { id: 'a', settings: { maxRounds: 3 }, roundsCompleted: 1 },
    { id: 'b', settings: { maxRounds: 5 }, roundsCompleted: 0 },
  ]
}

test('budget plan uses min(remaining, CLI rounds) per case times repeats', () => {
  const plan = validateBudget(fakeCases(), { maxRounds: 3, repeats: 2, maxCalls: 10 })
  assert.equal(plan.plannedCalls, 10)
  assert.equal(plan.maxCalls, 10)
  assert.deepEqual(
    plan.perCase.map(item => [item.caseId, item.remainingRounds, item.roundsThisRun]),
    [['a', 2, 2], ['b', 5, 3]],
  )
  assert.equal(validateBudget(fakeCases(), { maxRounds: 5, repeats: 1, maxCalls: null }).plannedCalls, 7)
})

test('budget preflight rejects an insufficient cap at the exact boundary', () => {
  assert.throws(
    () => validateBudget(fakeCases(), { maxRounds: 3, repeats: 2, maxCalls: 9 }),
    /exceed --max-calls 9/,
  )
  assert.throws(
    () => validateBudget(fakeCases(), { maxRounds: 3, repeats: 2, maxCalls: 10.5 }),
    /max-calls must be an integer/,
  )
})

test('budget rejects invalid cases and hard-cap overflows', () => {
  assert.throws(() => validateBudget([], { maxRounds: 1, repeats: 1, maxCalls: 1 }), /no cases/)
  assert.throws(
    () => validateBudget([{ id: 'bad', settings: { maxRounds: 0 }, roundsCompleted: 0 }], {
      maxRounds: 1,
      repeats: 1,
      maxCalls: 1,
    }),
    /maxRounds is invalid/,
  )
  assert.throws(
    () => validateBudget([{ id: 'bad', settings: { maxRounds: 2 }, roundsCompleted: 3 }], {
      maxRounds: 1,
      repeats: 1,
      maxCalls: 1,
    }),
    /roundsCompleted is invalid/,
  )
  const many = Array.from({ length: 101 }, (_, index) => ({
    id: `case-${index}`,
    settings: { maxRounds: 5 },
    roundsCompleted: 0,
  }))
  assert.throws(
    () => validateBudget(many, { maxRounds: 5, repeats: 2, maxCalls: null }),
    /hard cap of 1000/,
  )
})

test('programmatic budget callers get ArgsError, not a plain Error', () => {
  assert.throws(
    () => validateBudget(fakeCases(), { maxRounds: 0, repeats: 1, maxCalls: 1 }),
    error => error instanceof ArgsError,
  )
})
