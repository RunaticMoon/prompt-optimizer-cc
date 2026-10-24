/**
 * Pure aggregation and Markdown rendering for evaluation results.
 *
 * The aggregate keeps raw numerators and denominators, and it never turns
 * unreviewed semantic data into 0% (or 100%). Mock runs are labelled as
 * pipeline/rule rehearsal only, even when every literal rule passes.
 */

export const REPORT_VERSION = '1'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sumCounts(target, counts) {
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = counts?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) target[key] += value
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  return sorted[rank]
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

/** Yields `{caseItem, repeat}` for every episode in a result. */
export function* episodes(run) {
  for (const caseItem of run?.cases ?? []) {
    for (const repeat of caseItem?.repeats ?? []) yield { caseItem, repeat }
  }
}

/** Aggregates one result object (`{metadata, cases}`); pure and deterministic. */
export function summarizeRun(run) {
  const metadata = isPlainObject(run?.metadata) ? run.metadata : {}
  const totals = {
    cases: Array.isArray(run?.cases) ? run.cases.length : 0,
    episodes: 0,
    rounds: 0,
    completedRounds: 0,
    completedEpisodes: 0,
    failedEpisodes: 0,
    cappedEpisodes: 0,
    divergedEpisodes: 0,
    timedOutEpisodes: 0,
    unsupportedEpisodes: 0,
    capSkippedEpisodes: 0,
    parseFailures: 0,
    rulePasses: 0,
    ruleFailures: 0,
    ruleNotApplicable: 0,
    questions: 0,
    episodesEndingWithQuestion: 0,
    attemptedCalls: finiteOrNull(metadata.attemptedCalls) ?? 0,
    completedCalls: finiteOrNull(metadata.completedCalls) ?? 0,
  }
  const durations = []
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  let usageKnownEpisodes = 0
  const semantic = {
    reviewedEpisodes: 0,
    reviewedConstraints: 0,
    constraintOmissions: 0,
    reviewedScopeEpisodes: 0,
    scopeAdditions: 0,
    unnecessaryQuestions: 0,
    criticalIntentFailures: 0,
    languageFailures: 0,
  }
  const failureBuckets = {
    failed: [],
    capped: [],
    'scenario-diverged': [],
    timeout: [],
    unsupported: [],
    cap: [],
  }

  for (const { caseItem, repeat } of episodes(run)) {
    totals.episodes += 1
    const status = repeat?.status ?? 'failed'
    if (status === 'completed') totals.completedEpisodes += 1
    else if (status === 'capped') totals.cappedEpisodes += 1
    else if (status === 'scenario-diverged') totals.divergedEpisodes += 1
    else if (status === 'timeout') totals.timedOutEpisodes += 1
    else if (status === 'unsupported') totals.unsupportedEpisodes += 1
    else if (status === 'cap') totals.capSkippedEpisodes += 1
    else totals.failedEpisodes += 1
    if (Object.prototype.hasOwnProperty.call(failureBuckets, status) && status !== 'completed') {
      failureBuckets[status].push({
        caseId: caseItem.caseId,
        repeat: repeat.repeat,
        status,
        stopReason: repeat.stopReason ?? null,
        error: repeat.error ?? null,
      })
    }

    const rounds = Array.isArray(repeat?.rounds) ? repeat.rounds : []
    let episodeEndsWithQuestion = false
    let episodeHasKnownUsage = false
    for (const round of rounds) {
      totals.rounds += 1
      const parsed = isPlainObject(round.reply)
      if (parsed) totals.completedRounds += 1
      else totals.parseFailures += 1
      if (!parsed) {
        // A failed call still has an input, but no rule judgment of its own.
        if (isPlainObject(round.usage) && round.usage.known === true) {
          episodeHasKnownUsage = true
          sumCounts(usageTotals, round.usage.counts)
        }
        continue
      }
      if (typeof round.reply.question === 'string' && round.reply.question.trim() !== '') {
        totals.questions += 1
        episodeEndsWithQuestion = true
      } else {
        episodeEndsWithQuestion = false
      }
      for (const judgment of round.judgments ?? []) {
        if (judgment.status === 'pass') totals.rulePasses += 1
        else if (judgment.status === 'fail') totals.ruleFailures += 1
        else if (judgment.status === 'not-applicable') totals.ruleNotApplicable += 1
      }
      if (isPlainObject(round.usage) && round.usage.known === true) {
        episodeHasKnownUsage = true
        sumCounts(usageTotals, round.usage.counts)
      }
      const duration = finiteOrNull(round.durationMs)
      if (duration !== null && duration >= 0) durations.push(duration)
    }
    if (episodeEndsWithQuestion) totals.episodesEndingWithQuestion += 1
    if (episodeHasKnownUsage) usageKnownEpisodes += 1

    const review = repeat?.humanReview
    if (isPlainObject(review) && Array.isArray(review.reviews)) {
      semantic.reviewedEpisodes += 1
      for (const item of review.reviews) {
        if (item?.criterionId === 'constraint-omission' && (item.verdict === 'pass' || item.verdict === 'fail')) {
          semantic.reviewedConstraints += 1
          if (item.verdict === 'fail') semantic.constraintOmissions += 1
        }
        if (item?.criterionId === 'scope-addition' && (item.verdict === 'pass' || item.verdict === 'fail')) {
          semantic.reviewedScopeEpisodes += 1
          if (item.verdict === 'fail') semantic.scopeAdditions += 1
        }
        if (item?.criterionId === 'unnecessary-question' && item.verdict === 'fail') {
          semantic.unnecessaryQuestions += 1
        }
        if (item?.criterionId === 'intent-preservation' && item.verdict === 'fail') {
          semantic.criticalIntentFailures += 1
        }
        if (item?.criterionId === 'language-literal-fidelity' && item.verdict === 'fail') {
          semantic.languageFailures += 1
        }
      }
    }
  }

  const judged = totals.rulePasses + totals.ruleFailures
  const semanticStatus =
    semantic.reviewedEpisodes === 0
      ? 'unreviewed'
      : semantic.reviewedEpisodes === totals.episodes
        ? 'reviewed'
        : 'partially-reviewed'
  const mode = metadata.mode === 'live' ? 'live' : 'mock'
  const usagePerTask =
    usageKnownEpisodes === 0
      ? null
      : Object.fromEntries(
          Object.entries(usageTotals).map(([key, value]) => [key, value / usageKnownEpisodes]),
        )

  return {
    reportVersion: REPORT_VERSION,
    mode,
    suite: metadata.suite ?? null,
    label:
      mode === 'mock'
        ? 'pipeline/rule rehearsal only — no semantic-quality conclusion'
        : 'rule results are lexical signals; human semantic review is required',
    totals,
    rates: {
      rulePassRate: judged === 0 ? null : totals.rulePasses / judged,
      ruleFailureRate: judged === 0 ? null : totals.ruleFailures / judged,
      parseFailureRate: totals.rounds === 0 ? null : totals.parseFailures / totals.rounds,
      roundsPerTask: totals.episodes === 0 ? null : totals.rounds / totals.episodes,
      completedRoundsPerTask: totals.episodes === 0 ? null : totals.completedRounds / totals.episodes,
    },
    latency: {
      method: 'median (average of two middle values for even n); p90 (nearest-rank)',
      samples: durations.length,
      medianMs: median(durations),
      p90Ms: percentile(durations, 0.9),
    },
    usage: {
      knownEpisodes: usageKnownEpisodes,
      episodes: totals.episodes,
      totals: usageTotals,
      perTask: usagePerTask,
      synthetic: mode === 'mock',
    },
    semantic: {
      ...semantic,
      unreviewedEpisodes: totals.episodes - semantic.reviewedEpisodes,
      status: semanticStatus,
      constraintOmissionRate:
        semantic.reviewedConstraints === 0
          ? null
          : semantic.constraintOmissions / semantic.reviewedConstraints,
      scopeAdditionRate:
        semantic.reviewedScopeEpisodes === 0
          ? null
          : semantic.scopeAdditions / semantic.reviewedScopeEpisodes,
      unnecessaryQuestionRate:
        semantic.reviewedEpisodes === 0
          ? null
          : semantic.unnecessaryQuestions / semantic.reviewedEpisodes,
    },
    questionCounts: {
      questions: totals.questions,
      episodesEndingWithQuestion: totals.episodesEndingWithQuestion,
    },
    failures: failureBuckets,
  }
}

/** Escapes model text so it cannot corrupt a Markdown table or emit HTML. */
export function escapeMarkdownCell(value, maxChars = 160) {
  const raw = value === null || value === undefined ? '' : String(value)
  const points = [...raw]
  const truncated = points.length > maxChars ? `${points.slice(0, Math.max(0, maxChars - 1)).join('')}…` : raw
  return truncated
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ')
}

function formatNumber(value) {
  if (value === null || value === undefined) return 'N/A'
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  return String(value)
}

function formatRate(value) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

function metadataTable(metadata) {
  return [
    '| 항목 | 값 |',
    '|---|---|',
    `| 모드 | ${escapeMarkdownCell(metadata.mode ?? 'unknown')} |`,
    `| 평가군 | ${escapeMarkdownCell(metadata.suite ?? 'unknown')} |`,
    `| 저장소 SHA | ${escapeMarkdownCell(metadata.repoSha ?? 'unknown')} |`,
    `| 패키지 버전 | ${escapeMarkdownCell(metadata.packageVersion ?? 'unknown')} |`,
    `| Node | ${escapeMarkdownCell(metadata.nodeVersion ?? 'unknown')} |`,
    `| 요청 모델 | ${escapeMarkdownCell(metadata.model?.requested ?? 'none')} |`,
    `| 실제 모델 | ${escapeMarkdownCell(metadata.model?.actual ?? 'unknown')} |`,
    `| 반복 | ${formatNumber(metadata.settings?.repeats ?? null)} |`,
    `| 예상/시도/완료 호출 | ${formatNumber(metadata.plannedCalls ?? null)} / ${formatNumber(metadata.attemptedCalls ?? null)} / ${formatNumber(metadata.completedCalls ?? null)} |`,
    `| 시작/종료 | ${escapeMarkdownCell(metadata.startedAt ?? 'unknown')} / ${escapeMarkdownCell(metadata.endedAt ?? 'unknown')} |`,
  ].join('\n')
}

/** Renders a human-readable Markdown report from a result object. */
export function renderMarkdown(run) {
  const metadata = isPlainObject(run?.metadata) ? run.metadata : {}
  const summary = isPlainObject(run?.aggregate) ? run.aggregate : summarizeRun(run)
  const lines = []
  lines.push('# 프롬프트 의미 평가 결과')
  lines.push('')
  if (summary.mode === 'mock') {
    lines.push('> **pipeline/rule rehearsal only — no semantic-quality conclusion**')
    lines.push('>')
    lines.push(
      '> 이 보고서의 규칙 검사는 어휘·구조 신호입니다. 의미 품질 판정은 `evals/rubric/README.md`의 사람 심사 기록으로만 이루어지며, 심사되지 않은 의미 지표는 N/A입니다.',
    )
  } else {
    lines.push('> 실제 모델 실행입니다. 규칙 통과는 의미 품질의 증거가 아닙니다. 사람 심사가 필요합니다.')
  }
  lines.push('')
  lines.push(metadataTable(metadata))
  lines.push('')
  lines.push('## 집계')
  lines.push('')
  lines.push('| 지표 | 값 |')
  lines.push('|---|---|')
  const rows = [
    ['사례 / 에피소드', `${summary.totals.cases} / ${summary.totals.episodes}`],
    ['완료 / 실패 / 상한 도달', `${summary.totals.completedEpisodes} / ${summary.totals.failedEpisodes} / ${summary.totals.cappedEpisodes}`],
    ['규칙 통과 / 실패 / N/A', `${summary.totals.rulePasses} / ${summary.totals.ruleFailures} / ${summary.totals.ruleNotApplicable}`],
    ['규칙 통과율', formatRate(summary.rates.rulePassRate)],
    ['파싱 실패', `${summary.totals.parseFailures} (${formatRate(summary.rates.parseFailureRate)})`],
    ['라운드 / 작업', formatNumber(summary.rates.roundsPerTask)],
    ['질문 수 / 질문으로 끝난 에피소드', `${summary.questionCounts.questions} / ${summary.questionCounts.episodesEndingWithQuestion}`],
    ['지연 중앙값 / p90', `${formatNumber(summary.latency.medianMs)}ms / ${formatNumber(summary.latency.p90Ms)}ms (${summary.latency.method})`],
    ['사용량 알려진 에피소드', `${summary.usage.knownEpisodes} / ${summary.usage.episodes}${summary.usage.synthetic ? ' (synthetic 0)' : ''}`],
    ['토큰 합계(입력/출력/캐시 읽기/캐시 생성)', `${summary.usage.totals.input_tokens} / ${summary.usage.totals.output_tokens} / ${summary.usage.totals.cache_read_input_tokens} / ${summary.usage.totals.cache_creation_input_tokens}`],
    ['심사된 에피소드', `${summary.semantic.reviewedEpisodes} / ${summary.totals.episodes} (${summary.semantic.status})`],
    ['제약 누락률', `${formatRate(summary.semantic.constraintOmissionRate)} (${summary.semantic.constraintOmissions}/${summary.semantic.reviewedConstraints})`],
    ['범위 추가율', `${formatRate(summary.semantic.scopeAdditionRate)} (${summary.semantic.scopeAdditions}/${summary.semantic.reviewedScopeEpisodes})`],
    ['불필요 질문', `${summary.semantic.unnecessaryQuestions} (심사 기반)`],
  ]
  lines.push(...rows.map(([label, value]) => `| ${label} | ${value} |`))
  lines.push('')

  lines.push('## 사례별 결과')
  lines.push('')
  lines.push('| 사례 | 반복 | 상태 | 라운드 | 규칙 통과/실패 | 파싱 실패 | 지연 | 종료 이유 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const { caseItem, repeat } of episodes(run)) {
    const rounds = Array.isArray(repeat.rounds) ? repeat.rounds : []
    const pass = rounds.reduce(
      (total, round) => total + (round.judgments ?? []).filter(item => item.status === 'pass').length,
      0,
    )
    const fail = rounds.reduce(
      (total, round) => total + (round.judgments ?? []).filter(item => item.status === 'fail').length,
      0,
    )
    const parseFailures = rounds.reduce(
      (total, round) => total + (isPlainObject(round.reply) ? 0 : 1),
      0,
    )
    const duration = rounds.reduce(
      (total, round) => total + (finiteOrNull(round.durationMs) ?? 0),
      0,
    )
    lines.push(
      `| ${escapeMarkdownCell(caseItem.caseId)} | ${formatNumber(repeat.repeat)} | ${escapeMarkdownCell(repeat.status)} | ${rounds.length} | ${pass}/${fail} | ${parseFailures} | ${formatNumber(duration)}ms | ${escapeMarkdownCell(repeat.stopReason ?? '')} |`,
    )
  }
  lines.push('')

  const failures = []
  for (const { caseItem, repeat } of episodes(run)) {
    for (const round of repeat.rounds ?? []) {
      for (const judgment of round.judgments ?? []) {
        if (judgment.status === 'fail') {
          failures.push({ caseItem, repeat, round, judgment })
        }
      }
    }
  }
  lines.push('## 규칙 실패 상세')
  lines.push('')
  if (failures.length === 0) {
    lines.push('규칙 실패가 없습니다. 이는 의미 품질 통과가 아닙니다.')
  } else {
    lines.push('| 사례 | 반복 | 라운드 | 규칙 | 근거 |')
    lines.push('|---|---|---|---|---|')
    for (const { caseItem, repeat, round, judgment } of failures) {
      lines.push(
        `| ${escapeMarkdownCell(caseItem.caseId)} | ${repeat.repeat} | ${round.round} | ${escapeMarkdownCell(judgment.ruleId)} | ${escapeMarkdownCell(judgment.evidence)} |`,
      )
    }
  }
  lines.push('')

  lines.push('## 실패·분기·시간 초과')
  lines.push('')
  const buckets = [
    ['실패', summary.failures.failed],
    ['상한 도달', summary.failures.capped],
    ['시나리오 분기', summary.failures['scenario-diverged']],
    ['시간 초과', summary.failures.timeout],
    ['어댑터 미지원', summary.failures.unsupported],
    ['호출 상한으로 건너뜀', summary.failures.cap],
  ]
  let anyBucket = false
  for (const [label, items] of buckets) {
    if (items.length === 0) continue
    anyBucket = true
    lines.push(`- ${label}: ${items.length}`)
    for (const item of items) {
      lines.push(
        `  - ${escapeMarkdownCell(item.caseId)} 반복 ${item.repeat}: ${escapeMarkdownCell(item.error?.kind ?? item.stopReason ?? item.status)}`,
      )
    }
  }
  if (!anyBucket) lines.push('없음.')
  lines.push('')

  lines.push('## 사람 심사')
  lines.push('')
  if (summary.semantic.reviewedEpisodes === 0) {
    lines.push('심사 기록이 없습니다. 의미 지표는 모두 N/A이며 0이 아닙니다.')
  } else {
    lines.push(
      `심사된 에피소드 ${summary.semantic.reviewedEpisodes}/${summary.totals.episodes}. 미심사 ${summary.semantic.unreviewedEpisodes}건은 통과로 계산하지 않습니다.`,
    )
    lines.push('')
    lines.push('| 사례 | 반복 | 기준 | 판정 | 인용 |')
    lines.push('|---|---|---|---|---|')
    for (const { caseItem, repeat } of episodes(run)) {
      for (const item of repeat.humanReview?.reviews ?? []) {
        lines.push(
          `| ${escapeMarkdownCell(caseItem.caseId)} | ${repeat.repeat} | ${escapeMarkdownCell(item.criterionId)} | ${escapeMarkdownCell(item.verdict)} | ${escapeMarkdownCell(item.quote)} |`,
        )
      }
    }
  }
  lines.push('')
  lines.push('## 한계')
  lines.push('')
  lines.push(
    '- mock 실행은 파이프라인·규칙 리허설이며 의미 품질 결론이 아닙니다. 실제 모델 품질과 provider 동작은 이 보고서로 검증되지 않습니다.',
  )
  lines.push('- 실패 사례의 원문·근거·답변·모델 응답은 결과 JSON에 보존됩니다. 이 Markdown은 요약입니다.')
  lines.push('- 규칙 실패는 어휘 신호이며 동의어 누락을 자동으로 의미 누락으로 판정하지 않습니다.')
  lines.push('- 보류 평가군은 별도 동결 코퍼스이며, 코퍼스 해시가 다른 실행을 개선으로 비교하지 않습니다.')
  lines.push('')
  return `${lines.join('\n')}\n`
}
