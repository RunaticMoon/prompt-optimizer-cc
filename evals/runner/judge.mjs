/**
 * Deterministic rule judging for one replayed evaluation episode.
 *
 * Rules are lexical/structural signals only: an `includes` miss is not proof
 * that a synonym was semantically omitted, and a passing literal never proves
 * semantic quality. Human review is a separate versioned record (see
 * `evals/rubric/`), never produced here.
 *
 * This module also owns the credential-shaped-text backstop used before a
 * transport call and before writing raw model text.
 */

export const REVIEW_CRITERIA = [
  'constraint-omission',
  'scope-addition',
  'unnecessary-question',
  'evidence-grounding',
  'intent-preservation',
  'draft-usefulness',
  'open-decisions',
  'language-literal-fidelity',
  'rounds-tokens-latency',
]

export const VERDICTS = ['pass', 'fail', 'not-applicable']
export const MAX_OPTIONS = 4

const FIELD_NAMES = ['draft', 'message', 'question', 'options']

/** A validation failure for a review record or comparison input. */
export class JudgeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JudgeError'
  }
}

/**
 * Token-shaped credential patterns. These are hygiene backstops, not proof
 * that arbitrary supplied data is safe or that a value is actually a secret.
 */
const SECRET_PATTERNS = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'openai-token', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi },
  {
    kind: 'assigned-secret',
    pattern: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}["']?/gi,
  },
]

/** Returns unique credential-shaped kinds without returning the values. */
export function scanSensitive(text) {
  if (typeof text !== 'string') return { findings: [] }
  const findings = []
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) findings.push(kind)
  }
  return { findings }
}

/** Replaces credential-shaped text with a redacted marker. */
export function redactSensitive(text) {
  if (typeof text !== 'string') return { text, findings: [] }
  let output = text
  const findings = []
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (!pattern.test(output)) continue
    findings.push(kind)
    pattern.lastIndex = 0
    output = output.replace(pattern, `[REDACTED:${kind}]`)
  }
  return { text: output, findings }
}

function fail(message) {
  throw new JudgeError(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fieldTexts(reply, field) {
  if (!isPlainObject(reply)) return []
  if (field === 'draft') return typeof reply.draft === 'string' ? [reply.draft] : []
  if (field === 'message') return typeof reply.message === 'string' ? [reply.message] : []
  if (field === 'question') return typeof reply.question === 'string' ? [reply.question] : []
  if (field === 'options') {
    return Array.isArray(reply.options)
      ? reply.options.filter(option => typeof option === 'string')
      : []
  }
  return []
}

function describe(rule) {
  return rule.field === undefined ? rule.kind : `${rule.kind} ${rule.field}`
}

function gradeOne(rule, round, reply) {
  const base = {
    ruleId: rule.id,
    kind: rule.kind,
    round,
    field: rule.field ?? null,
    value: rule.value ?? rule.max ?? null,
  }
  if (!isPlainObject(reply)) {
    return {
      ...base,
      status: 'fail',
      evidence: 'no parsed model reply for this round',
      reason: 'reply-unavailable',
    }
  }

  if (rule.kind === 'includes' || rule.kind === 'excludes') {
    const texts = fieldTexts(reply, rule.field)
    const present = texts.some(text => text.includes(rule.value))
    if (rule.kind === 'includes') {
      return present
        ? { ...base, status: 'pass', evidence: `${rule.field} contains ${JSON.stringify(rule.value)}`, reason: 'literal-present' }
        : { ...base, status: 'fail', evidence: `${rule.field} does not contain ${JSON.stringify(rule.value)}`, reason: 'literal-missing' }
    }
    return present
      ? { ...base, status: 'fail', evidence: `${rule.field} contains forbidden ${JSON.stringify(rule.value)}`, reason: 'forbidden-literal-present' }
      : { ...base, status: 'pass', evidence: `${rule.field} does not contain ${JSON.stringify(rule.value)}`, reason: 'forbidden-literal-absent' }
  }

  if (rule.kind === 'questionNull') {
    return reply.question === null || reply.question === undefined
      ? { ...base, status: 'pass', evidence: 'question is null', reason: 'question-null' }
      : { ...base, status: 'fail', evidence: 'question is present', reason: 'question-present' }
  }

  if (rule.kind === 'questionPresent') {
    return typeof reply.question === 'string' && reply.question.trim() !== ''
      ? { ...base, status: 'pass', evidence: 'question is present', reason: 'question-present' }
      : { ...base, status: 'fail', evidence: 'question is null or blank', reason: 'question-missing' }
  }

  if (rule.kind === 'maxOptions') {
    const count = Array.isArray(reply.options) ? reply.options.length : 0
    return count <= rule.max
      ? { ...base, status: 'pass', evidence: `option count ${count} <= ${rule.max}`, reason: 'option-count-in-budget' }
      : { ...base, status: 'fail', evidence: `option count ${count} > ${rule.max}`, reason: 'too-many-options' }
  }

  if (rule.kind === 'jsonContract') {
    const problems = []
    if (typeof reply.draft !== 'string' || reply.draft.trim() === '') problems.push('draft')
    if (typeof reply.message !== 'string') problems.push('message')
    if (reply.question !== null && typeof reply.question !== 'string') problems.push('question')
    if (!Array.isArray(reply.options)) problems.push('options')
    else if (reply.options.length > MAX_OPTIONS) problems.push('option-count')
    if (reply.question === null && Array.isArray(reply.options) && reply.options.length > 0) {
      problems.push('options-without-question')
    }
    return problems.length === 0
      ? { ...base, status: 'pass', evidence: 'parsed reply satisfies the JSON contract shape', reason: 'json-contract' }
      : { ...base, status: 'fail', evidence: `invalid JSON contract fields: ${problems.join(', ')}`, reason: 'json-contract' }
  }

  return {
    ...base,
    status: 'fail',
    evidence: `unknown rule kind ${JSON.stringify(rule.kind)}`,
    reason: 'unknown-rule',
  }
}

/**
 * Grades the rules that apply to one round. `final` rules apply only when
 * `final` is true, which the core runner sets on the last executed round.
 */
export function gradeRound({ reply, rules, round, final = false }) {
  if (!Array.isArray(rules)) fail('rules must be an array')
  const applicable = rules.filter(
    rule => rule.round === 'each' || rule.round === round || (rule.round === 'final' && final),
  )
  return {
    round,
    judgments: applicable.map(rule => gradeOne(rule, round, reply)),
  }
}

/**
 * Grades a whole episode. `replies` is ordered and each item is
 * `{round, reply}` where `reply` is null when parsing failed. Rules scoped to
 * a round that never ran are `not-applicable`, not passes.
 */
export function gradeEpisode({ caseId = null, replies, rules }) {
  if (!Array.isArray(replies)) fail('replies must be an array')
  if (!Array.isArray(rules)) fail('rules must be an array')
  const ordered = [...replies].sort((left, right) => left.round - right.round)
  const finalRound = ordered.length === 0 ? null : ordered[ordered.length - 1].round
  const judgments = []
  let parseFailures = 0
  for (const item of ordered) {
    if (!isPlainObject(item.reply)) parseFailures += 1
  }

  for (const rule of rules) {
    let targets
    if (rule.round === 'each') {
      targets = ordered
    } else if (rule.round === 'final') {
      targets = finalRound === null ? [] : ordered.filter(item => item.round === finalRound)
    } else {
      targets = ordered.filter(item => item.round === rule.round)
    }
    if (targets.length === 0) {
      judgments.push({
        ruleId: rule.id,
        kind: rule.kind,
        round: rule.round,
        field: rule.field ?? null,
        value: rule.value ?? rule.max ?? null,
        status: 'not-applicable',
        evidence: 'the scoped round did not run',
        reason: 'round-not-executed',
      })
      continue
    }
    for (const item of targets) judgments.push(gradeOne(rule, item.round, item.reply))
  }

  const counts = { pass: 0, fail: 0, 'not-applicable': 0 }
  for (const judgment of judgments) counts[judgment.status] += 1
  return {
    caseId,
    judgments,
    parseFailures,
    rulePasses: counts.pass,
    ruleFailures: counts.fail,
    ruleNotApplicable: counts['not-applicable'],
  }
}

/** Validates and merges one human review onto a case repeat record. */
export function mergeHumanReview(repeat, review, { caseId, caseHash } = {}) {
  if (!isPlainObject(repeat)) fail('repeat must be an object')
  if (!isPlainObject(review)) fail('human review must be an object')
  if (review.reviewVersion !== 1) fail('human review must declare reviewVersion 1')
  if (caseId !== undefined && review.caseId !== caseId) fail('human review caseId does not match')
  if (caseHash !== undefined && review.caseHash !== caseHash) fail('human review caseHash does not match')
  if (!Number.isInteger(review.repeat) || review.repeat !== repeat.repeat) {
    fail('human review repeat does not match')
  }
  if (typeof review.reviewerId !== 'string' || review.reviewerId.trim() === '') {
    fail('human review needs a reviewerId')
  }
  if (typeof review.blindLabel !== 'string' || review.blindLabel.trim() === '') {
    fail('human review needs a blindLabel')
  }
  if (typeof review.reviewedAt !== 'string' || Number.isNaN(Date.parse(review.reviewedAt))) {
    fail('human review needs an ISO reviewedAt')
  }
  if (!Array.isArray(review.reviews) || review.reviews.length === 0) {
    fail('human review needs at least one criterion review')
  }
  for (const [index, item] of review.reviews.entries()) {
    if (!isPlainObject(item)) fail(`human review reviews[${index}] must be an object`)
    if (!REVIEW_CRITERIA.includes(item.criterionId)) {
      fail(`human review reviews[${index}].criterionId is unknown`)
    }
    if (!VERDICTS.includes(item.verdict)) fail(`human review reviews[${index}].verdict is invalid`)
    if (typeof item.quote !== 'string') fail(`human review reviews[${index}].quote must be a string`)
    if (typeof item.reason !== 'string' || item.reason.trim() === '') {
      fail(`human review reviews[${index}].reason must be nonempty`)
    }
    if (item.verdict === 'fail' && item.quote.trim() === '' && item.requiredCondition === undefined) {
      fail(`human review reviews[${index}] needs a quote or requiredCondition for a fail verdict`)
    }
  }
  return { ...repeat, humanReview: review }
}

/** Exposed for compare/report so the field vocabulary stays in one place. */
export function isRuleField(field) {
  return FIELD_NAMES.includes(field)
}

/** A short human label for a rule, used in diagnostics. */
export function ruleLabel(rule) {
  return `${rule.id} (${describe(rule)})`
}
