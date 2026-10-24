/**
 * Explicit evaluation runner CLI.
 *
 *   node evals/runner/run.mjs --validate --suite development
 *   node evals/runner/run.mjs --mock --suite development --repeats 1 --out /tmp/dev.json
 *   node evals/runner/run.mjs --live --adapter /absolute/adapter.mjs --model <id> \
 *     --max-calls 20 --max-rounds 2 --suite development --out /private/result.json
 *
 * `--validate` only loads and validates cases. `--mock` never imports an
 * adapter. `--live` is gated before any adapter import. No run is added to npm
 * test or CI.
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs, validateBudget } from './args.mjs'
import { assertSupportedRuntime } from './load-hooks.mjs'
import { loadCases } from './schema.mjs'

const CHECKOUT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const EVALS_ROOT = path.resolve(import.meta.dirname, '..')

const USAGE = [
  'usage:',
  '  node evals/runner/run.mjs --validate --suite development|holdout',
  '  node evals/runner/run.mjs --mock --suite development|holdout [--repeats N] [--max-calls N] [--max-rounds N] [--out FILE]',
  '  node evals/runner/run.mjs --live --adapter ABSOLUTE --model ID --max-calls N --max-rounds N [--repeats N] [--out FILE]',
].join('\n')

/**
 * Repository identity recorded in result metadata; never required. Git runs
 * against the checkout root so the caller's cwd cannot substitute another
 * repository's HEAD.
 */
function repoInfo() {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: CHECKOUT_ROOT })
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: CHECKOUT_ROOT })
  return {
    sha: sha.status === 0 ? sha.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim() !== '' : null,
  }
}

async function packageVersion() {
  try {
    const parsed = JSON.parse(await readFile(path.join(CHECKOUT_ROOT, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Reserves the output path with exclusive creation and a private file mode
 * before the first adapter call, so a live run cannot spend its calls and then
 * fail on an existing output. The reservation is removed again if the run
 * fails before any result is written.
 */
async function reserveOut(outPath) {
  const resolved = path.resolve(outPath)
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(resolved, 'wx', 0o600)
  } catch (cause) {
    if (cause?.code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing result: ${outPath}`)
    }
    throw cause
  }
  await handle.close()
  return resolved
}

/** Writes a result into a path already reserved by {@link reserveOut}. */
async function writeResult(reservedPath, result) {
  const handle = await open(reservedPath, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

/** A short stdout summary; never includes raw prompts or model responses. */
export function summaryLines(result) {
  const aggregate = result.aggregate ?? {}
  const totals = aggregate.totals ?? {}
  const semantic = aggregate.semantic ?? {}
  return [
    `${result.metadata.mode} run: suite=${result.metadata.suite}, cases=${totals.cases ?? result.cases.length}, repeats=${result.metadata.settings?.repeats ?? '?'}`,
    `calls: planned=${result.metadata.plannedCalls}, attempted=${result.metadata.attemptedCalls}, completed=${result.metadata.completedCalls}`,
    `rules: pass=${totals.rulePasses ?? 0}, fail=${totals.ruleFailures ?? 0}, not-applicable=${totals.ruleNotApplicable ?? 0}, parse-failures=${totals.parseFailures ?? 0}`,
    `semantic review: ${semantic.status ?? 'unreviewed'} (${semantic.reviewedEpisodes ?? 0}/${totals.episodes ?? 0}); unreviewed rates are N/A`,
    aggregate.label ?? 'rules are not semantic quality evidence',
  ]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  assertSupportedRuntime()

  const cases = await loadCases(EVALS_ROOT, args.suite)
  if (args.mode === 'validate') {
    console.log(`validated ${cases.length} case(s) for ${args.suite}: ${cases.map(item => item.id).join(', ')}`)
    return
  }
  validateBudget(cases, args)

  let reserved = null
  try {
    if (args.out !== null) reserved = await reserveOut(args.out)
    const { createRequests } = await import('./requests.mjs')
    const requests = await createRequests()
    const { runEvaluation } = await import('./core.mjs')
    const result = await runEvaluation({
      cases,
      args,
      requests,
      repo: repoInfo(),
      packageVersion: await packageVersion(),
    })

    if (reserved !== null) {
      await writeResult(reserved, result)
      reserved = null
      console.log(`result written to ${args.out}`)
    }
    for (const line of summaryLines(result)) console.log(line)
    if (args.mode === 'live') {
      console.log('live adapter calls were capped by logical complete invocations; provider-internal retries are not bounded')
    }
  } catch (cause) {
    // Nothing was written yet, so the failed run must not keep blocking the path.
    if (reserved !== null) await unlink(reserved).catch(() => {})
    throw cause
  }
}

function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
