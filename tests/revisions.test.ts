import { describe, expect, test } from 'claude-code/testing'

import type { ModelUsage, OptimizerReply, RuntimeState, Workflow } from '../hooks/contracts'
import { MAX_REVISIONS, revisionIdFor } from '../hooks/revisions'
import { reduce } from '../hooks/state'

const SESSION = 'sess-1'

const ZERO: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    sessionId: SESSION,
    generation: 1,
    phase: 'generating',
    original: '원본',
    originalContext: ['ctx-a'],
    draft: '',
    context: null,
    dialogue: [],
    rounds: 0,
    ui: 'composer',
    usage: ZERO,
    ...over,
  }
}

function state(over: Partial<RuntimeState> = {}): RuntimeState {
  return {
    sessionId: SESSION,
    workflow: null,
    bypass: null,
    rawMode: null,
    usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, updatedAt: 0 },
    ...over,
  }
}

function reply(over: Partial<OptimizerReply> = {}): OptimizerReply {
  return { draft: '개선안', message: '변경 메모', question: null, ...over }
}

function generating(current: RuntimeState): RuntimeState {
  return reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 1, phase: 'generating' }, 1)
}

function succeed(current: RuntimeState, over: Partial<OptimizerReply> = {}): RuntimeState {
  return reduce(current, {
    type: 'reply', workflowId: 'wf-1', generation: 1, sessionId: SESSION, reply: reply(over), usage: ZERO,
  }, 1)
}

/** Drives `count` successful rounds, re-entering generating between them. */
function runSuccesses(count: number, draft = (round: number): string => `초안 ${round}`): RuntimeState {
  let current = state({ workflow: workflow() })
  for (let round = 1; round <= count; round += 1) {
    current = succeed(current, { draft: draft(round) })
    if (round < count) current = generating(current)
  }
  return current
}

function failed(current: RuntimeState): RuntimeState {
  return reduce(generating(current), {
    type: 'failed', workflowId: 'wf-1', generation: 1, sessionId: SESSION, error: 'boom',
  }, 1)
}

function budgetBlocked(current: RuntimeState): RuntimeState {
  return reduce(generating(current), {
    type: 'budget-blocked', workflowId: 'wf-1', generation: 1, sessionId: SESSION,
    requiredChars: 18_500, limitChars: 18_000, decisionIds: [],
  }, 1)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

describe('revision ids', () => {
  test('ids follow their sequence number', () => {
    expect(revisionIdFor(1)).toBe('r1')
    expect(revisionIdFor(12)).toBe('r12')
  })
})

describe('successful reply snapshots', () => {
  test('each success appends a revision carrying the reply state', () => {
    const current = runSuccesses(2)
    const revisions = current.workflow?.revisions ?? []
    expect(revisions.map(revision => revision.id)).toEqual(['r1', 'r2'])
    expect(revisions[0]).toEqual({
      id: 'r1',
      successfulRound: 1,
      draft: '초안 1',
      message: '변경 메모',
      question: null,
      questionId: null,
      options: [],
      dialogue: [{ role: 'optimizer', text: '변경 메모' }],
      decisions: { entries: [], nextId: 1 },
    })
    // The snapshot holds the review state only; original/context stay
    // workflow-constant and are never copied per revision.
    expect(Object.keys(revisions[0] ?? {}).sort()).toEqual([
      'decisions', 'dialogue', 'draft', 'id', 'message', 'options', 'question', 'questionId', 'successfulRound',
    ])
    expect(current.workflow?.currentRevisionId).toBe('r2')
    expect(current.workflow?.nextRevisionId).toBe(3)
  })

  test('the snapshot keeps the exact question, choices and minted question id', () => {
    let current = state({ workflow: workflow() })
    current = succeed(current, { draft: '개선안', message: '요약', question: '어느 쪽인가요?', options: ['A', 'B'] })
    const revision = current.workflow?.revisions?.[0]
    expect(revision?.question).toBe('어느 쪽인가요?')
    expect(revision?.questionId).toBe('q:wf-1:1:1')
    expect(revision?.options).toEqual(['A', 'B'])
    expect(revision?.successfulRound).toBe(1)
    // The answer clears the pending question on the workflow, but the
    // snapshot still shows what was offered when that success landed.
    current = reduce(current, { type: 'instruct', workflowId: 'wf-1', text: 'A' }, 1)
    expect(current.workflow?.question).toBeNull()
    expect(revision?.question).toBe('어느 쪽인가요?')
  })

  test('six successes evict the oldest and keep five including current', () => {
    const current = runSuccesses(MAX_REVISIONS + 1)
    const revisions = current.workflow?.revisions ?? []
    expect(revisions).toHaveLength(MAX_REVISIONS)
    expect(revisions.map(revision => revision.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6'])
    expect(revisions[0]?.draft).toBe('초안 2')
    expect(revisions[0]?.successfulRound).toBe(2)
    expect(current.workflow?.currentRevisionId).toBe('r6')
    expect(current.workflow?.nextRevisionId).toBe(7)
  })

  test('a failure spends its round but never creates or drops a snapshot', () => {
    const before = runSuccesses(2)
    const history = before.workflow?.revisions
    const current = failed(before)
    expect(current.workflow?.phase).toBe('failed')
    expect(current.workflow?.rounds).toBe(3)
    expect(current.workflow?.revisions).toBe(history)
    expect(current.workflow?.currentRevisionId).toBe('r2')
  })

  test('a budget refusal never creates a snapshot', () => {
    const before = runSuccesses(1)
    const current = budgetBlocked(before)
    expect(current.workflow?.phase).toBe('failed')
    expect(current.workflow?.revisions).toEqual(before.workflow?.revisions)
    expect(current.workflow?.currentRevisionId).toBe('r1')
    expect(current.workflow?.nextRevisionId).toBe(2)
  })

  test('revision ids stay stable across failed attempts in between', () => {
    let current = runSuccesses(1)
    current = failed(current)
    current = succeed(generating(current), { draft: '두 번째' })
    expect(current.workflow?.revisions?.map(revision => revision.id)).toEqual(['r1', 'r2'])
    // The second success was round 3: one success, one failed attempt, one success.
    expect(current.workflow?.revisions?.[1]?.successfulRound).toBe(3)
    expect(current.workflow?.revisions?.[1]?.draft).toBe('두 번째')
  })

  test('a duplicate settled reply cannot overwrite the review state or history', () => {
    const current = runSuccesses(1)
    const duplicate = reduce(current, {
      type: 'reply', workflowId: 'wf-1', generation: 1, sessionId: SESSION, reply: reply({ draft: '중복' }), usage: ZERO,
    }, 1)
    expect(duplicate.workflow?.phase).toBe('reviewing')
    expect(duplicate.workflow?.draft).toBe('초안 1')
    expect(duplicate.workflow?.revisions).toEqual(current.workflow?.revisions)
    expect(duplicate.workflow?.rounds).toBe(1)
    // #33 policy stands: a same-session settled result still counts its usage.
    expect(duplicate.usage.calls).toBe(2)
  })

  test('session reset and dismiss release the whole history with the workflow', () => {
    const current = runSuccesses(2)
    expect(reduce(current, { type: 'reset', sessionId: SESSION }, 1).workflow).toBeNull()
    expect(reduce(current, { type: 'dismiss', workflowId: 'wf-1' }, 1).workflow).toBeNull()
  })

  test('a frozen workflow is not mutated by recording the next snapshot', () => {
    const frozen = deepFreeze(runSuccesses(1))
    const first = frozen.workflow?.revisions?.[0]
    const serialized = JSON.stringify(first)
    const current = succeed(generating(frozen), { draft: '두 번째' })
    const second = current.workflow?.revisions?.[1]
    expect(JSON.stringify(first)).toBe(serialized)
    expect(second?.id).toBe('r2')
    // Each snapshot captured its own dialogue array, so the newer success
    // cannot reach into the older one.
    expect(second?.dialogue).toHaveLength(2)
    expect(first?.dialogue).toHaveLength(1)
    expect(second?.dialogue).not.toBe(first?.dialogue)
    expect(second?.dialogue?.slice(0, 1)).toEqual(first?.dialogue)
  })
})
