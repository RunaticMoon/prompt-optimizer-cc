/**
 * Command-line contract for the evaluation runner.
 *
 * Modes are mutually exclusive and default to `mock`, which never imports an
 * adapter and never looks for credentials. Live runs require an explicit
 * adapter, model, call cap and round cap, and are rejected in any nonempty CI
 * environment before an adapter path is touched.
 *
 * `validateBudget` preflights the worst case before the first call: the sum of
 * each case's remaining rounds (capped by the CLI round limit) times repeats
 * must fit the call cap. Nothing is silently skipped to fit.
 */

import path from 'node:path'

export const RUNNER_VERSION = '1'
export const SCHEMA_VERSION = 1

export const MAX_CALLS = 1000
export const MAX_ROUNDS = 5
export const MAX_REPEATS = 10
export const MAX_CALL_MS = 120000

export const RUN_MODES = ['validate', 'mock', 'live']
export const SUITES = ['development', 'holdout']

export const CI_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_ID',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TF_BUILD',
  'TEAMCITY_VERSION',
  'BUILDKITE',
  'DRONE',
  'CODEBUILD_BUILD_ID',
]

/** A command-line or budget error whose message is safe to print. */
export class ArgsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArgsError'
  }
}

function positiveInteger(raw, flag, max) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ArgsError(`${flag} expects a positive integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ArgsError(`${flag} expects a positive integer`)
  }
  if (value > max) throw new ArgsError(`${flag} must be at most ${max}`)
  return value
}

function valueString(raw, flag) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\u0000')) {
    throw new ArgsError(`${flag} expects a nonempty value`)
  }
  return raw
}

/** Returns the first nonempty CI environment variable name, or null. */
export function detectCi(env) {
  for (const name of CI_ENV_VARS) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return name
  }
  return null
}

/**
 * Parses the runner's argv. `--flag=value` and `--flag value` are both
 * accepted; unknown flags and positional arguments fail.
 */
export function parseArgs(argv, env = process.env) {
  const args = {
    mode: null,
    suite: 'development',
    repeats: 1,
    out: null,
    adapter: null,
    model: null,
    maxCalls: null,
    maxRounds: null,
    maxCallMs: MAX_CALL_MS,
    help: false,
  }

  const tokens = [...argv]
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let flag = token
    let inline = null
    if (token.startsWith('--') && token.includes('=')) {
      const split = token.indexOf('=')
      flag = token.slice(0, split)
      inline = token.slice(split + 1)
    }

    const takeValue = () => {
      if (inline !== null) return inline
      const next = tokens[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new ArgsError(`${flag} expects a value`)
      }
      index += 1
      return next
    }

    switch (flag) {
      case '--validate':
      case '--mock':
      case '--live': {
        if (inline !== null) throw new ArgsError(`${flag} does not take a value`)
        const mode = flag.slice(2)
        if (args.mode !== null && args.mode !== mode) {
          throw new ArgsError(`modes are mutually exclusive: --${args.mode} and ${flag}`)
        }
        args.mode = mode
        break
      }
      case '--suite':
        args.suite = valueString(takeValue(), flag)
        if (!SUITES.includes(args.suite)) {
          throw new ArgsError(`--suite must be one of: ${SUITES.join(', ')}`)
        }
        break
      case '--repeats':
        args.repeats = positiveInteger(takeValue(), flag, MAX_REPEATS)
        break
      case '--out':
        args.out = valueString(takeValue(), flag)
        break
      case '--adapter':
        args.adapter = valueString(takeValue(), flag)
        break
      case '--model':
        args.model = valueString(takeValue(), flag)
        break
      case '--max-calls':
        args.maxCalls = positiveInteger(takeValue(), flag, MAX_CALLS)
        break
      case '--max-rounds':
        args.maxRounds = positiveInteger(takeValue(), flag, MAX_ROUNDS)
        break
      case '--max-call-ms':
        args.maxCallMs = positiveInteger(takeValue(), flag, MAX_CALL_MS)
        break
      case '--help':
      case '-h':
        if (inline !== null) throw new ArgsError(`${flag} does not take a value`)
        args.help = true
        break
      default:
        if (flag.startsWith('-')) throw new ArgsError(`unknown flag: ${flag}`)
        throw new ArgsError(`unexpected argument: ${token}`)
    }
  }

  if (args.help) return args
  if (args.mode === null) args.mode = 'mock'

  if (args.mode === 'live') {
    const ci = detectCi(env)
    if (ci !== null) {
      throw new ArgsError(`refusing --live while the CI environment variable ${ci} is set`)
    }
    if (args.adapter === null) throw new ArgsError('--live requires --adapter <absolute-path>')
    if (!path.isAbsolute(args.adapter)) {
      throw new ArgsError('--live --adapter must be an absolute path')
    }
    if (!args.adapter.endsWith('.mjs') && !args.adapter.endsWith('.js')) {
      throw new ArgsError('--live --adapter must name a .mjs or .js module')
    }
    if (args.model === null) throw new ArgsError('--live requires --model <explicit-model-id>')
    if (args.maxCalls === null) throw new ArgsError('--live requires --max-calls <positive-integer>')
    if (args.maxRounds === null) {
      throw new ArgsError('--live requires --max-rounds <positive-integer>')
    }
  } else {
    if (args.adapter !== null) throw new ArgsError('--adapter is only valid with --live')
    if (args.model !== null) throw new ArgsError('--model is only valid with --live')
  }

  if (args.mode === 'validate') {
    for (const [name, value] of [
      ['--repeats', args.repeats === 1 ? null : args.repeats],
      ['--out', args.out],
      ['--max-calls', args.maxCalls],
      ['--max-rounds', args.maxRounds],
      ['--max-call-ms', args.maxCallMs === MAX_CALL_MS ? null : args.maxCallMs],
    ]) {
      if (value !== null) throw new ArgsError(`${name} is not used with --validate`)
    }
  }

  if (args.mode !== 'live' && args.maxRounds === null) args.maxRounds = MAX_ROUNDS
  return args
}

/**
 * Plans the worst-case calls for the selected cases and caps. Throws before
 * any case runs when the plan exceeds `--max-calls` or the hard global cap.
 * `args` may come from {@link parseArgs} or a programmatic caller.
 */
export function validateBudget(cases, args) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new ArgsError('no cases selected')
  }
  if (!Number.isInteger(args.maxRounds) || args.maxRounds < 1 || args.maxRounds > MAX_ROUNDS) {
    throw new ArgsError(`--max-rounds must be an integer between 1 and ${MAX_ROUNDS}`)
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > MAX_REPEATS) {
    throw new ArgsError(`--repeats must be an integer between 1 and ${MAX_REPEATS}`)
  }
  if (
    args.maxCalls !== null &&
    args.maxCalls !== undefined &&
    (!Number.isInteger(args.maxCalls) || args.maxCalls < 1 || args.maxCalls > MAX_CALLS)
  ) {
    throw new ArgsError(`--max-calls must be an integer between 1 and ${MAX_CALLS}`)
  }

  const perCase = cases.map((item, index) => {
    const caseId = typeof item?.id === 'string' ? item.id : `case[${index}]`
    const maxRounds = item?.settings?.maxRounds
    const completedRounds = item?.roundsCompleted
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
      throw new ArgsError(`${caseId}: settings.maxRounds is invalid`)
    }
    if (!Number.isInteger(completedRounds) || completedRounds < 0 || completedRounds > maxRounds) {
      throw new ArgsError(`${caseId}: roundsCompleted is invalid`)
    }
    const remainingRounds = maxRounds - completedRounds
    return {
      caseId,
      completedRounds,
      maxRounds,
      remainingRounds,
      roundsThisRun: Math.min(remainingRounds, args.maxRounds),
    }
  })

  const plannedCalls =
    perCase.reduce((total, item) => total + item.roundsThisRun, 0) * args.repeats
  if (plannedCalls > MAX_CALLS) {
    throw new ArgsError(`planned calls ${plannedCalls} exceed the hard cap of ${MAX_CALLS}`)
  }
  if (args.maxCalls !== null && args.maxCalls !== undefined && plannedCalls > args.maxCalls) {
    throw new ArgsError(
      `planned calls ${plannedCalls} exceed --max-calls ${args.maxCalls}; reduce repeats, rounds or cases`,
    )
  }
  const maxCalls = args.maxCalls ?? plannedCalls
  if (maxCalls < 1) throw new ArgsError('the effective call cap must be positive')

  return { plannedCalls, maxCalls, perCase, repeats: args.repeats }
}
