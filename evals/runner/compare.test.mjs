import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CompareError,
  compareRuns,
  formatComparison,
  parseCompareArgs,
  renderComparisonMarkdown,
  validateResult,
  writeComparison,
} from './compare.mjs'

const COMPARE_CLI = path.join(import.meta.dirname, 'compare.mjs')

function judgment(ruleId, status, evidence = `${ruleId} ${status}`) {
  return {
    ruleId,
    kind: 'includes',
    round: 1,
    field: 'draft',
    value: ruleId,
    status,
    evidence,
    reason: status,
  }
}

function result({
  mode = 'mock',
  suite = 'development',
  caseId = 'case-a',
  caseHash = 'a'.repeat(64),
  corpusHash = 'c'.repeat(64),
  status = 'completed',
  judgments = [judgment('r1', 'pass'), judgment('r2', 'pass')],
  review = null,
  guidance = 'f'.repeat(64),
  requested = null,
  actual = null,
  settings = { repeats: 1, maxRounds: 1, maxCalls: 1, maxCallMs: 120000 },
  durationMs = 10,
  rounds = 1,
} = {}) {
  const roundList = []
  for (let round = 1; round <= rounds; round += 1) {
    roundList.push({
      round,
      reply: { draft: 'draft', message: 'm', question: null, options: [] },
      judgments: round === rounds ? judgments : [],
      durationMs,
      usage: {
        known: true,
        synthetic: mode === 'mock',
        counts: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
  }
  return {
    metadata: {
      schemaVersion: 1,
      runnerVersion: '1',
      rubricVersion: '1',
      mode,
      suite,
      nodeVersion: 'v26.12.0',
      packageVersion: '0.13.0',
      repoSha: 'abc123',
      dirty: false,
      adapter: mode === 'live' ? { kind: 'fake', hash: 'd'.repeat(64), path: '/tmp/fake.mjs' } : null,
      model: { requested, actual },
      guidance: { profiles: { common: { version: guidance, chars: 100 } } },
      settings,
      plannedCalls: 1,
      attemptedCalls: 1,
      completedCalls: 1,
      startedAt: '2026-10-02T12:00:00.000Z',
      endedAt: '2026-10-02T12:00:01.000Z',
      corpusHash,
    },
    cases: [
      {
        caseId,
        caseHash,
        split: suite,
        tags: [],
        repeats: [
          {
            repeat: 1,
            status,
            stopReason: null,
            rounds: roundList,
            error: null,
            ...(review === null ? {} : { humanReview: review }),
          },
        ],
      },
    ],
  }
}

function review({ constraint = 'pass', scope = 'pass' } = {}) {
  return {
    reviewVersion: 1,
    caseId: 'case-a',
    caseHash: 'a'.repeat(64),
    repeat: 1,
    reviewerId: 'reviewer-a',
    blindLabel: 'run-1',
    reviewedAt: '2026-10-02T12:00:00.000Z',
    reviews: [
      { criterionId: 'constraint-omission', verdict: constraint, quote: 'q', reason: 'r' },
      { criterionId: 'scope-addition', verdict: scope, quote: 'q', reason: 'r' },
    ],
  }
}

test('compareRuns pairs cases and reports rule improvements', () => {
  const baseline = result({ judgments: [judgment('r1', 'pass'), judgment('r2', 'fail')] })
  const candidate = result({ judgments: [judgment('r1', 'pass'), judgment('r2', 'pass')] })
  const comparison = compareRuns(baseline, candidate)
  assert.equal(comparison.summary.pairs, 1)
  assert.equal(comparison.summary.ruleImprovements, 1)
  assert.equal(comparison.summary.ruleRegressions, 0)
  assert.equal(comparison.summary.improvedPairs, 1)
  assert.equal(comparison.pairs[0].improvements[0].ruleId, 'r2')
  assert.equal(comparison.compatibility.confounded, false)
})

test('an intentional regression is named with exact rule evidence', () => {
  const baseline = result({ judgments: [judgment('r1', 'pass')] })
  const candidate = result({ judgments: [judgment('r1', 'fail', 'draft does not contain "r1"')] })
  const comparison = compareRuns(baseline, candidate)
  assert.equal(comparison.summary.ruleRegressions, 1)
  assert.equal(comparison.summary.regressedPairs, 1)
  assert.equal(comparison.pairs[0].regressions[0].ruleId, 'r1')
  assert.match(comparison.pairs[0].regressions[0].evidence, /does not contain/)
  const markdown = renderComparisonMarkdown(comparison)
  assert.match(markdown, /회귀 상세/)
  assert.match(markdown, /r1/)
})

test('mock and live results never compare', () => {
  assert.throws(
    () => compareRuns(result({ mode: 'mock' }), result({ mode: 'live', requested: 'm' })),
    /mock and live/,
  )
})

test('a non-comparable result is refused instead of presented as paired evidence', () => {
  const marked = result()
  marked.metadata.comparable = false
  assert.throws(() => compareRuns(marked, result()), /baseline is marked comparable:false/)
  assert.throws(() => compareRuns(result(), marked), /candidate is marked comparable:false/)

  const findings = result()
  findings.metadata.sensitiveFindings = [{ caseId: 'case-a', repeat: 1, round: 1, location: 'adapter-response', kinds: ['aws-key'] }]
  assert.throws(() => compareRuns(result(), findings), /candidate records 1 sensitive finding/)
  assert.throws(() => compareRuns(findings, result()), /baseline records 1 sensitive finding/)
})

test('different corpus hashes and suites are rejected', () => {
  assert.throws(
    () => compareRuns(result(), result({ corpusHash: 'd'.repeat(64) })),
    /corpus hash differs/,
  )
  assert.throws(
    () => compareRuns(result(), result({ suite: 'holdout' })),
    /suite differs/,
  )
  assert.throws(
    () => compareRuns(result({ caseHash: 'a'.repeat(64) }), result({ caseHash: 'b'.repeat(64) })),
    /case hash differs/,
  )
})

test('changed guidance needs an explicit allow flag and is marked confounded', () => {
  const baseline = result({ guidance: 'a'.repeat(64) })
  const candidate = result({ guidance: 'b'.repeat(64) })
  assert.throws(() => compareRuns(baseline, candidate), /guidance version differs/)
  const comparison = compareRuns(baseline, candidate, { allowChange: ['guidance'] })
  assert.equal(comparison.compatibility.confounded, true)
  assert.ok(comparison.compatibility.changedDimensions.includes('guidance'))
  assert.match(renderComparisonMarkdown(comparison), /교란됨 \| 예/)
})

test('changed model identity needs an explicit flag and records unknown actual models', () => {
  const baseline = result({ mode: 'live', requested: 'model-a', actual: 'model-a' })
  const candidate = result({ mode: 'live', requested: 'model-b', actual: 'model-b' })
  assert.throws(() => compareRuns(baseline, candidate), /model identity differs/)
  const comparison = compareRuns(baseline, candidate, { allowChange: ['model'] })
  assert.equal(comparison.compatibility.confounded, true)
  assert.ok(comparison.compatibility.changedDimensions.includes('model'))

  const unknown = compareRuns(
    result({ mode: 'live', requested: 'model-a', actual: null }),
    result({ mode: 'live', requested: 'model-a', actual: null }),
  )
  assert.ok(unknown.compatibility.unresolved.some(item => /actual model identity/.test(item)))
})

test('changed settings are enumerated only when allowed', () => {
  const baseline = result({ settings: { repeats: 1, maxRounds: 1, maxCalls: 1, maxCallMs: 120000 } })
  const candidate = result({ settings: { repeats: 1, maxRounds: 2, maxCalls: 2, maxCallMs: 120000 } })
  assert.throws(() => compareRuns(baseline, candidate), /settings differ/)
  const comparison = compareRuns(baseline, candidate, { allowChange: ['settings'] })
  assert.deepEqual(comparison.compatibility.changedSettings, ['maxCalls', 'maxRounds'])
  assert.equal(comparison.compatibility.confounded, true)
})

test('a missing case/repeat is rejected rather than treated as a pass', () => {
  const baseline = result()
  const candidate = result({ caseId: 'case-b' })
  assert.throws(() => compareRuns(baseline, candidate), /candidate is missing case/)
})

test('different completed rounds are an outcome, not a missing-case error', () => {
  const baseline = result({ status: 'completed', rounds: 2 })
  const candidate = result({ status: 'capped', rounds: 1 })
  const comparison = compareRuns(baseline, candidate)
  assert.equal(comparison.pairs.length, 1)
  assert.equal(comparison.pairs[0].baseline.completedRounds, 2)
  assert.equal(comparison.pairs[0].candidate.completedRounds, 1)
  assert.equal(comparison.summary.pairs, 1)
})

test('unreviewed semantic data compares as N/A, and reviewed data uses raw denominators', () => {
  const unreviewed = compareRuns(result(), result())
  assert.equal(unreviewed.summary.semanticReviewedPairs, 0)
  assert.equal(unreviewed.summary.semanticRates.baselineConstraintOmissionRate, null)
  assert.ok(unreviewed.compatibility.unresolved.some(item => /semantic review missing/.test(item)))
  assert.match(renderComparisonMarkdown(unreviewed), /제약 누락률 \| N\/A \(0\/0\) \| N\/A \(0\/0\)/)

  const reviewed = compareRuns(
    result({ review: review({ constraint: 'fail', scope: 'fail' }) }),
    result({ review: review({ constraint: 'pass', scope: 'pass' }) }),
  )
  assert.equal(reviewed.summary.semanticReviewedPairs, 1)
  assert.equal(reviewed.summary.semanticRates.baselineConstraintOmissionRate, 1)
  assert.equal(reviewed.summary.semanticRates.candidateConstraintOmissionRate, 0)
  assert.equal(reviewed.summary.semanticRates.baselineScopeAdditionRate, 1)
  assert.equal(reviewed.summary.semanticRates.candidateScopeAdditionRate, 0)
})

test('the comparison records version identity for both sides', () => {
  const baseline = result()
  const candidate = result()
  candidate.metadata.repoSha = 'def456'
  candidate.metadata.dirty = true
  candidate.metadata.packageVersion = '0.14.0'
  candidate.metadata.model = { requested: 'model-b', actual: null }
  const comparison = compareRuns(baseline, candidate, { allowChange: ['model'] })
  assert.equal(comparison.baseline.metadata.repoSha, 'abc123')
  assert.equal(comparison.baseline.metadata.dirty, false)
  assert.equal(comparison.baseline.metadata.packageVersion, '0.13.0')
  assert.deepEqual(comparison.baseline.metadata.guidanceProfiles, { common: 'f'.repeat(64) })
  assert.equal(comparison.candidate.metadata.repoSha, 'def456')
  assert.equal(comparison.candidate.metadata.dirty, true)
  assert.equal(comparison.candidate.metadata.model.requested, 'model-b')

  const markdown = renderComparisonMarkdown(comparison)
  assert.match(markdown, /## 버전·실행 조건/)
  assert.match(markdown, /\| 저장소 SHA \| abc123 \| def456 \|/)
  assert.match(markdown, /\| 저장소 상태 \| clean \| dirty \|/)
  assert.match(markdown, /\| 패키지 버전 \| 0\.13\.0 \| 0\.14\.0 \|/)
  assert.match(markdown, /\| 러너·스키마·루브릭 버전 \| 1\/1\/1 \| 1\/1\/1 \|/)
  assert.match(markdown, /\| 요청 모델 \| none \| model-b \|/)
  assert.match(markdown, /\| 실제 모델 \| unknown \| unknown \|/)
  assert.match(markdown, new RegExp(`\\| guidance common \\| ${'f'.repeat(64)} \\| ${'f'.repeat(64)} \\|`))
})

test('semantic rates in the markdown carry their raw numerators and denominators', () => {
  const reviewed = compareRuns(
    result({ review: review({ constraint: 'fail', scope: 'pass' }) }),
    result({ review: review({ constraint: 'fail', scope: 'fail' }) }),
  )
  const markdown = renderComparisonMarkdown(reviewed)
  assert.match(markdown, /제약 누락률 \| 100\.0% \(1\/1\) \| 100\.0% \(1\/1\)/)
  assert.match(markdown, /범위 추가율 \| 0\.0% \(0\/1\) \| 100\.0% \(1\/1\)/)
})

test('review denominators count distinct constraints and episodes, not review items', () => {
  const duplicated = review()
  duplicated.reviews = [
    { criterionId: 'constraint-omission', constraintId: 'c1', verdict: 'pass', quote: 'q', reason: 'r' },
    { criterionId: 'constraint-omission', constraintId: 'c1', verdict: 'fail', quote: '', requiredCondition: 'x', reason: 'r' },
    { criterionId: 'scope-addition', verdict: 'fail', quote: '', requiredCondition: 'y', reason: 'r' },
    { criterionId: 'scope-addition', verdict: 'fail', quote: '', requiredCondition: 'z', reason: 'r' },
  ]
  const comparison = compareRuns(result({ review: duplicated }), result({ review: duplicated }))
  assert.equal(comparison.pairs[0].baseline.reviews.constraints, 1)
  assert.equal(comparison.pairs[0].baseline.reviews.omissions, 1)
  assert.equal(comparison.pairs[0].baseline.reviews.scope, 1)
  assert.equal(comparison.pairs[0].baseline.reviews.additions, 1)
  assert.equal(comparison.summary.semanticRates.baselineConstraintOmissionRate, 1)
  assert.equal(comparison.summary.semanticRates.baselineScopeAdditionRate, 1)
})

test('comparison markdown escapes hostile model-derived text', () => {
  const baseline = result({ judgments: [judgment('r1', 'pass')] })
  const candidate = result({ judgments: [judgment('r1', 'fail', '| <script>alert(1)</script>\nnext')] })
  const markdown = renderComparisonMarkdown(compareRuns(baseline, candidate))
  assert.ok(!markdown.includes('<script>'))
  assert.ok(!markdown.includes('| <script>'))
  assert.match(markdown, /&lt;script&gt;/)
})

test('comparison output is exclusive and follows the extension', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'popt-compare-'))
  const comparison = compareRuns(result(), result())
  const markdownPath = path.join(dir, 'comparison.md')
  const jsonPath = path.join(dir, 'comparison.json')
  const markdown = await writeComparison(markdownPath, comparison)
  assert.match(markdown, /^# 평가 비교 보고서/)
  await assert.rejects(writeComparison(markdownPath, comparison), /refusing to overwrite/)
  const json = await writeComparison(jsonPath, comparison)
  assert.deepEqual(JSON.parse(json), comparison)
  assert.equal(formatComparison(comparison, markdownPath).startsWith('#'), true)
})

test('the compare CLI writes a report and refuses to overwrite it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'popt-compare-cli-'))
  const baselinePath = path.join(dir, 'baseline.json')
  const candidatePath = path.join(dir, 'candidate.json')
  const outPath = path.join(dir, 'comparison.md')
  await writeFile(baselinePath, JSON.stringify(result({ judgments: [judgment('r1', 'pass')] })))
  await writeFile(candidatePath, JSON.stringify(result({ judgments: [judgment('r1', 'fail')] })))

  const first = spawnSync(
    process.execPath,
    [COMPARE_CLI, '--baseline', baselinePath, '--candidate', candidatePath, '--out', outPath],
    { encoding: 'utf8' },
  )
  assert.equal(first.status, 0, first.stderr)
  const body = await readFile(outPath, 'utf8')
  assert.match(body, /회귀/)
  assert.match(body, /r1/)

  const second = spawnSync(
    process.execPath,
    [COMPARE_CLI, '--baseline', baselinePath, '--candidate', candidatePath, '--out', outPath],
    { encoding: 'utf8' },
  )
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /refusing to overwrite/)
  assert.equal(await readFile(outPath, 'utf8'), body)
})

test('validateResult rejects unrelated formats and unknown allow-change dimensions', () => {
  assert.throws(() => validateResult({}, 'x'), CompareError)
  assert.throws(() => validateResult({ metadata: { schemaVersion: 2 }, cases: [] }, 'x'), /schemaVersion/)
  assert.throws(
    () => compareRuns(result(), result(), { allowChange: ['rubric'] }),
    /unknown --allow-change/,
  )
})

test('compare args never take a following flag as a value', () => {
  assert.throws(
    () => parseCompareArgs(['--baseline', '--candidate', 'c.json', '--out', 'o.md']),
    /--baseline expects a value/,
  )
  assert.throws(
    () => parseCompareArgs(['--baseline', 'b.json', '--candidate', 'c.json', '--allow-change', '--out', 'o.md']),
    /--allow-change expects a value/,
  )
  const parsed = parseCompareArgs([
    '--baseline', 'b.json',
    '--candidate', 'c.json',
    '--out', 'o.md',
    '--allow-change', 'guidance',
  ])
  assert.equal(parsed.baseline, 'b.json')
  assert.equal(parsed.candidate, 'c.json')
  assert.equal(parsed.out, 'o.md')
  assert.deepEqual(parsed.allowChange, ['guidance'])
})
