import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const RUNNER = path.join(import.meta.dirname, 'run.mjs')
const COMPARE = path.join(import.meta.dirname, 'compare.mjs')
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, '..', '..')

function run(args, env = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

async function tempDir(prefix = 'popt-run-') {
  return mkdtemp(path.join(tmpdir(), prefix))
}

test('--validate works without hooks, a transport or dependencies', async () => {
  const root = await tempDir('popt-validate-')
  await mkdir(path.join(root, 'evals', 'runner'), { recursive: true })
  await cp(path.join(CHECKOUT_ROOT, 'evals', 'cases'), path.join(root, 'evals', 'cases'), { recursive: true })
  for (const file of ['run.mjs', 'args.mjs', 'schema.mjs', 'load-hooks.mjs']) {
    await cp(path.join(CHECKOUT_ROOT, 'evals', 'runner', file), path.join(root, 'evals', 'runner', file))
  }
  await cp(path.join(CHECKOUT_ROOT, 'package.json'), path.join(root, 'package.json'))

  const result = spawnSync(
    process.execPath,
    [path.join(root, 'evals', 'runner', 'run.mjs'), '--validate', '--suite', 'development'],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /validated 14 case\(s\)/)
  assert.equal(existsSync(path.join(root, 'hooks')), false)
  assert.equal(existsSync(path.join(root, 'node_modules')), false)
})

test('--validate rejects unknown flags and an invalid suite', () => {
  const unknown = run(['--validate', '--mystery'])
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /unknown flag/)

  const suite = run(['--validate', '--suite', 'training'])
  assert.notEqual(suite.status, 0)
  assert.match(suite.stderr, /--suite must be one of/)
})

test('--mock development writes a traceable result without an adapter', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'development.json')
  const result = run(['--mock', '--suite', 'development', '--repeats', '1', '--out', out])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /pipeline\/rule rehearsal only — no semantic-quality conclusion/)
  assert.match(result.stdout, /calls: planned=16, attempted=16, completed=16/)

  const parsed = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(parsed.metadata.schemaVersion, 1)
  assert.equal(parsed.metadata.mode, 'mock')
  assert.equal(parsed.metadata.suite, 'development')
  assert.equal(parsed.metadata.adapter, null)
  assert.match(parsed.metadata.repoSha, /^[a-f0-9]{40}$/)
  assert.match(parsed.metadata.corpusHash, /^[a-f0-9]{64}$/)
  assert.equal(parsed.cases.length, 14)
  assert.equal(parsed.metadata.plannedCalls, 16)
  assert.equal(parsed.metadata.attemptedCalls, 16)
  assert.equal(parsed.metadata.completedCalls, 16)
  assert.equal(parsed.aggregate.totals.parseFailures, 0)
  assert.ok(parsed.aggregate.totals.rulePasses > 0)
  assert.equal(parsed.aggregate.semantic.status, 'unreviewed')

  const round = parsed.cases[0].repeats[0].rounds[0]
  assert.ok(round.original.length > 0)
  assert.ok(round.context.length >= 0)
  assert.ok(round.request.prompt.length > 0)
  assert.ok(round.request.system.length > 0)
  assert.equal(round.usage.synthetic, true)
  assert.equal(round.usage.counts.input_tokens, 0)
  assert.match(round.requestHash, /^[a-f0-9]{64}$/)
  assert.match(round.guidanceVersion, /^[a-f0-9]{64}$/)
  assert.equal(Object.keys(parsed.metadata.guidance.sourceHashes).length, 4)
})

test('--mock holdout has its own frozen four-case corpus', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'holdout.json')
  const result = run(['--mock', '--suite', 'holdout', '--repeats', '1', '--out', out])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(parsed.cases.length, 4)
  assert.ok(parsed.cases.every(item => item.caseId.startsWith('holdout-')))
  assert.equal(parsed.metadata.plannedCalls, 4)
})

test('--out is exclusive and never overwrites a result', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'result.json')
  const first = run(['--mock', '--suite', 'holdout', '--out', out])
  assert.equal(first.status, 0, first.stderr)
  const before = await readFile(out, 'utf8')
  const second = run(['--mock', '--suite', 'holdout', '--out', out])
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /refusing to overwrite/)
  assert.equal(await readFile(out, 'utf8'), before)
})

test('live mode rejects a cap that cannot cover the planned rounds before any adapter call', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'live.json')
  const log = path.join(dir, 'calls.jsonl')
  const result = run(
    [
      '--live',
      '--adapter',
      path.join(CHECKOUT_ROOT, 'evals', 'runner', 'fixtures', 'fake-adapter.mjs'),
      '--model',
      'fake-model',
      '--max-calls',
      '1',
      '--max-rounds',
      '1',
      '--suite',
      'holdout',
      '--out',
      out,
    ],
    { POPT_FAKE_ADAPTER_LOG: log },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /planned calls 4 exceed --max-calls 1/)
  assert.equal(existsSync(out), false)
  assert.equal(existsSync(log), false)
})

test('live mode runs only the explicit fake adapter with logical call caps', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'live.json')
  const log = path.join(dir, 'calls.jsonl')
  const result = run(
    [
      '--live',
      '--adapter',
      path.join(CHECKOUT_ROOT, 'evals', 'runner', 'fixtures', 'fake-adapter.mjs'),
      '--model',
      'fake-requested',
      '--max-calls',
      '4',
      '--max-rounds',
      '1',
      '--suite',
      'holdout',
      '--out',
      out,
    ],
    { POPT_FAKE_ADAPTER_LOG: log, POPT_FAKE_ADAPTER_MODE: 'ok' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /provider-internal retries are not bounded/)
  const parsed = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(parsed.metadata.mode, 'live')
  assert.equal(parsed.metadata.adapter.kind, 'trusted')
  assert.match(parsed.metadata.adapter.hash, /^[a-f0-9]{64}$/)
  assert.equal(parsed.metadata.model.requested, 'fake-requested')
  assert.equal(parsed.metadata.model.actual, 'fake-model-1')
  assert.equal(parsed.metadata.attemptedCalls, 4)
  assert.equal(parsed.metadata.completedCalls, 4)
  const calls = (await readFile(log, 'utf8')).trim().split('\n')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(line => JSON.parse(line).model === 'fake-requested'))
})

test('live mode refuses a CI environment before touching the adapter', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'live.json')
  const result = run(
    [
      '--live',
      '--adapter',
      path.join(CHECKOUT_ROOT, 'evals', 'runner', 'fixtures', 'fake-adapter.mjs'),
      '--model',
      'fake-model',
      '--max-calls',
      '4',
      '--max-rounds',
      '1',
      '--suite',
      'holdout',
      '--out',
      out,
    ],
    { CI: '1' },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CI environment variable CI/)
  assert.equal(existsSync(out), false)
})

test('a fresh checkout copy without dependencies validates and runs mock', async () => {
  const root = await tempDir('popt-fresh-run-')
  await cp(path.join(CHECKOUT_ROOT, 'hooks'), path.join(root, 'hooks'), { recursive: true })
  await cp(path.join(CHECKOUT_ROOT, 'evals'), path.join(root, 'evals'), { recursive: true })
  await cp(path.join(CHECKOUT_ROOT, 'package.json'), path.join(root, 'package.json'))
  assert.equal(existsSync(path.join(root, 'node_modules')), false)
  assert.equal(existsSync(path.join(root, '.claude-plugin', 'types')), false)

  const out = path.join(root, 'fresh-result.json')
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'evals', 'runner', 'run.mjs'), '--mock', '--suite', 'development', '--repeats', '1', '--out', out],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(parsed.metadata.mode, 'mock')
  assert.equal(parsed.cases.length, 14)
  assert.equal(parsed.metadata.completedCalls, 16)
})

test('two mock runs compare with an intentional regression named in the report', async () => {
  const dir = await tempDir()
  const baselinePath = path.join(dir, 'baseline.json')
  const candidatePath = path.join(dir, 'candidate.json')
  const baseline = run(['--mock', '--suite', 'development', '--out', baselinePath])
  assert.equal(baseline.status, 0, baseline.stderr)
  const candidate = run(['--mock', '--suite', 'development', '--out', candidatePath])
  assert.equal(candidate.status, 0, candidate.stderr)

  const parsed = JSON.parse(await readFile(candidatePath, 'utf8'))
  let target = null
  for (const caseItem of parsed.cases) {
    for (const repeat of caseItem.repeats) {
      for (const round of repeat.rounds) {
        for (const judgment of round.judgments) {
          if (target === null && judgment.status === 'pass') target = judgment
        }
      }
    }
  }
  assert.ok(target !== null)
  target.status = 'fail'
  target.evidence = 'intentional fixture regression'
  await writeFile(candidatePath, JSON.stringify(parsed))

  const reportPath = path.join(dir, 'comparison.md')
  const compared = spawnSync(
    process.execPath,
    [COMPARE, '--baseline', baselinePath, '--candidate', candidatePath, '--out', reportPath],
    { encoding: 'utf8' },
  )
  assert.equal(compared.status, 0, compared.stderr)
  const body = await readFile(reportPath, 'utf8')
  assert.match(body, /회귀 상세/)
  assert.match(body, /intentional fixture regression/)
  assert.match(body, /pipeline\/rule rehearsal only/)

  const jsonPath = path.join(dir, 'comparison.json')
  const comparedJson = spawnSync(
    process.execPath,
    [COMPARE, '--baseline', baselinePath, '--candidate', candidatePath, '--out', jsonPath],
    { encoding: 'utf8' },
  )
  assert.equal(comparedJson.status, 0, comparedJson.stderr)
  const comparison = JSON.parse(await readFile(jsonPath, 'utf8'))
  assert.equal(comparison.comparisonVersion, 1)
  assert.equal(comparison.summary.ruleRegressions, 1)
  assert.equal(comparison.summary.semanticReviewedPairs, 0)
  assert.ok(comparison.compatibility.unresolved.some(item => /semantic review missing/.test(item)))
})
