import assert from 'node:assert/strict'
import test from 'node:test'

import { escapeMarkdownCell, isParseFailureRound, summarizeRun } from './report.mjs'

function judgment(id, status, extra = {}) {
  return { ruleId: id, kind: 'includes', round: 1, field: 'draft', value: 'x', status, evidence: `${id} ${status}`, reason: status, ...extra }
}

function repeat(overrides = {}) {
  return {
    repeat: 1,
    status: 'completed',
    stopReason: 'question-null',
    rounds: [
      {
        round: 1,
        reply: { draft: 'draft', message: 'm', question: null, options: [] },
        judgments: [judgment('r1', 'pass'), judgment('r2', 'fail')],
        durationMs: 10,
        usage: {
          known: true,
          synthetic: true,
          counts: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
        },
      },
    ],
    error: null,
    ...overrides,
  }
}

function result(overrides = {}) {
  return {
    metadata: {
      schemaVersion: 1,
      runnerVersion: '1',
      rubricVersion: '1',
      mode: 'mock',
      suite: 'development',
      nodeVersion: 'v26.12.0',
      packageVersion: '0.13.0',
      repoSha: 'abc123',
      dirty: false,
      adapter: null,
      model: { requested: null, actual: null },
      guidance: { profiles: { common: { version: 'f'.repeat(64), chars: 3974 } } },
      settings: { repeats: 1, maxRounds: 1, maxCalls: 1, maxCallMs: 120000 },
      plannedCalls: 1,
      attemptedCalls: 1,
      completedCalls: 1,
      startedAt: '2026-10-02T12:00:00.000Z',
      endedAt: '2026-10-02T12:00:01.000Z',
      ...overrides.metadata,
    },
    cases: overrides.cases ?? [
      {
        caseId: 'case-a',
        caseHash: 'a'.repeat(64),
        tags: [],
        repeats: [repeat()],
      },
    ],
  }
}

test('summarizeRun counts rules, rounds, questions and latency', () => {
  const summary = summarizeRun(result())
  assert.equal(summary.totals.cases, 1)
  assert.equal(summary.totals.episodes, 1)
  assert.equal(summary.totals.rounds, 1)
  assert.equal(summary.totals.rulePasses, 1)
  assert.equal(summary.totals.ruleFailures, 1)
  assert.equal(summary.rates.rulePassRate, 0.5)
  assert.equal(summary.latency.method.includes('nearest-rank'), true)
  assert.equal(summary.latency.medianMs, 10)
  assert.equal(summary.latency.p90Ms, 10)
  assert.equal(summary.usage.knownEpisodes, 1)
  assert.equal(summary.usage.totals.input_tokens, 10)
  assert.equal(summary.usage.perTask.input_tokens, 10)
  assert.equal(summary.mode, 'mock')
  assert.match(summary.label, /no semantic-quality conclusion/)
})

test('unreviewed semantic data is N/A and never zero', () => {
  const summary = summarizeRun(result())
  assert.equal(summary.semantic.status, 'unreviewed')
  assert.equal(summary.semantic.reviewedEpisodes, 0)
  assert.equal(summary.semantic.unreviewedEpisodes, 1)
  assert.equal(summary.semantic.constraintOmissionRate, null)
  assert.equal(summary.semantic.scopeAdditionRate, null)
  assert.equal(summary.semantic.unnecessaryQuestionRate, null)
})

test('reviewed rates use reviewed denominators and missing reviews stay unreviewed', () => {
  const reviewed = repeat({
    humanReview: {
      reviewVersion: 1,
      reviews: [
        { criterionId: 'constraint-omission', constraintId: 'c1', verdict: 'pass', quote: 'q', reason: 'r' },
        { criterionId: 'constraint-omission', constraintId: 'c2', verdict: 'fail', quote: 'q', reason: 'r' },
        { criterionId: 'scope-addition', verdict: 'fail', quote: 'q', reason: 'r' },
        { criterionId: 'unnecessary-question', verdict: 'fail', quote: 'q', reason: 'r' },
      ],
    },
  })
  const unreviewed = repeat({ repeat: 2 })
  const summary = summarizeRun(
    result({
      cases: [{ caseId: 'case-a', caseHash: 'a'.repeat(64), tags: [], repeats: [reviewed, unreviewed] }],
    }),
  )
  assert.equal(summary.semantic.status, 'partially-reviewed')
  assert.equal(summary.semantic.reviewedEpisodes, 1)
  assert.equal(summary.semantic.reviewedConstraints, 2)
  assert.equal(summary.semantic.constraintOmissions, 1)
  assert.equal(summary.semantic.constraintOmissionRate, 0.5)
  assert.equal(summary.semantic.scopeAdditionRate, 1)
  assert.equal(summary.semantic.unnecessaryQuestions, 1)
})

test('latency uses median and nearest-rank p90 over available durations', () => {
  const rounds = [10, 20, 30].map((duration, index) => ({
    round: index + 1,
    reply: { draft: 'd', message: 'm', question: null, options: [] },
    judgments: [],
    durationMs: duration,
    usage: { known: false, counts: null },
  }))
  const summary = summarizeRun(
    result({
      cases: [{ caseId: 'case-a', caseHash: 'a'.repeat(64), tags: [], repeats: [repeat({ rounds })] }],
    }),
  )
  assert.equal(summary.latency.medianMs, 20)
  assert.equal(summary.latency.p90Ms, 30)
  assert.equal(summary.usage.knownEpisodes, 0)
  assert.equal(summary.usage.perTask, null)
})

test('failure buckets separate failed, diverged, timeout, unsupported and cap', () => {
  const statuses = ['failed', 'scenario-diverged', 'timeout', 'unsupported', 'cap', 'capped']
  const cases = statuses.map((status, index) => ({
    caseId: `case-${index}`,
    caseHash: String(index).repeat(64).slice(0, 64),
    tags: [],
    repeats: [repeat({ status, rounds: [] })],
  }))
  const summary = summarizeRun(result({ cases }))
  assert.equal(summary.totals.failedEpisodes, 1)
  assert.equal(summary.totals.divergedEpisodes, 1)
  assert.equal(summary.totals.timedOutEpisodes, 1)
  assert.equal(summary.totals.unsupportedEpisodes, 1)
  assert.equal(summary.totals.capSkippedEpisodes, 1)
  assert.equal(summary.totals.cappedEpisodes, 1)
  assert.equal(summary.failures.failed.length, 1)
  assert.equal(summary.failures.timeout.length, 1)
})

test('questions count rounds and episodes that end with a question', () => {
  const rounds = [
    { round: 1, reply: { draft: 'd', message: 'm', question: 'q1?', options: ['a'] }, judgments: [], durationMs: 1, usage: { known: false, counts: null } },
    { round: 2, reply: { draft: 'd2', message: 'm', question: null, options: [] }, judgments: [], durationMs: 1, usage: { known: false, counts: null } },
  ]
  const summary = summarizeRun(
    result({
      cases: [{ caseId: 'case-a', caseHash: 'a'.repeat(64), tags: [], repeats: [repeat({ rounds })] }],
    }),
  )
  assert.equal(summary.questionCounts.questions, 1)
  assert.equal(summary.questionCounts.episodesEndingWithQuestion, 0)
  assert.equal(summary.rates.roundsPerTask, 2)
})

test('escapeMarkdownCell neutralizes tables and HTML from model text', () => {
  const escaped = escapeMarkdownCell('| <script>alert(1)</script> `x`\nsecond | row', 120)
  assert.ok(!escaped.includes('<script>'))
  assert.ok(!escaped.includes('\n'))
  assert.match(escaped, /&lt;script&gt;/)
  assert.match(escaped, /\\\|/)
  assert.match(escaped, /\\`x\\`/)
})

test('escapeMarkdownCell escapes backslashes before pipes, so a hostile cell cannot split a table', () => {
  const escaped = escapeMarkdownCell('a \\| b', 120)
  assert.equal(escaped, 'a \\\\\\| b')

  const row = `| ${escaped} |`
  const cells = row.slice(2, -2).match(/(?<!\\)\|/g)
  assert.equal(cells, null)

  const double = escapeMarkdownCell('\\\\', 120)
  assert.equal(double, '\\\\\\\\')

  const cr = escapeMarkdownCell('x\ry', 120)
  assert.equal(cr, 'x y')
  assert.ok(!cr.includes('\r'))
})

test('parse failures count only rounds whose raw text did not parse', () => {
  const parsedRound = {
    round: 1,
    reply: { draft: 'd', message: 'm', question: null, options: [] },
    judgments: [],
    durationMs: 1,
    usage: { known: false, counts: null },
  }
  const parseFailureRound = { ...parsedRound, round: 2, reply: null, rawText: '{"draft":' }
  const transportFailureRound = { ...parsedRound, round: 3, reply: null, rawText: null }
  const emptyTextRound = { ...parsedRound, round: 4, reply: null, rawText: '' }

  assert.equal(isParseFailureRound(parsedRound), false)
  assert.equal(isParseFailureRound(parseFailureRound), true)
  assert.equal(isParseFailureRound(transportFailureRound), false)
  assert.equal(isParseFailureRound(emptyTextRound), false)

  const summary = summarizeRun(
    result({
      cases: [
        {
          caseId: 'case-a',
          caseHash: 'a'.repeat(64),
          tags: [],
          repeats: [repeat({ rounds: [parsedRound, parseFailureRound, transportFailureRound, emptyTextRound] })],
        },
      ],
    }),
  )
  assert.equal(summary.totals.rounds, 4)
  assert.equal(summary.totals.completedRounds, 1)
  assert.equal(summary.totals.parseFailures, 1)
  assert.equal(summary.rates.parseFailureRate, 0.25)
})

test('escapeMarkdownCell neutralizes tables and HTML from model text', () => {
  const escaped = escapeMarkdownCell('| <script>alert(1)</script> `x`\nsecond | row', 120)
  assert.ok(!escaped.includes('<script>'))
  assert.ok(!escaped.includes('\n'))
  assert.match(escaped, /&lt;script&gt;/)
  assert.match(escaped, /\\\|/)
  assert.match(escaped, /\\`x\\`/)
})

test('zero denominators produce null rates, not percentage claims', () => {
  const summary = summarizeRun(
    result({
      cases: [
        {
          caseId: 'case-a',
          caseHash: 'a'.repeat(64),
          tags: [],
          repeats: [repeat({ rounds: [], status: 'completed' })],
        },
      ],
    }),
  )
  assert.equal(summary.rates.rulePassRate, null)
  assert.equal(summary.rates.parseFailureRate, null)
  assert.equal(summary.latency.medianMs, null)
})
