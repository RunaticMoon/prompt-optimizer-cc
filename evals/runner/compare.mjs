/**
 * Paired comparison of two evaluation results.
 *
 * Comparison is deliberately fail-closed: different corpus hashes, modes,
 * schema/rubric versions, adapter kinds, models or settings are rejected unless
 * the corresponding dimension is listed with `--allow-change`. A changed
 * dimension makes the comparison confounded; it is never presented as causal
 * prompt improvement.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { escapeMarkdownCell, summarizeRun } from './report.mjs'

export const COMPARISON_VERSION = 1
export const ALLOWED_CHANGES = ['guidance', 'model', 'settings']
const MAX_RESULT_BYTES = 64 * 1024 * 1024

export class CompareError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CompareError'
  }
}

function fail(message) {
  throw new CompareError(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(',')}}`
}

function changedFields(left, right, prefix = '') {
  if (stable(left) === stable(right)) return []
  if (!isPlainObject(left) || !isPlainObject(right)) return [prefix === '' ? '(value)' : prefix]
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const changes = []
  for (const key of [...keys].sort()) {
    const field = prefix === '' ? key : `${prefix}.${key}`
    changes.push(...changedFields(left[key], right[key], field))
  }
  return changes
}

/** Validates the result envelope enough to compare it safely. */
export function validateResult(run, label = 'result') {
  if (!isPlainObject(run)) fail(`${label}: expected a result object`)
  const metadata = run.metadata
  if (!isPlainObject(metadata)) fail(`${label}: missing metadata object`)
  if (metadata.schemaVersion !== 1) fail(`${label}: unsupported result schemaVersion`)
  if (metadata.mode !== 'mock' && metadata.mode !== 'live') {
    fail(`${label}: metadata.mode must be mock or live`)
  }
  if (typeof metadata.suite !== 'string') fail(`${label}: metadata.suite must be a string`)
  if (!Array.isArray(run.cases)) fail(`${label}: cases must be an array`)
  const seen = new Set()
  for (const [index, caseItem] of run.cases.entries()) {
    if (!isPlainObject(caseItem)) fail(`${label}: cases[${index}] must be an object`)
    if (typeof caseItem.caseId !== 'string' || caseItem.caseId === '') {
      fail(`${label}: cases[${index}].caseId must be a nonempty string`)
    }
    if (typeof caseItem.caseHash !== 'string' || !/^[a-f0-9]{64}$/.test(caseItem.caseHash)) {
      fail(`${label}: case ${caseItem.caseId}: caseHash must be a sha256`)
    }
    if (!Array.isArray(caseItem.repeats) || caseItem.repeats.length === 0) {
      fail(`${label}: case ${caseItem.caseId}: repeats must be a nonempty array`)
    }
    for (const repeat of caseItem.repeats) {
      if (!isPlainObject(repeat) || !Number.isInteger(repeat.repeat) || repeat.repeat < 1) {
        fail(`${label}: case ${caseItem.caseId}: invalid repeat number`)
      }
      const key = `${caseItem.caseId}\u0000${caseItem.caseHash}\u0000${repeat.repeat}`
      if (seen.has(key)) fail(`${label}: duplicate case/repeat ${caseItem.caseId}#${repeat.repeat}`)
      seen.add(key)
      if (!Array.isArray(repeat.rounds)) {
        fail(`${label}: case ${caseItem.caseId}#${repeat.repeat}: rounds must be an array`)
      }
    }
  }
  return run
}

function corpusHash(run) {
  if (typeof run.metadata.corpusHash === 'string' && /^[a-f0-9]{64}$/.test(run.metadata.corpusHash)) {
    return run.metadata.corpusHash
  }
  const signature = run.cases
    .map(item => `${item.caseId}:${item.caseHash}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(signature, 'utf8').digest('hex')
}

function pairIndex(run) {
  const index = new Map()
  for (const caseItem of run.cases) {
    for (const repeat of caseItem.repeats) {
      index.set(`${caseItem.caseId}\u0000${caseItem.caseHash}\u0000${repeat.repeat}`, {
        caseItem,
        repeat,
      })
    }
  }
  return index
}

function judgmentMap(repeat) {
  const map = new Map()
  for (const round of repeat.rounds ?? []) {
    for (const judgment of round.judgments ?? []) {
      map.set(`${round.round}\u0000${judgment.ruleId}`, judgment)
    }
  }
  return map
}

function reviewCounts(repeat) {
  const review = repeat.humanReview
  if (!isPlainObject(review) || !Array.isArray(review.reviews)) {
    return { reviewed: false, constraints: null, omissions: null, scope: null, additions: null, unnecessary: null }
  }
  let constraints = 0
  let omissions = 0
  let scope = 0
  let additions = 0
  let unnecessary = 0
  for (const item of review.reviews) {
    if (item.criterionId === 'constraint-omission' && (item.verdict === 'pass' || item.verdict === 'fail')) {
      constraints += 1
      if (item.verdict === 'fail') omissions += 1
    }
    if (item.criterionId === 'scope-addition' && (item.verdict === 'pass' || item.verdict === 'fail')) {
      scope += 1
      if (item.verdict === 'fail') additions += 1
    }
    if (item.criterionId === 'unnecessary-question' && item.verdict === 'fail') unnecessary += 1
  }
  return { reviewed: true, constraints, omissions, scope, additions, unnecessary }
}

function durations(repeat) {
  return (repeat.rounds ?? [])
    .map(round => round.durationMs)
    .filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function usageTotals(repeat) {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    known: false,
  }
  for (const round of repeat.rounds ?? []) {
    if (!isPlainObject(round.usage) || round.usage.known !== true) continue
    totals.known = true
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const value = round.usage.counts?.[key]
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] += value
    }
  }
  return totals
}

function statusCounts(run) {
  const counts = {}
  for (const caseItem of run.cases) {
    for (const repeat of caseItem.repeats) {
      counts[repeat.status] = (counts[repeat.status] ?? 0) + 1
    }
  }
  return counts
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function p90(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)]
}

function sideSummary(run) {
  const summary = summarizeRun(run)
  return {
    mode: summary.mode,
    suite: summary.suite,
    statusCounts: statusCounts(run),
    rulePasses: summary.totals.rulePasses,
    ruleFailures: summary.totals.ruleFailures,
    parseFailures: summary.totals.parseFailures,
    rounds: summary.totals.rounds,
    completedRounds: summary.totals.completedRounds,
    questions: summary.questionCounts.questions,
    latency: summary.latency,
    usage: summary.usage,
    semantic: summary.semantic,
  }
}

/**
 * Compares a baseline and candidate result. Throws for incompatible inputs;
 * otherwise returns a JSON-serializable comparison with paired details and
 * unresolved conditions.
 */
export function compareRuns(baseline, candidate, { allowChange = [] } = {}) {
  validateResult(baseline, 'baseline')
  validateResult(candidate, 'candidate')
  const allowed = [...new Set(allowChange)]
  for (const value of allowed) {
    if (!ALLOWED_CHANGES.includes(value)) fail(`unknown --allow-change dimension: ${value}`)
  }

  const baseMeta = baseline.metadata
  const candMeta = candidate.metadata
  const changedDimensions = []
  const unresolved = []

  if (baseMeta.schemaVersion !== candMeta.schemaVersion) fail('result schemaVersion differs')
  if (baseMeta.runnerVersion !== candMeta.runnerVersion) fail('runner version differs')
  if (baseMeta.rubricVersion !== candMeta.rubricVersion) fail('rubric version differs')
  if (baseMeta.mode !== candMeta.mode) fail('mock and live results cannot be compared')
  if (baseMeta.suite !== candMeta.suite) fail('evaluation suite differs')
  if (corpusHash(baseline) !== corpusHash(candidate)) fail('corpus hash differs; cases are not paired')

  const adapterKind = run => run.metadata.adapter?.kind ?? (run.metadata.mode === 'mock' ? 'mock' : null)
  if (adapterKind(baseline) !== adapterKind(candidate)) {
    fail('runtime adapter kind differs; results are not comparable')
  }
  const adapterHashes = [baseline.metadata.adapter?.hash, candidate.metadata.adapter?.hash].filter(
    value => typeof value === 'string',
  )
  if (adapterHashes.length === 2 && adapterHashes[0] !== adapterHashes[1]) {
    unresolved.push('adapter implementation hash differs between runs')
  }

  const settingsChanges = changedFields(baseMeta.settings ?? {}, candMeta.settings ?? {})
  if (settingsChanges.length > 0) {
    if (!allowed.includes('settings')) {
      fail(`settings differ (${settingsChanges.join(', ')}); pass --allow-change settings to compare`)
    }
    changedDimensions.push('settings')
  }

  const baseGuidance = stable(baseMeta.guidance ?? {})
  const candGuidance = stable(candMeta.guidance ?? {})
  if (baseGuidance !== candGuidance) {
    if (!allowed.includes('guidance')) {
      fail('guidance version differs; pass --allow-change guidance to compare')
    }
    changedDimensions.push('guidance')
  }

  const baseModel = baseMeta.model ?? {}
  const candModel = candMeta.model ?? {}
  const modelChanges = changedFields(
    { requested: baseModel.requested, actual: baseModel.actual },
    { requested: candModel.requested, actual: candModel.actual },
  )
  if (modelChanges.length > 0) {
    if (!allowed.includes('model')) {
      fail(`model identity differs (${modelChanges.join(', ')}); pass --allow-change model to compare`)
    }
    changedDimensions.push('model')
  }
  if (
    baseMeta.mode === 'live' &&
    (baseModel.actual === null ||
      baseModel.actual === undefined ||
      candModel.actual === null ||
      candModel.actual === undefined)
  ) {
    unresolved.push('actual model identity is unknown for at least one run')
  }

  const baseCaseHashes = new Map(baseline.cases.map(item => [item.caseId, item.caseHash]))
  const candCaseHashes = new Map(candidate.cases.map(item => [item.caseId, item.caseHash]))
  for (const [caseId, hash] of baseCaseHashes) {
    if (!candCaseHashes.has(caseId)) fail(`candidate is missing case ${caseId}`)
    if (candCaseHashes.get(caseId) !== hash) fail(`case hash differs for ${caseId}`)
  }
  for (const caseId of candCaseHashes.keys()) {
    if (!baseCaseHashes.has(caseId)) fail(`candidate has an extra case ${caseId}`)
  }

  const basePairs = pairIndex(baseline)
  const candPairs = pairIndex(candidate)
  if (basePairs.size !== candPairs.size) {
    fail(`case/repeat count differs (${basePairs.size} vs ${candPairs.size})`)
  }
  const pairs = []
  for (const [key, base] of basePairs) {
    const cand = candPairs.get(key)
    if (cand === undefined) fail(`candidate is missing case/repeat ${key.replace(/\u0000/g, '#')}`)
    const baseRules = judgmentMap(base.repeat)
    const candRules = judgmentMap(cand.repeat)
    const improvements = []
    const regressions = []
    const newlyJudged = []
    for (const [ruleKey, baseJudgment] of baseRules) {
      const candJudgment = candRules.get(ruleKey)
      const [round, ruleId] = ruleKey.split('\u0000')
      if (candJudgment === undefined) {
        newlyJudged.push({ round: Number(round), ruleId, change: 'judgment-removed' })
        continue
      }
      if (baseJudgment.status === 'fail' && candJudgment.status === 'pass') {
        improvements.push({ round: Number(round), ruleId })
      }
      if (baseJudgment.status === 'pass' && candJudgment.status === 'fail') {
        regressions.push({ round: Number(round), ruleId, evidence: candJudgment.evidence })
      }
    }
    for (const [ruleKey, candJudgment] of candRules) {
      if (baseRules.has(ruleKey)) continue
      const [round, ruleId] = ruleKey.split('\u0000')
      newlyJudged.push({ round: Number(round), ruleId, change: 'judgment-added', status: candJudgment.status })
    }

    const baseReview = reviewCounts(base.repeat)
    const candReview = reviewCounts(cand.repeat)
    const semanticComparable = baseReview.reviewed && candReview.reviewed
    if (!semanticComparable) unresolved.push(`semantic review missing for ${base.caseItem.caseId}#${base.repeat.repeat}`)

    const baseDurations = durations(base.repeat)
    const candDurations = durations(cand.repeat)
    pairs.push({
      caseId: base.caseItem.caseId,
      caseHash: base.caseItem.caseHash,
      repeat: base.repeat.repeat,
      baseline: {
        status: base.repeat.status,
        stopReason: base.repeat.stopReason ?? null,
        rounds: (base.repeat.rounds ?? []).length,
        completedRounds: (base.repeat.rounds ?? []).filter(round => isPlainObject(round.reply)).length,
        rulePasses: [...baseRules.values()].filter(item => item.status === 'pass').length,
        ruleFailures: [...baseRules.values()].filter(item => item.status === 'fail').length,
        parseFailures: (base.repeat.rounds ?? []).filter(round => !isPlainObject(round.reply)).length,
        usage: usageTotals(base.repeat),
        reviews: baseReview,
      },
      candidate: {
        status: cand.repeat.status,
        stopReason: cand.repeat.stopReason ?? null,
        rounds: (cand.repeat.rounds ?? []).length,
        completedRounds: (cand.repeat.rounds ?? []).filter(round => isPlainObject(round.reply)).length,
        rulePasses: [...candRules.values()].filter(item => item.status === 'pass').length,
        ruleFailures: [...candRules.values()].filter(item => item.status === 'fail').length,
        parseFailures: (cand.repeat.rounds ?? []).filter(round => !isPlainObject(round.reply)).length,
        usage: usageTotals(cand.repeat),
        reviews: candReview,
      },
      improvements,
      regressions,
      newlyJudged,
      semantic: {
        comparable: semanticComparable,
        baselineOmissions: baseReview.omissions,
        candidateOmissions: candReview.omissions,
        baselineAdditions: baseReview.additions,
        candidateAdditions: candReview.additions,
      },
      latency: {
        baselineMedianMs: median(baseDurations),
        candidateMedianMs: median(candDurations),
        baselineP90Ms: p90(baseDurations),
        candidateP90Ms: p90(candDurations),
      },
    })
  }

  const improvedPairs = pairs.filter(pair => pair.improvements.length > 0 && pair.regressions.length === 0).length
  const regressedPairs = pairs.filter(pair => pair.regressions.length > 0).length
  const semanticReviewedPairs = pairs.filter(pair => pair.semantic.comparable).length
  const baseSide = sideSummary(baseline)
  const candSide = sideSummary(candidate)
  const comparison = {
    comparisonVersion: COMPARISON_VERSION,
    label:
      baseline.metadata.mode === 'mock'
        ? 'pipeline/rule rehearsal only — no semantic-quality conclusion'
        : 'lexical/structural comparison only; human semantic review is required',
    compatibility: {
      comparable: true,
      confounded: changedDimensions.length > 0,
      changedDimensions,
      changedSettings: settingsChanges,
      adapterKind: adapterKind(baseline),
      corpusHash: corpusHash(baseline),
      unresolved: [...new Set(unresolved)],
    },
    baseline: baseSide,
    candidate: candSide,
    summary: {
      pairs: pairs.length,
      improvedPairs,
      regressedPairs,
      unchangedPairs: pairs.length - improvedPairs - regressedPairs,
      ruleImprovements: pairs.reduce((total, pair) => total + pair.improvements.length, 0),
      ruleRegressions: pairs.reduce((total, pair) => total + pair.regressions.length, 0),
      semanticReviewedPairs,
      semanticUnreviewedPairs: pairs.length - semanticReviewedPairs,
      baselineRuleFailures: baseSide.ruleFailures,
      candidateRuleFailures: candSide.ruleFailures,
      baselineParseFailures: baseSide.parseFailures,
      candidateParseFailures: candSide.parseFailures,
      questionCounts: {
        baseline: baseSide.questions,
        candidate: candSide.questions,
      },
      latency: {
        method: 'median (average of two middle values for even n); p90 (nearest-rank)',
        baseline: baseSide.latency,
        candidate: candSide.latency,
      },
      usage: {
        baseline: baseSide.usage,
        candidate: candSide.usage,
      },
      failures: {
        baseline: baseSide.statusCounts,
        candidate: candSide.statusCounts,
      },
      semanticRates: {
        baselineConstraintOmissionRate: baseSide.semantic.constraintOmissionRate,
        candidateConstraintOmissionRate: candSide.semantic.constraintOmissionRate,
        baselineScopeAdditionRate: baseSide.semantic.scopeAdditionRate,
        candidateScopeAdditionRate: candSide.semantic.scopeAdditionRate,
        reviewed: semanticReviewedPairs > 0,
      },
    },
    pairs,
  }
  return comparison
}

/** Renders a comparison for humans, escaping all model-derived cells. */
export function renderComparisonMarkdown(comparison) {
  const lines = []
  lines.push('# 평가 비교 보고서')
  lines.push('')
  if (comparison.baseline.mode === 'mock') {
    lines.push('> **pipeline/rule rehearsal only — no semantic-quality conclusion**')
    lines.push('>')
    lines.push('> mock 비교는 규칙·파이프라인 리허설이며 의미 품질 개선의 증거가 아닙니다.')
  } else {
    lines.push('> 실제 모델 비교입니다. 규칙 변화는 어휘 신호이며, 의미 품질은 사람 심사가 필요합니다.')
  }
  lines.push('')
  lines.push('## 비교 가능성')
  lines.push('')
  lines.push('| 항목 | 값 |')
  lines.push('|---|---|')
  const compatibility = comparison.compatibility
  lines.push(`| 비교 가능 | ${compatibility.comparable ? '예' : '아니오'} |`)
  lines.push(`| 교란됨 | ${compatibility.confounded ? '예' : '아니오'} |`)
  lines.push(`| 변경 허용 차원 | ${escapeMarkdownCell(compatibility.changedDimensions.join(', ') || '없음')} |`)
  lines.push(`| 변경된 설정 | ${escapeMarkdownCell(compatibility.changedSettings.join(', ') || '없음')} |`)
  lines.push(`| 코퍼스 해시 | ${escapeMarkdownCell(compatibility.corpusHash)} |`)
  lines.push(`| 어댑터 종류 | ${escapeMarkdownCell(compatibility.adapterKind ?? 'unknown')} |`)
  lines.push('')
  if (compatibility.unresolved.length > 0) {
    lines.push('### 미해결 조건')
    lines.push('')
    for (const item of compatibility.unresolved) lines.push(`- ${escapeMarkdownCell(item, 300)}`)
    lines.push('')
  }

  const summary = comparison.summary
  lines.push('## 집계')
  lines.push('')
  lines.push('| 지표 | 기준 | 변경 |')
  lines.push('|---|---|---|')
  lines.push(`| 규칙 실패 | ${summary.baselineRuleFailures} | ${summary.candidateRuleFailures} |`)
  lines.push(`| 파싱 실패 | ${summary.baselineParseFailures} | ${summary.candidateParseFailures} |`)
  lines.push(`| 질문 수 | ${summary.questionCounts.baseline} | ${summary.questionCounts.candidate} |`)
  lines.push(`| 지연 중앙값 | ${formatMs(summary.latency.baseline.medianMs)} | ${formatMs(summary.latency.candidate.medianMs)} |`)
  lines.push(`| 지연 p90 | ${formatMs(summary.latency.baseline.p90Ms)} | ${formatMs(summary.latency.candidate.p90Ms)} |`)
  lines.push(`| 규칙 개선 / 회귀 | ${summary.ruleImprovements} | ${summary.ruleRegressions} |`)
  lines.push(`| 개선된 쌍 / 회귀 쌍 | ${summary.improvedPairs} | ${summary.regressedPairs} |`)
  lines.push(`| 심사된 쌍 / 미심사 쌍 | ${summary.semanticReviewedPairs} | ${summary.semanticUnreviewedPairs} |`)
  lines.push(
    `| 제약 누락률 | ${formatRate(summary.semanticRates.baselineConstraintOmissionRate)} | ${formatRate(summary.semanticRates.candidateConstraintOmissionRate)} |`,
  )
  lines.push(
    `| 범위 추가율 | ${formatRate(summary.semanticRates.baselineScopeAdditionRate)} | ${formatRate(summary.semanticRates.candidateScopeAdditionRate)} |`,
  )
  lines.push('')
  lines.push('의미 비율이 N/A이면 심사되지 않은 것이며 0이 아닙니다.')
  lines.push('')

  lines.push('## 사례별 쌍')
  lines.push('')
  lines.push('| 사례 | 반복 | 기준 상태 | 변경 상태 | 규칙 실패(기준→변경) | 개선 | 회귀 | 라운드(기준→변경) | 의미 비교 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const pair of comparison.pairs) {
    lines.push(
      `| ${escapeMarkdownCell(pair.caseId)} | ${pair.repeat} | ${escapeMarkdownCell(pair.baseline.status)} | ${escapeMarkdownCell(pair.candidate.status)} | ${pair.baseline.ruleFailures}→${pair.candidate.ruleFailures} | ${pair.improvements.length} | ${pair.regressions.length} | ${pair.baseline.completedRounds}→${pair.candidate.completedRounds} | ${pair.semantic.comparable ? '심사됨' : '미심사'} |`,
    )
  }
  lines.push('')

  const regressions = comparison.pairs.flatMap(pair =>
    pair.regressions.map(item => ({ pair, item })),
  )
  lines.push('## 회귀 상세')
  lines.push('')
  if (regressions.length === 0) {
    lines.push('규칙 회귀가 없습니다. 이는 의미 품질 유지의 증거가 아닙니다.')
  } else {
    lines.push('| 사례 | 반복 | 라운드 | 규칙 | 근거 |')
    lines.push('|---|---|---|---|---|')
    for (const { pair, item } of regressions) {
      lines.push(
        `| ${escapeMarkdownCell(pair.caseId)} | ${pair.repeat} | ${item.round} | ${escapeMarkdownCell(item.ruleId)} | ${escapeMarkdownCell(item.evidence ?? '')} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 한계')
  lines.push('')
  lines.push(
    '- 사례 수와 반복 수가 작으므로 통계적 유의성을 주장하지 않습니다. 규칙 개선/회귀는 어휘·구조 신호입니다.',
  )
  lines.push(
    '- `--allow-change settings`를 사용하면 어떤 설정이 바뀌었는지 위에 나열하며, 인과적 프롬프트 개선으로 주장하지 않습니다.',
  )
  lines.push('- 실제 모델 ID가 unknown이면 비교 조건으로 남기며, 같은 별칭이라도 동일 모델을 보장하지 않습니다.')
  lines.push('- mock과 live 결과, 코퍼스 해시가 다른 결과, 누락된 사례는 비교하지 않고 거부합니다.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function formatMs(value) {
  return value === null ? 'N/A' : `${Number.isInteger(value) ? value : value.toFixed(2)}ms`
}

function formatRate(value) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

/** Chooses JSON or Markdown from the output extension. */
export function formatComparison(comparison, outPath) {
  return path.extname(outPath).toLowerCase() === '.json'
    ? `${JSON.stringify(comparison, null, 2)}\n`
    : renderComparisonMarkdown(comparison)
}

/** Writes a comparison with exclusive creation (never overwrites). */
export async function writeComparison(outPath, comparison) {
  const body = formatComparison(comparison, outPath)
  try {
    await writeFile(outPath, body, { flag: 'wx', mode: 0o600 })
  } catch (cause) {
    if (cause?.code === 'EEXIST') {
      fail(`refusing to overwrite existing comparison output: ${outPath}`)
    }
    throw cause
  }
  return body
}

function parseCompareArgs(argv) {
  const args = { baseline: null, candidate: null, out: null, allowChange: [], help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const [flag, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, null]
    const take = () => {
      if (inline !== null) return inline
      const next = argv[index + 1]
      if (next === undefined) fail(`${flag} expects a value`)
      index += 1
      return next
    }
    if (flag === '--baseline') args.baseline = take()
    else if (flag === '--candidate') args.candidate = take()
    else if (flag === '--out') args.out = take()
    else if (flag === '--allow-change') args.allowChange.push(take())
    else if (flag === '--help' || flag === '-h') args.help = true
    else fail(`unknown compare flag: ${flag}`)
  }
  if (args.help) return args
  if (args.baseline === null) fail('compare requires --baseline')
  if (args.candidate === null) fail('compare requires --candidate')
  if (args.out === null) fail('compare requires --out')
  return args
}

async function readResult(file) {
  let info
  try {
    info = await readFile(file)
  } catch (cause) {
    fail(`could not read ${file}: ${cause.message}`)
  }
  if (info.byteLength > MAX_RESULT_BYTES) fail(`result file is larger than ${MAX_RESULT_BYTES} bytes`)
  try {
    return JSON.parse(info.toString('utf8'))
  } catch (cause) {
    fail(`invalid JSON in ${file}: ${cause.message}`)
  }
}

async function main() {
  const args = parseCompareArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node evals/runner/compare.mjs --baseline <json> --candidate <json> --out <md|json> [--allow-change guidance|model|settings]')
    return
  }
  const baseline = await readResult(args.baseline)
  const candidate = await readResult(args.candidate)
  const comparison = compareRuns(baseline, candidate, { allowChange: args.allowChange })
  await writeComparison(args.out, comparison)
  console.log(
    `comparison written to ${args.out}: ${comparison.summary.improvedPairs} improved pair(s), ` +
      `${comparison.summary.regressedPairs} regressed pair(s), confounded=${comparison.compatibility.confounded}`,
  )
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
