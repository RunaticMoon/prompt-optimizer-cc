/**
 * Loads the production TypeScript hooks from a plain `.mjs` runner without a
 * build step or generated declarations.
 *
 * Node >=24.12 strips TypeScript types natively, but its ESM resolver still
 * requires an extension. The hooks use extensionless relative imports
 * (`./contracts`), so this module registers a synchronous resolve hook that
 * appends `.ts` **only** for extensionless relative specifiers whose parent and
 * target are both inside the selected checkout's `hooks/` directory. Every
 * other specifier is delegated to Node unchanged. The hook is deregistered as
 * soon as the imports finish.
 */

import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MIN_NODE_MAJOR = 24
export const MIN_NODE_MINOR = 12

/** Thrown before any import when the runtime cannot strip TypeScript types. */
export class RunnerRuntimeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RunnerRuntimeError'
  }
}

/** True for Node >=24.12 with native type stripping available. */
export function isSupportedRuntime(version = process.version, features = process.features) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version))
  if (match === null) return false
  if (features !== undefined && features.typescript === false) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
}

/** Fails with an actionable message for an unsupported runtime. */
export function assertSupportedRuntime(version = process.version, features = process.features) {
  if (isSupportedRuntime(version, features)) return
  throw new RunnerRuntimeError(
    `The eval runner requires Node >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} with native TypeScript ` +
      `type stripping (found ${version}). Run it with a supported Node runtime, for example ` +
      `\`npx -y node@${MIN_NODE_MAJOR} evals/runner/run.mjs ...\`; no npm dependency is needed.`,
  )
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Builds the scoped resolve hook. Exported so the containment rules can be
 * tested directly, without registering global behavior.
 */
export function createResolveHook(hooksDirectory) {
  const root = path.resolve(hooksDirectory)
  const rootUrl = pathToFileURL(root + path.sep).href

  return function resolve(specifier, context, nextResolve) {
    if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
      return nextResolve(specifier, context)
    }
    const parent = context?.parentURL
    if (typeof parent !== 'string' || !parent.startsWith(rootUrl)) {
      return nextResolve(specifier, context)
    }
    let candidate
    try {
      candidate = new URL(specifier, parent)
    } catch {
      return nextResolve(specifier, context)
    }
    if (candidate.protocol !== 'file:' || !candidate.href.startsWith(rootUrl)) {
      return nextResolve(specifier, context)
    }
    const candidatePath = fileURLToPath(candidate)
    if (!isInside(root, candidatePath)) return nextResolve(specifier, context)
    // Only extensionless specifiers are rewritten. A bare name (no dot) gains
    // `.ts`; an already-suffixed specifier is left to Node's normal resolver.
    if (path.basename(candidatePath).includes('.')) return nextResolve(specifier, context)
    return { url: `${candidate.href}.ts`, shortCircuit: true }
  }
}

/**
 * Imports the four production hook modules. `root` defaults to the checkout
 * containing this runner; `runtime` is injectable for tests.
 */
export async function loadHooks({ root, runtime } = {}) {
  const checkoutRoot = path.resolve(root ?? path.join(import.meta.dirname, '..', '..'))
  const selectedRuntime = runtime ?? { version: process.version, features: process.features }
  assertSupportedRuntime(selectedRuntime.version, selectedRuntime.features)

  const hooksDirectory = path.join(checkoutRoot, 'hooks')
  try {
    await readFile(path.join(hooksDirectory, 'model.ts'), 'utf8')
  } catch {
    throw new RunnerRuntimeError(
      `Could not find the production hooks at ${hooksDirectory}. ` +
        'Point the runner at a checkout of prompt-optimizer-cc.',
    )
  }

  const url = name => pathToFileURL(path.join(hooksDirectory, name)).href
  const hook = registerHooks({ resolve: createResolveHook(hooksDirectory) })
  try {
    const [model, contracts, systemPrompt, modelGuidance] = await Promise.all([
      import(url('model.ts')),
      import(url('contracts.ts')),
      import(url('system-prompt.ts')),
      import(url('model-guidance.ts')),
    ])
    return {
      checkoutRoot,
      hooksDirectory,
      runtime: selectedRuntime,
      model,
      contracts,
      systemPrompt,
      modelGuidance,
    }
  } finally {
    hook.deregister()
  }
}
