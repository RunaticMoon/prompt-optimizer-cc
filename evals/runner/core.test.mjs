import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadAdapter } from './adapters.mjs'
import { ArgsError, validateBudget } from './args.mjs'
import { SensitiveDataError, runEvaluation } from './core.mjs'

const FAKE_ADAPTER = path.join(import.meta.dirname, 'fixtures', 'fake-adapter.mjs')
const AWS_KEY = `AKIA${'A'.repeat(16)}`

function parseReply(text) {
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object') return { ok: false, reason: 'invalid-json' }
    if (typeof value.draft !== 'string' || value.draft.trim() === '') return { ok: false, reason: 'empty-draft' }
    const question = typeof value.question === 'string' && value.question.trim() !== '' ? value.question : null
    return {
      ok: true,
      reply: {
        draft: value.draft,
        message: typeof value.message === 'string' ? value.message : '',
        question,
        options: Array.isArray(value.options) ? value.options.filter(option => typeof option === 'string') : [],
      },
    }
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
}

function fakeRequests() {
  return {
    buildRound(caseState, settings) {
      const system = `SYS:${settings.guidanceProfile}`
      const dialogue = caseState.dialogue.map(message => `${message.role}:${message.text}`).join('|')
      const prompt = `PROMPT|original=${caseState.original}|draft=${caseState.draft}|round=${caseState.rounds + 1}|dialogue=${dialogue}`
      return {
        request: {
          model: settings.model ?? 'eval-request-model',
          system,
          prompt,
          maxTokens: settings.maxTokens,
          effort: 'low',
          timeoutMs: settings.timeoutMs,
        },
        system,
        prompt,
        round: caseState.rounds + 1,
      }
    },
    parseReply,
    metadata: {
      nodeVersion: 'v26.12.0',
      guidanceVersion: profile => `${profile}`.padEnd(64, 'g').slice(0, 64),
      composeSystemPrompt: (extra, profile) => `SYS:${profile}`,
      sourceHashes: async () => ({ 'hooks/model.ts': 'a'.repeat(64) }),
    },
  }
}

function reply(overrides = {}) {
  return { draft: 'draft one', message: '메시지', question: null, options: [], ...overrides }
}

function makeCase(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'case-a',
    split: 'development',
    tags: [],
    provenance: { kind: 'synthetic-authored', source: 'test' },
    original: '요청 원문',
    context: { text: '근거 텍스트' },
    initialDialogue: [],
    initialDraft: '',
    roundsCompleted: 0,
    settings: {
      guidanceProfile: 'common',
      maxRounds: 1,
      maxTokens: 1024,
      timeoutMs: 1000,
      cache: false,
    },
    answers: [],
    constraints: [],
    rules: [],
    mockResponses: [reply()],
    ...overrides,
  }
}

function args(overrides = {}) {
  return {
    mode: 'mock',
    suite: 'development',
    repeats: 1,
    out: null,
    adapter: null,
    model: null,
    maxCalls: null,
    maxRounds: 5,
    maxCallMs: 120000,
    ...overrides,
  }
}

function stubAdapter(complete) {
  return {
    kind: 'fake',
    path: '/tmp/fake-adapter.mjs',
    identity: 'fake-adapter.mjs',
    hash: 'f'.repeat(64),
    complete,
  }
}

async function run(cases, argsValue, extra = {}) {
  return runEvaluation({
    cases,
    args: argsValue,
    requests: fakeRequests(),
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    monotonic: (() => {
      let value = 0
      return () => {
        value += 7
        return value
      }
    })(),
    ...extra,
  })
}

test('mock mode replays exactly the synthetic response and records metadata', async () => {
  const result = await run([makeCase()], args())
  assert.equal(result.metadata.mode, 'mock')
  assert.equal(result.metadata.adapter, null)
  assert.equal(result.metadata.attemptedCalls, 1)
  assert.equal(result.metadata.completedCalls, 1)
  assert.equal(result.cases.length, 1)
  assert.equal(result.cases[0].repeats[0].status, 'completed')
  assert.equal(result.cases[0].repeats[0].rounds[0].reply.draft, 'draft one')
  assert.deepEqual(result.cases[0].repeats[0].rounds[0].usage, {
    known: true,
    synthetic: true,
    counts: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  assert.equal(result.aggregate.mode, 'mock')
  assert.match(result.aggregate.label, /no semantic-quality conclusion/)
})

test('mock mode rejects an adapter and never imports a poisoned path', async () => {
  await assert.rejects(
    run([makeCase()], args({ adapter: '/tmp/poisoned-adapter.mjs' })),
    /must not receive an adapter/,
  )
  await assert.rejects(
    run([makeCase()], args(), { adapter: stubAdapter(async () => ({ text: '{}' })) }),
    /must not receive an adapter/,
  )
})

test('budget preflight rejects an over-cap plan before any call', async () => {
  const cases = [makeCase({ id: 'case-a', settings: { ...makeCase().settings, maxRounds: 2 } }), makeCase({ id: 'case-b' })]
  await assert.rejects(run(cases, args({ maxCalls: 2 })), /planned calls/)
  assert.throws(() => validateBudget(cases, args({ maxCalls: 2 })), ArgsError)
})

test('a failed call counts once and is never retried', async () => {
  let calls = 0
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1 }), {
    adapter: stubAdapter(async () => {
      calls += 1
      throw new Error('provider unavailable')
    }),
  })
  assert.equal(calls, 1)
  assert.equal(result.metadata.attemptedCalls, 1)
  assert.equal(result.metadata.completedCalls, 0)
  assert.equal(result.cases[0].repeats[0].status, 'failed')
  assert.deepEqual(result.cases[0].repeats[0].error, { kind: 'adapter-error', status: null })
  assert.equal(result.cases[0].repeats[0].rounds[0].reply, null)
})

test('failures consume the global call budget across repeats', async () => {
  let calls = 0
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 2, repeats: 2 }), {
    adapter: stubAdapter(async () => {
      calls += 1
      throw new Error('nope')
    }),
  })
  assert.equal(calls, 2)
  assert.equal(result.metadata.attemptedCalls, 2)
  assert.deepEqual(
    result.cases[0].repeats.map(item => item.status),
    ['failed', 'failed'],
  )
})

test('a null question ends the episode after one call', async () => {
  const result = await run(
    [makeCase({ settings: { ...makeCase().settings, maxRounds: 3 }, mockResponses: [reply()] })],
    args(),
  )
  assert.equal(result.cases[0].repeats[0].rounds.length, 1)
  assert.equal(result.cases[0].repeats[0].stopReason, 'question-null')
  assert.equal(result.metadata.attemptedCalls, 1)
})

test('an answer is fed into the next round only after its question', async () => {
  const caseItem = makeCase({
    settings: { ...makeCase().settings, maxRounds: 2 },
    answers: [{ text: '운영 환경', when: { questionIncludes: '환경' } }],
    mockResponses: [
      reply({ draft: 'draft one', question: '어느 환경인가요?', options: ['운영 환경'] }),
      reply({ draft: 'draft two' }),
    ],
  })
  const result = await run([caseItem], args())
  const rounds = result.cases[0].repeats[0].rounds
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].answer, '운영 환경')
  assert.match(rounds[1].prompt, /dialogue=user:운영 환경/)
  assert.equal(result.metadata.attemptedCalls, 2)
})

test('a deictic mismatch stops as scenario-diverged without inventing an answer', async () => {
  const caseItem = makeCase({
    settings: { ...makeCase().settings, maxRounds: 2 },
    answers: [{ text: '1번', when: { questionIncludes: '기준', option1Includes: '정률' } }],
    mockResponses: [
      reply({ question: '기준은?', options: ['정액 할인'] }),
      reply({ draft: 'should not run' }),
    ],
  })
  const result = await run([caseItem], args())
  assert.equal(result.cases[0].repeats[0].status, 'scenario-diverged')
  assert.equal(result.cases[0].repeats[0].stopReason, 'answer-condition-mismatch')
  assert.equal(result.cases[0].repeats[0].rounds.length, 1)
  assert.equal(result.cases[0].repeats[0].rounds[0].answer, null)
})

test('a question with no scripted answer ends with an open decision', async () => {
  const caseItem = makeCase({
    settings: { ...makeCase().settings, maxRounds: 2 },
    mockResponses: [reply({ question: '아직 정할 것이 있나요?', options: ['예'] }), reply()],
  })
  const result = await run([caseItem], args())
  assert.equal(result.cases[0].repeats[0].status, 'completed')
  assert.equal(result.cases[0].repeats[0].stopReason, 'awaiting-answer')
  assert.equal(result.cases[0].repeats[0].rounds.length, 1)
})

test('the CLI round cap keeps the last question and marks the episode capped', async () => {
  const caseItem = makeCase({
    settings: { ...makeCase().settings, maxRounds: 3 },
    answers: [
      { text: 'a1' },
      { text: 'a2' },
    ],
    mockResponses: [
      reply({ question: 'q1?', options: ['a1'] }),
      reply({ question: 'q2?', options: ['a2'] }),
      reply({ draft: 'third' }),
    ],
  })
  const result = await run([caseItem], args({ maxRounds: 2 }))
  assert.equal(result.cases[0].repeats[0].status, 'capped')
  assert.equal(result.cases[0].repeats[0].stopReason, 'round-cap')
  assert.equal(result.cases[0].repeats[0].rounds.length, 2)
  assert.equal(result.cases[0].repeats[0].rounds[1].reply.question, 'q2?')
})

test('live mode requires an explicit model and a non-CI environment', async () => {
  let calls = 0
  await assert.rejects(
    run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', maxCalls: 1 }), {
      adapter: stubAdapter(async () => {
        calls += 1
        return { text: '{}' }
      }),
    }),
    /explicit model/,
  )
  await assert.rejects(
    run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1 }), {
      adapter: stubAdapter(async () => {
        calls += 1
        return { text: '{}' }
      }),
      env: { CI: '1' },
    }),
    /CI environment variable CI/,
  )
  assert.equal(calls, 0)
})

test('unsupported request settings fail explicitly as unsupported', async () => {
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1 }), {
    adapter: stubAdapter(async () => {
      throw Object.assign(new Error('no effort support'), { code: 'unsupported-settings' })
    }),
  })
  assert.equal(result.cases[0].repeats[0].status, 'unsupported')
  assert.deepEqual(result.cases[0].repeats[0].error, { kind: 'unsupported-settings', status: null })
})

test('a malformed adapter envelope is a failed call, not a crash', async () => {
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1 }), {
    adapter: stubAdapter(async () => ({ text: 42 })),
  })
  assert.equal(result.cases[0].repeats[0].status, 'failed')
  assert.deepEqual(result.cases[0].repeats[0].error, { kind: 'malformed-response', status: null })
})

test('a timeout aborts the call and is recorded separately', async () => {
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1, maxCallMs: 20 }), {
    adapter: stubAdapter(async (request, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(signal.reason ?? new Error('aborted'))
          },
          { once: true },
        )
      })
      return { text: '{}' }
    }),
  })
  assert.equal(result.cases[0].repeats[0].status, 'timeout')
  assert.deepEqual(result.cases[0].repeats[0].error, { kind: 'timeout', status: null })
})

test('missing live usage stays unknown rather than zero', async () => {
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1 }), {
    adapter: stubAdapter(async () => ({ text: JSON.stringify(reply()), modelId: 'actual-model' })),
  })
  const round = result.cases[0].repeats[0].rounds[0]
  assert.deepEqual(round.usage, { known: false, counts: null })
  assert.equal(result.metadata.model.actual, 'actual-model')
})

test('supplied credential-shaped data is refused before any call', async () => {
  const caseItem = makeCase({ original: `로그인 키 ${AWS_KEY} 를 확인해줘.` })
  await assert.rejects(run([caseItem], args()), error => {
    assert.ok(error instanceof SensitiveDataError)
    assert.match(error.message, /original/)
    assert.match(error.message, /aws-key/)
    assert.ok(!error.message.includes(AWS_KEY))
    return true
  })
})

test('a credential-shaped live response is redacted and marks the run non-comparable', async () => {
  const text = JSON.stringify({ draft: `token ${AWS_KEY}`, message: 'm', question: null, options: [] })
  const result = await run([makeCase()], args({ mode: 'live', adapter: '/tmp/fake.mjs', model: 'm', maxCalls: 1 }), {
    adapter: stubAdapter(async () => ({ text, modelId: 'actual-model' })),
  })
  assert.equal(result.metadata.comparable, false)
  assert.equal(result.metadata.sensitiveFindings.length, 1)
  assert.deepEqual(result.metadata.sensitiveFindings[0].kinds, ['aws-key'])
  assert.ok(!JSON.stringify(result).includes(AWS_KEY))
  assert.match(result.cases[0].repeats[0].rounds[0].rawText, /\[REDACTED:aws-key\]/)
})

test('loadAdapter hashes and runs the fake adapter through the live boundary', async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'popt-core-'))
  const logPath = path.join(logDir, 'calls.jsonl')
  const previousMode = process.env.POPT_FAKE_ADAPTER_MODE
  const previousLog = process.env.POPT_FAKE_ADAPTER_LOG
  process.env.POPT_FAKE_ADAPTER_MODE = 'ok'
  process.env.POPT_FAKE_ADAPTER_LOG = logPath
  try {
    const loaded = await loadAdapter(FAKE_ADAPTER)
    assert.match(loaded.hash, /^[a-f0-9]{64}$/)
    assert.equal(loaded.kind, 'trusted')

    const result = await run(
      [makeCase({ rules: [{ id: 'done', kind: 'questionNull', round: 'final' }] })],
      args({ mode: 'live', adapter: FAKE_ADAPTER, model: 'requested-model', maxCalls: 1 }),
      { adapter: null },
    )
    assert.equal(result.metadata.adapter.kind, 'trusted')
    assert.equal(result.metadata.adapter.hash, loaded.hash)
    assert.equal(result.metadata.model.requested, 'requested-model')
    assert.equal(result.metadata.model.actual, 'fake-model-1')
    const round = result.cases[0].repeats[0].rounds[0]
    assert.equal(round.reply.draft, 'fake draft')
    assert.equal(round.adapter.settingsApplied.known, true)
    assert.equal(round.judgments[0].status, 'pass')
    const calls = (await readFile(logPath, 'utf8')).trim().split('\n')
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0]).model, 'requested-model')
  } finally {
    if (previousMode === undefined) delete process.env.POPT_FAKE_ADAPTER_MODE
    else process.env.POPT_FAKE_ADAPTER_MODE = previousMode
    if (previousLog === undefined) delete process.env.POPT_FAKE_ADAPTER_LOG
    else process.env.POPT_FAKE_ADAPTER_LOG = previousLog
  }
})

test('injected clocks make metadata and durations reproducible', async () => {
  const result = await run([makeCase()], args(), {
    now: (() => {
      const dates = [new Date('2026-10-02T12:00:00.000Z'), new Date('2026-10-02T12:00:05.000Z')]
      let index = 0
      return () => dates[Math.min(index++, dates.length - 1)]
    })(),
    monotonic: (() => {
      let value = 0
      return () => {
        value += 5
        return value
      }
    })(),
  })
  assert.equal(result.metadata.startedAt, '2026-10-02T12:00:00.000Z')
  assert.equal(result.metadata.endedAt, '2026-10-02T12:00:05.000Z')
  assert.equal(result.cases[0].repeats[0].rounds[0].durationMs, 5)
})
