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
      if (isParseFailureRound(round)) totals.parseFailures += 1
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
      // Denominators count distinct constraints and episodes, never review
      // items, so duplicated entries cannot push a rate past 1.
      const constraintKeys = new Set()
      const failedConstraintKeys = new Set()
      let scopeReviewed = false
      let scopeFailed = false
      for (const item of review.reviews) {
        if (item?.criterionId === 'constraint-omission' && (item.verdict === 'pass' || item.verdict === 'fail')) {
          const key =
            typeof item.constraintId === 'string' && item.constraintId !== '' ? item.constraintId : '(unkeyed)'
          constraintKeys.add(key)
          if (item.verdict === 'fail') failedConstraintKeys.add(key)
        }
        if (item?.criterionId === 'scope-addition' && (item.verdict === 'pass' || item.verdict === 'fail')) {
          scopeReviewed = true
          if (item.verdict === 'fail') scopeFailed = true
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
      semantic.reviewedConstraints += constraintKeys.size
      semantic.constraintOmissions += failedConstraintKeys.size
      if (scopeReviewed) semantic.reviewedScopeEpisodes += 1
      if (scopeFailed) semantic.scopeAdditions += 1
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

/**
 * A round with raw model text that did not parse. Rounds that never produced
 * text (timeout, adapter error, missing mock response) are transport failures,
 * not parse failures, and are counted through episode status instead.
 */
export function isParseFailureRound(round) {
  if (isPlainObject(round?.reply)) return false
  return typeof round?.rawText === 'string' && round.rawText !== ''
}

/** Escapes model text so it cannot corrupt a Markdown table or emit HTML. */
export function escapeMarkdownCell(value, maxChars = 160) {
  const raw = value === null || value === undefined ? '' : String(value)
  const points = [...raw]
  const truncated = points.length > maxChars ? `${points.slice(0, Math.max(0, maxChars - 1)).join('')}…` : raw
  return truncated
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r\n?|\n/g, ' ')
}
