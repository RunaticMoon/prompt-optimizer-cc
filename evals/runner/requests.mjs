/**
 * Adapts the production request builder to the evaluation runner.
 *
 * `buildRound` constructs the same minimal Workflow shape used by
 * `tests/model.test.ts`, composes the real system prompt, and calls the real
 * `buildModelRequest`. No prompt text is reimplemented here: a runner request
 * and a plugin request with the same state are the same object.
 *
 * This is request-builder reuse, not a claim that the full controller/engine
 * path (collection, ownership, transfer, UI) is reproduced in Node.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadHooks } from './load-hooks.mjs'

const DEFAULT_REQUEST_MODEL = 'eval-request-model'

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const SOURCE_FILES = [
  'hooks/model.ts',
  'hooks/contracts.ts',
  'hooks/system-prompt.ts',
  'hooks/model-guidance.ts',
]

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Builds the minimal production Workflow for one replayed round.
 * `caseState` carries the original prompt, supplied synthetic evidence, the
 * current draft, prior dialogue and the number of completed rounds.
 */
export function buildWorkflow(caseState) {
  const contextText = typeof caseState.contextText === 'string' ? caseState.contextText : ''
  return {
    id: 'eval-case',
    sessionId: 'eval-session',
    generation: 0,
    phase: 'generating',
    original: caseState.original,
    originalContext: [],
    draft: typeof caseState.draft === 'string' ? caseState.draft : '',
    context: {
      conversation: '',
      rules: '',
      location: '',
      tools: '',
      text: contextText,
      chars: contextText.length,
    },
    dialogue: Array.isArray(caseState.dialogue)
      ? caseState.dialogue.map(message => ({ role: message.role, text: message.text }))
      : [],
    rounds: Number.isInteger(caseState.rounds) ? caseState.rounds : 0,
    ui: 'pane',
    usage: ZERO_USAGE,
  }
}

/** Builds the production config for one case, using its frozen settings. */
export function buildConfig(settings, contracts) {
  return {
    ...contracts.DEFAULT_CONFIG,
    model: settings.model === undefined ? DEFAULT_REQUEST_MODEL : settings.model,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
    maxRounds: settings.maxRounds,
  }
}

/**
 * Loads the production hooks once and returns the request API consumed by
 * `core.mjs`, plus metadata the runner records in its result.
 */
export async function createRequests({ root, runtime } = {}) {
  const hooks = await loadHooks({ root, runtime })
  const { buildModelRequest, parseReply, requestText } = hooks.model
  const { composeSystemPrompt } = hooks.systemPrompt
  const checkoutRoot = hooks.checkoutRoot

  function buildRound(caseState, settings) {
    const system = composeSystemPrompt('', settings.guidanceProfile)
    const workflow = buildWorkflow(caseState)
    const config = buildConfig(settings, hooks.contracts)
    const request = buildModelRequest(workflow, config, system, '', {
      cache: settings.cache === true,
    })
    return { request, system, prompt: requestText(request.prompt), round: workflow.rounds + 1 }
  }

  const metadata = {
    nodeVersion: hooks.runtime.version,
    checkoutRoot,
    sourceFiles: [...SOURCE_FILES],
    composeSystemPrompt,
    /** SHA-256 of the exact system text for a guidance profile. */
    guidanceVersion(profile) {
      return sha256(composeSystemPrompt('', profile))
    },
    /** SHA-256 of each production hook source file. */
    async sourceHashes() {
      const hashes = {}
      for (const file of SOURCE_FILES) {
        hashes[file] = sha256(await readFile(path.join(checkoutRoot, file), 'utf8'))
      }
      return hashes
    },
  }

  return {
    buildRound,
    parseReply,
    requestText,
    buildWorkflow,
    buildConfig: settings => buildConfig(settings, hooks.contracts),
    metadata,
  }
}
