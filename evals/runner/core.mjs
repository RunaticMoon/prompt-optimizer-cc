/**
 * Capped, sequential evaluation executor.
 *
 * Mock mode uses exactly the case's synthetic responses and never imports or
 * touches an adapter. Live mode requires an already-validated explicit adapter
 * and model; the adapter is imported only here, after the mode, CI, budget and
 * input-hygiene checks. Every attempted call increments the global counter
 * before it starts; there is no retry and no fallback.
 */

import { createHash } from 'node:crypto'

import { AdapterError, UnsupportedSettingsError, callAdapter, loadAdapter, normalizeAppliedSettings, normalizeUsage } from './adapters.mjs'
import { ArgsError, RUNNER_VERSION, detectCi, validateBudget } from './args.mjs'
import { gradeEpisode, redactSensitive, scanSensitive } from './judge.mjs'
import { summarizeRun } from './report.mjs'
import { stableStringify } from './schema.mjs'

const ZERO_COUNTS = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

/** Supplied synthetic data contained credential-shaped text; no value is echoed. */
export class SensitiveDataError extends Error {
  constructor(findings) {
    const locations = findings.map(item => `${item.caseId}:${item.location} (${item.kinds.join(', ')})`)
    super(`refusing to run: credential-shaped data in supplied case data at ${locations.join('; ')}`)
    this.name = 'SensitiveDataError'
    this.findings = findings
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

function mockUsage() {
  return { known: true, synthetic: true, counts: { ...ZERO_COUNTS } }
}

function copyDialogue(dialogue) {
  return (dialogue ?? []).map(message => ({ role: message.role, text: message.text }))
}

/** Collects every supplied string with a stable location label. */
function caseStrings(caseItem) {
  const strings = []
  const add = (location, value) => {
    if (typeof value === 'string' && value !== '') strings.push({ location, value })
  }
  add('original', caseItem.original)
  add('context.text', caseItem.context?.text)
  add('initialDraft', caseItem.initialDraft)
  for (const [index, message] of (caseItem.initialDialogue ?? []).entries()) {
    add(`initialDialogue[${index}].text`, message.text)
  }
  for (const [index, answer] of (caseItem.answers ?? []).entries()) {
    add(`answers[${index}].text`, answer.text)
    add(`answers[${index}].when.questionIncludes`, answer.when?.questionIncludes)
    add(`answers[${index}].when.option1Includes`, answer.when?.option1Includes)
  }
  for (const [index, constraint] of (caseItem.constraints ?? []).entries()) {
    add(`constraints[${index}].description`, constraint.description)
    for (const [literalIndex, literal] of (constraint.literals ?? []).entries()) {
      add(`constraints[${index}].literals[${literalIndex}]`, literal)
    }
  }
  for (const [index, rule] of (caseItem.rules ?? []).entries()) {
    add(`rules[${index}].value`, rule.value)
    add(`rules[${index}].field`, rule.field)
  }
  for (const [index, response] of (caseItem.mockResponses ?? []).entries()) {
    add(`mockResponses[${index}].draft`, response.draft)
    add(`mockResponses[${index}].message`, response.message)
    add(`mockResponses[${index}].question`, response.question)
    for (const [optionIndex, option] of (response.options ?? []).entries()) {
      add(`mockResponses[${index}].options[${optionIndex}]`, option)
    }
  }
  add('provenance.source', caseItem.provenance?.source)
  return strings
}

/** Scans supplied case data; returns locations/kinds only, never the values. */
export function collectSensitiveCases(cases) {
  const findings = []
  for (const caseItem of cases) {
    for (const { location, value } of caseStrings(caseItem)) {
      const { findings: kinds } = scanSensitive(value)
      if (kinds.length > 0) findings.push({ caseId: caseItem.id, location, kinds })
    }
  }
  return findings
}

function normalizeMode(args) {
  if (!isPlainObject(args)) throw new ArgsError('runEvaluation requires parsed args')
  if (args.mode !== 'mock' && args.mode !== 'live') {
    throw new ArgsError('runEvaluation requires mock or live mode')
  }
  return args.mode
}

/**
 * Runs every selected case/repeat/round sequentially and returns
 * `{metadata, cases, aggregate}`. The caller decides where to write it.
 */
export async function runEvaluation({
  cases,
  args,
  requests,
  adapter = null,
  env = process.env,
  now = () => new Date(),
  monotonic = () => performance.now(),
  timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
  externalSignal = null,
  repo = {},
  packageVersion = null,
} = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new ArgsError('no cases selected')
  if (!isPlainObject(requests) || typeof requests.buildRound !== 'function') {
    throw new ArgsError('runEvaluation requires a request builder')
  }
  const mode = normalizeMode(args)
  if (mode === 'mock' && (adapter !== null || args.adapter !== null && args.adapter !== undefined)) {
    throw new ArgsError('mock runs must not receive an adapter')
  }
  if (mode === 'live') {
    const ci = detectCi(env)
    if (ci !== null) throw new ArgsError(`refusing --live while the CI environment variable ${ci} is set`)
    if (args.model === null || args.model === undefined || args.model === '') {
      throw new ArgsError('live run requires an explicit model')
    }
  }
  const plan = validateBudget(cases, args)

  const sensitive = collectSensitiveCases(cases)
  if (sensitive.length > 0) throw new SensitiveDataError(sensitive)

  let liveAdapter = adapter
  if (mode === 'live' && liveAdapter === null) {
    if (typeof args.adapter !== 'string' || args.adapter === '') {
      throw new ArgsError('live run requires --adapter <absolute-path>')
    }
    liveAdapter = await loadAdapter(args.adapter)
  }
  if (mode === 'live' && (liveAdapter === null || typeof liveAdapter.complete !== 'function')) {
    throw new ArgsError('live run requires a loaded adapter')
  }

  const startedAt = iso(now())
  const metadata = {
    schemaVersion: 1,
    runnerVersion: RUNNER_VERSION,
    rubricVersion: '1',
    mode,
    suite: args.suite,
    nodeVersion: requests.metadata?.nodeVersion ?? process.version,
    packageVersion,
    repoSha: repo.sha ?? null,
    dirty: repo.dirty ?? null,
    adapter:
      mode === 'live'
        ? {
            kind: liveAdapter.kind ?? 'trusted',
            path: liveAdapter.path ?? args.adapter ?? null,
            identity: liveAdapter.identity ?? null,
            hash: liveAdapter.hash ?? null,
            requestedModel: args.model,
          }
        : null,
    model: { requested: mode === 'live' ? args.model : null, actual: null, reported: [] },
    guidance: { profiles: {}, sourceHashes: {} },
    settings: {
      repeats: args.repeats,
      maxRounds: args.maxRounds,
      maxCalls: plan.maxCalls,
      maxCallMs: args.maxCallMs,
    },
    plannedCalls: plan.plannedCalls,
    attemptedCalls: 0,
    completedCalls: 0,
    startedAt,
    endedAt: null,
    comparable: true,
    sensitiveFindings: [],
  }

  try {
    metadata.guidance.sourceHashes = await requests.metadata.sourceHashes()
  } catch {
    metadata.guidance.sourceHashes = {}
  }

  const planByCase = new Map(plan.perCase.map(item => [item.caseId, item]))
  const orderedCases = [...cases].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  let attemptedCalls = 0
  let completedCalls = 0

  const caseRecords = []
  for (const caseItem of orderedCases) {
    const caseHash = sha256(stableStringify(caseItem))
    const planItem = planByCase.get(caseItem.id)
    if (planItem === undefined) throw new ArgsError(`budget plan is missing case ${caseItem.id}`)
    const repeatRecords = []

    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      if (attemptedCalls >= plan.maxCalls) {
        repeatRecords.push({
          repeat,
          status: 'cap',
          stopReason: 'global-call-cap',
          rounds: [],
          error: null,
          humanReview: null,
        })
        continue
      }

      let draft = caseItem.initialDraft
      const dialogue = copyDialogue(caseItem.initialDialogue)
      let completedRounds = caseItem.roundsCompleted
      let answerIndex = 0
      let status = 'completed'
      let stopReason = 'rounds-exhausted'
      let error = null
      const rounds = []
      const allowed = planItem.roundsThisRun

      if (allowed === 0) {
        stopReason = 'no-rounds'
      }

      for (let index = 0; index < allowed; index += 1) {
        if (externalSignal?.aborted) {
          status = 'failed'
          stopReason = 'aborted'
          error = { kind: 'aborted', status: null }
          break
        }
        if (attemptedCalls >= plan.maxCalls) {
          status = 'cap'
          stopReason = 'global-call-cap'
          break
        }

        const settings = {
          ...caseItem.settings,
          ...(mode === 'live' ? { model: args.model } : {}),
        }
        const built = requests.buildRound(
          { original: caseItem.original, contextText: caseItem.context.text, draft, dialogue, rounds: completedRounds },
          settings,
        )
        const roundNumber = completedRounds + 1
        const priorDialogue = copyDialogue(dialogue)
        const profile = caseItem.settings.guidanceProfile
        metadata.guidance.profiles[profile] = {
          version: sha256(built.system),
          chars: [...built.system].length,
        }

        const started = monotonic()
        attemptedCalls += 1
        let rawText = null
        let reply = null
        let parseError = null
        let usage = mode === 'mock' ? mockUsage() : { known: false, counts: null }
        let adapterRound = null
        let roundStop = 'answer-fed'

        if (mode === 'mock') {
          const response = caseItem.mockResponses[index]
          if (response === undefined) {
            status = 'failed'
            stopReason = 'mock-response-missing'
            error = { kind: 'mock-response-missing', status: null }
            roundStop = 'mock-response-missing'
          } else {
            rawText = JSON.stringify({
              draft: response.draft,
              message: response.message,
              question: response.question,
              options: response.options,
            })
            const parsed = requests.parseReply(rawText)
            if (parsed.ok) {
              reply = parsed.reply
              completedCalls += 1
            } else {
              parseError = parsed.reason
              status = 'failed'
              stopReason = parsed.reason
              error = { kind: parsed.reason, status: null }
              roundStop = parsed.reason
            }
          }
        } else {
          const timeout = timeoutSignal(Math.min(caseItem.settings.timeoutMs, args.maxCallMs))
          const signal = externalSignal === null ? timeout : AbortSignal.any([timeout, externalSignal])
          try {
            const response = await callAdapter(liveAdapter, built.request, { signal })
            const applied = normalizeAppliedSettings(built.request, response)
            const redacted = redactSensitive(response.text)
            if (redacted.findings.length > 0) {
              metadata.comparable = false
              metadata.sensitiveFindings.push({
                caseId: caseItem.id,
                repeat,
                round: roundNumber,
                location: 'adapter-response',
                kinds: [...new Set(redacted.findings)],
              })
            }
            rawText = redacted.text
            usage = normalizeUsage(response.usage)
            adapterRound = {
              modelId: typeof response.modelId === 'string' ? response.modelId : null,
              provider: typeof response.provider === 'string' ? response.provider : null,
              settingsApplied: applied,
            }
            completedCalls += 1
            const parsed = requests.parseReply(rawText)
            if (parsed.ok) {
              reply = parsed.reply
            } else {
              parseError = parsed.reason
              status = 'failed'
              stopReason = parsed.reason
              error = { kind: parsed.reason, status: null }
              roundStop = parsed.reason
            }
          } catch (cause) {
            if (cause instanceof UnsupportedSettingsError || cause?.code === 'unsupported-settings') {
              status = 'unsupported'
              stopReason = 'unsupported-settings'
              error = { kind: 'unsupported-settings', status: null }
              roundStop = 'unsupported-settings'
            } else if (timeout.aborted) {
              status = 'timeout'
              stopReason = 'timeout'
              error = { kind: 'timeout', status: null }
              roundStop = 'timeout'
            } else if (externalSignal?.aborted) {
              status = 'failed'
              stopReason = 'aborted'
              error = { kind: 'aborted', status: null }
              roundStop = 'aborted'
            } else if (cause instanceof AdapterError) {
              status = 'failed'
              stopReason = 'malformed-response'
              error = { kind: 'malformed-response', status: null }
              roundStop = 'malformed-response'
            } else {
              status = 'failed'
              stopReason = 'adapter-error'
              error = {
                kind: 'adapter-error',
                status: typeof cause?.status === 'number' && Number.isFinite(cause.status) ? cause.status : null,
              }
              roundStop = 'adapter-error'
            }
          }
        }

        const durationMs = Math.max(0, monotonic() - started)

        if (reply !== null && roundStop === 'answer-fed') {
          const question = reply.question
          if (question === null || question === undefined) {
            draft = reply.draft
            completedRounds += 1
            status = 'completed'
            stopReason = 'question-null'
            roundStop = 'question-null'
          } else if (index === allowed - 1) {
            stopReason = planItem.remainingRounds > allowed ? 'round-cap' : 'open-question-at-max-rounds'
            status = planItem.remainingRounds > allowed ? 'capped' : 'completed'
            roundStop = stopReason
          } else {
            const answer = caseItem.answers[answerIndex]
            if (answer === undefined) {
              status = 'completed'
              stopReason = 'awaiting-answer'
              roundStop = 'awaiting-answer'
            } else {
              const questionOk =
                answer.when?.questionIncludes === undefined ||
                question.includes(answer.when.questionIncludes)
              const optionOne = reply.options?.[0]
              const optionOk =
                answer.when?.option1Includes === undefined ||
                (typeof optionOne === 'string' && optionOne.includes(answer.when.option1Includes))
              if (!questionOk || !optionOk) {
                status = 'scenario-diverged'
                stopReason = 'answer-condition-mismatch'
                error = { kind: 'scenario-diverged', status: null }
                roundStop = 'answer-condition-mismatch'
              } else {
                draft = reply.draft
                completedRounds += 1
                dialogue.push({ role: 'user', text: answer.text })
                answerIndex += 1
                roundStop = 'answer-fed'
              }
            }
          }
        }

        rounds.push({
          round: roundNumber,
          source: mode,
          original: caseItem.original,
          context: caseItem.context.text,
          priorDialogue,
          answer: roundStop === 'answer-fed' && reply?.question ? dialogue[dialogue.length - 1]?.text ?? null : null,
          request: {
            model: built.request.model,
            system: built.request.system ?? built.system,
            prompt: built.request.prompt,
            maxTokens: built.request.maxTokens,
            effort: built.request.effort,
            timeoutMs: built.request.timeoutMs,
          },
          system: built.system,
          prompt: built.prompt,
          requestHash: sha256(stableStringify(built.request)),
          guidanceVersion: sha256(built.system),
          rawText,
          reply,
          parseError,
          judgments: [],
          durationMs,
          usage,
          adapter: adapterRound,
          stopReason: roundStop,
        })

        if (status !== 'completed') break
        if (roundStop === 'question-null' || roundStop === 'awaiting-answer') break
      }

      const graded = gradeEpisode({
        caseId: caseItem.id,
        replies: rounds.map(round => ({ round: round.round, reply: round.reply })),
        rules: caseItem.rules,
      })
      for (const round of rounds) {
        round.judgments = graded.judgments.filter(judgment => judgment.round === round.round)
      }

      repeatRecords.push({
        repeat,
        status,
        stopReason,
        rounds,
        error,
        judgmentSummary: {
          rulePasses: graded.rulePasses,
          ruleFailures: graded.ruleFailures,
          ruleNotApplicable: graded.ruleNotApplicable,
          parseFailures: graded.parseFailures,
        },
        humanReview: null,
      })
    }

    caseRecords.push({
      caseId: caseItem.id,
      caseHash,
      split: caseItem.split,
      tags: caseItem.tags,
      provenance: caseItem.provenance,
      constraints: caseItem.constraints,
      repeats: repeatRecords,
    })
  }

  // Profiles for cases that executed no round still need a recorded version.
  for (const caseItem of orderedCases) {
    const profile = caseItem.settings.guidanceProfile
    if (metadata.guidance.profiles[profile] !== undefined) continue
    if (typeof requests.metadata?.guidanceVersion === 'function') {
      const system =
        typeof requests.metadata.composeSystemPrompt === 'function'
          ? requests.metadata.composeSystemPrompt('', profile)
          : ''
      metadata.guidance.profiles[profile] = {
        version: requests.metadata.guidanceVersion(profile),
        chars: typeof system === 'string' ? [...system].length : null,
      }
    }
  }

  const reportedModels = [
    ...new Set(
      caseRecords
        .flatMap(item => item.repeats)
        .flatMap(repeat => repeat.rounds)
        .map(round => round.adapter?.modelId)
        .filter(value => typeof value === 'string' && value !== ''),
    ),
  ]
  metadata.model.reported = reportedModels
  metadata.model.actual = reportedModels.length === 1 ? reportedModels[0] : null
  metadata.attemptedCalls = attemptedCalls
  metadata.completedCalls = completedCalls
  metadata.endedAt = iso(now())
  metadata.corpusHash = sha256(
    caseRecords
      .map(item => `${item.caseId}:${item.caseHash}`)
      .sort()
      .join('\n'),
  )

  const result = { metadata, cases: caseRecords }
  result.aggregate = summarizeRun(result)
  return result
}
