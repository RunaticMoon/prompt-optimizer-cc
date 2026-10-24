import assert from 'node:assert/strict'
import test from 'node:test'

import {
  JudgeError,
  REVIEW_CRITERIA,
  gradeEpisode,
  gradeRound,
  mergeHumanReview,
  redactSensitive,
  scanSensitive,
} from './judge.mjs'

function rule(overrides = {}) {
  return { id: 'r1', kind: 'includes', round: 'final', field: 'draft', value: '로그인', ...overrides }
}

function reply(overrides = {}) {
  return { draft: '로그인 오류를 조사해줘.', message: '범위를 유지했습니다.', question: null, options: [], ...overrides }
}

test('includes and excludes grade exact Unicode literals per field', () => {
  assert.equal(gradeRound({ reply: reply(), rules: [rule()], round: 1, final: true }).judgments[0].status, 'pass')
  assert.equal(
    gradeRound({ reply: reply({ draft: '인증 오류를 조사해줘.' }), rules: [rule()], round: 1, final: true })
      .judgments[0].status,
    'fail',
  )
  assert.equal(
    gradeRound({
      reply: reply({ options: ['로그인 유지', '재설정'] }),
      rules: [rule({ field: 'options' })],
      round: 1,
      final: true,
    }).judgments[0].status,
    'pass',
  )
  assert.equal(
    gradeRound({
      reply: reply({ draft: '로그인을 수정해줘.' }),
      rules: [rule({ kind: 'excludes', value: '수정' })],
      round: 1,
      final: true,
    }).judgments[0].status,
    'fail',
  )
  assert.equal(
    gradeRound({
      reply: reply({ draft: '조사만 해줘.' }),
      rules: [rule({ kind: 'excludes', value: '수정' })],
      round: 1,
      final: true,
    }).judgments[0].status,
    'pass',
  )
})

test('question rules distinguish null from present and blank', () => {
  assert.equal(gradeRound({ reply: reply(), rules: [rule({ kind: 'questionNull' })], round: 1, final: true }).judgments[0].status, 'pass')
  assert.equal(
    gradeRound({ reply: reply({ question: '어떤 환경인가요?' }), rules: [rule({ kind: 'questionNull' })], round: 1, final: true })
      .judgments[0].status,
    'fail',
  )
  assert.equal(
    gradeRound({ reply: reply({ question: '어떤 환경인가요?' }), rules: [rule({ kind: 'questionPresent' })], round: 1, final: true })
      .judgments[0].status,
    'pass',
  )
  assert.equal(
    gradeRound({ reply: reply({ question: null }), rules: [rule({ kind: 'questionPresent' })], round: 1, final: true })
      .judgments[0].status,
    'fail',
  )
})

test('maxOptions and jsonContract check structure without model judgment', () => {
  assert.equal(
    gradeRound({ reply: reply({ question: 'q', options: ['a', 'b'] }), rules: [rule({ kind: 'maxOptions', max: 2 })], round: 1, final: true })
      .judgments[0].status,
    'pass',
  )
  assert.equal(
    gradeRound({ reply: reply({ question: 'q', options: ['a', 'b', 'c'] }), rules: [rule({ kind: 'maxOptions', max: 2 })], round: 1, final: true })
      .judgments[0].status,
    'fail',
  )
  assert.equal(
    gradeRound({ reply: reply(), rules: [rule({ kind: 'jsonContract' })], round: 1, final: true }).judgments[0].status,
    'pass',
  )
  assert.equal(
    gradeRound({ reply: reply({ question: null, options: ['x'] }), rules: [rule({ kind: 'jsonContract' })], round: 1, final: true })
      .judgments[0].status,
    'fail',
  )
})

test('rule scope distinguishes each, final and an integer round', () => {
  const rules = [
    rule({ id: 'each', kind: 'questionNull', round: 'each' }),
    rule({ id: 'final', kind: 'questionNull', round: 'final' }),
    rule({ id: 'round-two', kind: 'questionNull', round: 2 }),
  ]
  const episode = gradeEpisode({
    replies: [
      { round: 1, reply: reply({ question: 'q?' }) },
      { round: 2, reply: reply() },
    ],
    rules,
  })
  assert.deepEqual(
    episode.judgments.map(item => [item.ruleId, item.round, item.status]),
    [
      ['each', 1, 'fail'],
      ['each', 2, 'pass'],
      ['final', 2, 'pass'],
      ['round-two', 2, 'pass'],
    ],
  )
})

test('a rule for a round that never ran is not-applicable, never a pass', () => {
  const episode = gradeEpisode({
    replies: [{ round: 1, reply: reply() }],
    rules: [rule({ id: 'missing-round', kind: 'questionNull', round: 2 })],
  })
  assert.equal(episode.judgments[0].status, 'not-applicable')
  assert.equal(episode.rulePasses, 0)
  assert.equal(episode.ruleNotApplicable, 1)
})

test('a missing reply fails applicable rules; only raw-text rounds count as parse failures', () => {
  const episode = gradeEpisode({
    replies: [{ round: 1, reply: null, rawText: '{"draft":' }],
    rules: [rule({ kind: 'questionNull' }), rule({ id: 'r2', kind: 'jsonContract' })],
  })
  assert.equal(episode.parseFailures, 1)
  assert.equal(episode.ruleFailures, 2)
  assert.ok(episode.judgments.every(item => item.reason === 'reply-unavailable'))

  const transport = gradeEpisode({
    replies: [
      { round: 1, reply: null, rawText: null },
      { round: 2, reply: null, rawText: '' },
    ],
    rules: [rule({ kind: 'questionNull' })],
  })
  assert.equal(transport.parseFailures, 0)
  assert.equal(transport.ruleFailures, 1)
})

test('gradeRound only applies final rules when final is set', () => {
  const rules = [rule({ kind: 'questionNull', round: 'final' })]
  assert.equal(gradeRound({ reply: reply(), rules, round: 1, final: false }).judgments.length, 0)
  assert.equal(gradeRound({ reply: reply(), rules, round: 1, final: true }).judgments.length, 1)
})

function review(overrides = {}) {
  return {
    reviewVersion: 1,
    caseId: 'case-a',
    caseHash: 'a'.repeat(64),
    repeat: 1,
    reviewerId: 'reviewer-a',
    blindLabel: 'run-1',
    reviewedAt: '2026-10-02T12:00:00.000Z',
    reviews: [
      { criterionId: 'constraint-omission', verdict: 'pass', quote: '로그인 오류를 조사해줘.', reason: '제약 유지' },
    ],
    ...overrides,
  }
}

const RAW_TEXT = '{"draft":"로그인 오류를 조사해줘.","message":"범위를 유지했습니다.","question":null,"options":[]}'

function repeatWithRounds() {
  return { repeat: 1, rounds: [{ round: 1, rawText: RAW_TEXT }] }
}

const CASE_CONSTRAINTS = [{ id: 'keep-login', kind: 'mustInclude', description: 'd', severity: 'critical' }]

test('mergeHumanReview validates the minimum consumed fields', () => {
  const merged = mergeHumanReview(repeatWithRounds(), review(), {
    caseId: 'case-a',
    caseHash: 'a'.repeat(64),
  })
  assert.equal(merged.humanReview.reviewerId, 'reviewer-a')

  assert.throws(
    () => mergeHumanReview(repeatWithRounds(), review({ caseId: 'other' }), { caseId: 'case-a' }),
    JudgeError,
  )
  assert.throws(
    () => mergeHumanReview(repeatWithRounds(), review({ repeat: 2 }), { caseId: 'case-a' }),
    /repeat does not match/,
  )
  assert.throws(
    () => mergeHumanReview(repeatWithRounds(), review({ reviews: [] }), {}),
    /at least one criterion/,
  )
  assert.throws(
    () =>
      mergeHumanReview(
        repeatWithRounds(),
        review({ reviews: [{ criterionId: 'unknown', verdict: 'pass', quote: 'x', reason: 'y' }] }),
        {},
      ),
    /criterionId is unknown/,
  )
  assert.throws(
    () =>
      mergeHumanReview(
        repeatWithRounds(),
        review({ reviews: [{ criterionId: 'scope-addition', verdict: 'fail', quote: '', reason: 'y' }] }),
        {},
      ),
    /requiredCondition/,
  )
})

test('mergeHumanReview rejects a quote that is not verbatim round rawText', () => {
  const paraphrased = review({
    reviews: [{ criterionId: 'constraint-omission', verdict: 'pass', quote: '로그인 문제를 확인했습니다', reason: 'r' }],
  })
  assert.throws(
    () => mergeHumanReview(repeatWithRounds(), paraphrased, { caseId: 'case-a' }),
    /quote does not appear in this repeat's round rawText/,
  )
  assert.throws(
    () => mergeHumanReview({ repeat: 1, rounds: [] }, review(), { caseId: 'case-a' }),
    /quote does not appear/,
  )

  const merged = mergeHumanReview(
    repeatWithRounds(),
    review({
      reviews: [
        {
          criterionId: 'constraint-omission',
          verdict: 'fail',
          quote: '',
          reason: '그 조건을 뒷받침하는 출력 문장을 찾지 못했다',
          requiredCondition: '최종 초안에 로그인 범위가 남아 있어야 한다',
        },
      ],
    }),
    { caseId: 'case-a' },
  )
  assert.equal(merged.humanReview.reviews[0].requiredCondition.includes('로그인'), true)
})

test('mergeHumanReview rejects duplicate criterion items', () => {
  const duplicated = review({
    reviews: [
      { criterionId: 'scope-addition', verdict: 'pass', quote: '범위를 유지했습니다.', reason: 'r' },
      { criterionId: 'scope-addition', verdict: 'fail', quote: '', requiredCondition: 'x', reason: 'r' },
    ],
  })
  assert.throws(() => mergeHumanReview(repeatWithRounds(), duplicated, {}), /repeats scope-addition/)

  const perConstraint = review({
    reviews: [
      {
        criterionId: 'constraint-omission',
        constraintId: 'keep-login',
        verdict: 'pass',
        quote: '로그인 오류를 조사해줘.',
        reason: 'r',
      },
      {
        criterionId: 'constraint-omission',
        constraintId: 'keep-scope',
        verdict: 'pass',
        quote: '범위를 유지했습니다.',
        reason: 'r',
      },
    ],
  })
  const merged = mergeHumanReview(repeatWithRounds(), perConstraint, {
    constraints: [...CASE_CONSTRAINTS, { id: 'keep-scope', kind: 'mustPreserve', description: 'd', severity: 'major' }],
  })
  assert.equal(merged.humanReview.reviews.length, 2)
})

test('mergeHumanReview validates constraintId against the case constraints', () => {
  assert.throws(
    () =>
      mergeHumanReview(
        repeatWithRounds(),
        review({
          reviews: [
            { criterionId: 'scope-addition', constraintId: 'keep-login', verdict: 'pass', quote: 'q', reason: 'r' },
          ],
        }),
        { constraints: CASE_CONSTRAINTS },
      ),
    /constraintId is only valid for constraint-omission/,
  )
  assert.throws(
    () =>
      mergeHumanReview(
        repeatWithRounds(),
        review({
          reviews: [
            { criterionId: 'constraint-omission', constraintId: 'made-up', verdict: 'pass', quote: 'q', reason: 'r' },
          ],
        }),
        { constraints: CASE_CONSTRAINTS },
      ),
    /constraintId does not name a constraint of this case/,
  )

  const merged = mergeHumanReview(
    repeatWithRounds(),
    review({
      reviews: [
        {
          criterionId: 'constraint-omission',
          constraintId: 'keep-login',
          verdict: 'pass',
          quote: '로그인 오류를 조사해줘.',
          reason: 'r',
        },
      ],
    }),
    { constraints: CASE_CONSTRAINTS },
  )
  assert.equal(merged.humanReview.reviews[0].constraintId, 'keep-login')
})

test('mergeHumanReview fails closed when a constraintId has no constraints array', () => {
  const withConstraint = review({
    reviews: [
      {
        criterionId: 'constraint-omission',
        constraintId: 'keep-login',
        verdict: 'pass',
        quote: '로그인 오류를 조사해줘.',
        reason: 'r',
      },
    ],
  })
  assert.throws(
    () => mergeHumanReview(repeatWithRounds(), withConstraint, {}),
    /constraintId requires the case constraints array/,
  )
  assert.throws(
    () => mergeHumanReview(repeatWithRounds(), withConstraint, { constraints: [] }),
    /constraintId requires the case constraints array/,
  )

  const merged = mergeHumanReview(repeatWithRounds(), withConstraint, { constraints: CASE_CONSTRAINTS })
  assert.equal(merged.humanReview.reviews[0].constraintId, 'keep-login')
})

test('review criteria are the documented set', () => {
  assert.deepEqual(REVIEW_CRITERIA, [
    'constraint-omission',
    'scope-addition',
    'unnecessary-question',
    'evidence-grounding',
    'intent-preservation',
    'draft-usefulness',
    'open-decisions',
    'language-literal-fidelity',
    'rounds-tokens-latency',
  ])
})

test('credential-shaped text is detected and redacted without leaking the value', () => {
  const aws = 'AKIA' + 'A'.repeat(16)
  const github = `ghp_${'b'.repeat(30)}`
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----'
  const text = `key=${aws} token=${github}\n${pem}`
  const scan = scanSensitive(text)
  assert.ok(scan.findings.includes('aws-key'))
  assert.ok(scan.findings.includes('github-token'))
  assert.ok(scan.findings.includes('private-key'))
  assert.ok(!JSON.stringify(scan).includes(aws))

  const redacted = redactSensitive(text)
  assert.ok(redacted.findings.includes('aws-key'))
  assert.ok(!redacted.text.includes(aws))
  assert.ok(!redacted.text.includes(github))
  assert.ok(!redacted.text.includes('MIIEsecret'))
  assert.match(redacted.text, /\[REDACTED:aws-key\]/)
})

test('ordinary Korean and code text is not flagged', () => {
  assert.deepEqual(
    scanSensitive('로그인 오류를 조사하고 parseAccount()와 https://api.example.com/v2/users를 유지해줘.').findings,
    [],
  )
})
