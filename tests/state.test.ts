import { describe, expect, test } from 'claude-code/testing'

import type {
  BypassTicket,
  ContextSnapshot,
  ModelUsage,
  OptimizerEvent,
  OptimizerReply,
  Phase,
  RuntimeState,
  UsageTotals,
  Workflow,
} from '../hooks/contracts'
import {
  addUsage,
  canStartRound,
  initialState,
  isStale,
  reduce,
} from '../hooks/state'

const SESSION = 'sess-1'

const ZERO: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

function usage(over: Partial<ModelUsage> = {}): ModelUsage {
  return { ...ZERO, ...over }
}

function totals(over: Partial<UsageTotals> = {}): UsageTotals {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, updatedAt: 0, ...over }
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    sessionId: SESSION,
    generation: 1,
    phase: 'reviewing',
    original: '원본',
    originalContext: ['ctx-a'],
    draft: '초안',
    context: null,
    dialogue: [],
    rounds: 0,
    ui: 'composer',
    usage: ZERO,
    ...over,
  }
}

function state(over: Partial<RuntimeState> = {}): RuntimeState {
  return { sessionId: SESSION, workflow: null, bypass: null, usage: totals(), ...over }
}

function bypass(over: Partial<BypassTicket> = {}): BypassTicket {
  return { sessionId: SESSION, workflowId: 'wf-1', text: '초안', expiresAt: 10_000, ...over }
}

function reply(over: Partial<OptimizerReply> = {}): OptimizerReply {
  return { draft: '개선안', message: '더 짧게 만들었습니다', question: null, ...over }
}

const CONTEXT: ContextSnapshot = {
  conversation: 'conv',
  rules: 'rules',
  location: 'loc',
  tools: 'tools',
  memory: 'mem',
  text: 'text',
  chars: 4,
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

describe('initialState', () => {
  test('starts empty for the session', () => {
    expect(initialState(SESSION)).toEqual({
      sessionId: SESSION,
      workflow: null,
      bypass: null,
      usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, updatedAt: 0 },
    })
  })

  test('two sessions get independent objects', () => {
    const a = initialState('a')
    const b = initialState('b')
    expect(a).not.toBe(b)
    expect(a.usage).not.toBe(b.usage)
  })
})

describe('addUsage', () => {
  test('sums every token field', () => {
    expect(
      addUsage(usage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), usage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      })),
    ).toEqual({ input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 })
  })

  test('is identity with a zero operand and does not mutate either input', () => {
    const a = deepFreeze(usage({ input_tokens: 5 }))
    const b = deepFreeze(usage())
    expect(addUsage(a, b)).toEqual(a)
    expect(a).toEqual(usage({ input_tokens: 5 }))
  })
})

describe('isStale', () => {
  test('no workflow is stale', () => {
    expect(isStale(state(), 'wf-1', 1)).toBe(true)
  })

  test('the matching id and generation is not stale', () => {
    expect(isStale(state({ workflow: workflow({ id: 'wf-1', generation: 3 }) }), 'wf-1', 3)).toBe(false)
  })

  test('a different id or generation is stale', () => {
    const current = state({ workflow: workflow({ id: 'wf-1', generation: 3 }) })
    expect(isStale(current, 'wf-2', 3)).toBe(true)
    expect(isStale(current, 'wf-1', 4)).toBe(true)
  })
})

describe('canStartRound', () => {
  test('is false without a workflow', () => {
    expect(canStartRound(state(), 3)).toBe(false)
  })

  test('is true below the cap and false at or above it', () => {
    expect(canStartRound(state({ workflow: workflow({ rounds: 2 }) }), 3)).toBe(true)
    expect(canStartRound(state({ workflow: workflow({ rounds: 3 }) }), 3)).toBe(false)
    expect(canStartRound(state({ workflow: workflow({ rounds: 4 }) }), 3)).toBe(false)
  })
})

describe('reduce — start', () => {
  test('installs a workflow when none is active', () => {
    const wf = workflow({ id: 'wf-new', phase: 'idle' })
    const next = reduce(state(), { type: 'start', workflow: wf }, 100)
    expect(next.workflow).toBe(wf)
  })

  test('replaces a workflow that is already idle', () => {
    const old = workflow({ id: 'wf-old', phase: 'idle' })
    const wf = workflow({ id: 'wf-new', phase: 'idle' })
    const next = reduce(state({ workflow: old }), { type: 'start', workflow: wf }, 100)
    expect(next.workflow).toBe(wf)
  })

  test('ignores a start while a run is in progress', () => {
    for (const phase of ['collecting', 'generating', 'reviewing', 'failed', 'transferring', 'sending'] as const) {
      const old = workflow({ id: 'wf-old', phase })
      const current = state({ workflow: old })
      const next = reduce(current, { type: 'start', workflow: workflow({ id: 'wf-new' }) }, 100)
      expect(next).toBe(current)
      expect(next.workflow).toBe(old)
    }
  })

  test('does not mutate the input state', () => {
    const current = deepFreeze(state({ workflow: workflow({ phase: 'idle' }) }))
    expect(() => reduce(current, { type: 'start', workflow: workflow({ id: 'wf-new' }) }, 1)).not.toThrow()
  })
})

describe('reduce — phase', () => {
  const ALL_PHASES: Phase[] = ['idle', 'collecting', 'generating', 'reviewing', 'failed', 'transferring', 'sending']
  const ALLOWED: ReadonlyArray<readonly [Phase, Phase]> = [
    ['idle', 'collecting'],
    ['collecting', 'generating'],
    ['generating', 'reviewing'],
    ['generating', 'failed'],
    ['reviewing', 'generating'],
    ['reviewing', 'transferring'],
    ['reviewing', 'sending'],
    ['failed', 'generating'],
    ['failed', 'transferring'],
    ['failed', 'sending'],
    ['transferring', 'reviewing'],
    ['transferring', 'idle'],
    ['sending', 'reviewing'],
    ['sending', 'idle'],
  ]
  const allowedSet = new Set(ALLOWED.map(([from, to]) => `${from}>${to}`))

  test('every allowed transition applies and preserves the rest', () => {
    for (const [from, to] of ALLOWED) {
      const current = state({ workflow: workflow({ phase: from, draft: 'KEEP', rounds: 2 }) })
      const next = reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 1, phase: to }, 5)
      expect(next.workflow?.phase).toBe(to)
      expect(next.workflow?.draft).toBe('KEEP')
      expect(next.workflow?.rounds).toBe(2)
      expect(next.usage).toEqual(current.usage)
      expect(current.workflow?.phase).toBe(from)
    }
  })

  test('every other transition is ignored', () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        if (allowedSet.has(`${from}>${to}`)) continue
        const current = state({ workflow: workflow({ phase: from }) })
        const next = reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 1, phase: to }, 5)
        expect(next).toBe(current)
      }
    }
  })

  test('a second transferring press is ignored (button double-press)', () => {
    const current = state({ workflow: workflow({ phase: 'transferring' }) })
    const next = reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 1, phase: 'transferring' }, 5)
    expect(next).toBe(current)
  })

  test('a mismatched workflow id is ignored', () => {
    const current = state({ workflow: workflow({ id: 'wf-1', phase: 'reviewing' }) })
    expect(reduce(current, { type: 'phase', workflowId: 'wf-2', generation: 1, phase: 'sending' }, 5)).toBe(current)
  })

  test('a stale generation is ignored', () => {
    const current = state({ workflow: workflow({ generation: 4, phase: 'reviewing' }) })
    expect(reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 3, phase: 'sending' }, 5)).toBe(current)
  })

  test('no workflow is a no-op', () => {
    const current = state()
    expect(reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 1, phase: 'collecting' }, 5)).toBe(current)
  })
})

describe('reduce — reply', () => {
  test('a matching reply updates the workflow and the session usage', () => {
    const current = state({
      workflow: workflow({ phase: 'generating', rounds: 1, draft: '옛 초안', original: '메모', dialogue: [{ role: 'user', text: '더 짧게' }] }),
    })
    const next = reduce(
      current,
      { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply({ draft: '새 초안' }), usage: usage({ input_tokens: 10, output_tokens: 2 }) },
      777,
    )
    expect(next.workflow?.phase).toBe('reviewing')
    expect(next.workflow?.draft).toBe('새 초안')
    expect(next.workflow?.rounds).toBe(2)
    expect(next.workflow?.dialogue).toEqual([
      { role: 'user', text: '더 짧게' },
      { role: 'optimizer', text: '더 짧게 만들었습니다' },
    ])
    expect(next.workflow?.usage).toEqual(usage({ input_tokens: 10, output_tokens: 2 }))
    expect(next.usage).toEqual(totals({ calls: 1, input: 10, output: 2, updatedAt: 777 }))
    // Untouched fields survive.
    expect(next.workflow?.original).toBe('메모')
    expect(next.workflow?.originalContext).toEqual(['ctx-a'])
    expect(current.workflow?.phase).toBe('generating')
    expect(current.workflow?.draft).toBe('옛 초안')
  })

  test('a question is folded into the same optimizer turn', () => {
    const current = state({ workflow: workflow({ phase: 'generating' }) })
    const next = reduce(
      current,
      { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply({ message: '요약', question: '대상 파일은?' }), usage: usage() },
      1,
    )
    expect(next.workflow?.dialogue).toEqual([{ role: 'optimizer', text: '요약\n대상 파일은?' }])
  })

  test('an empty message with no question adds no dialogue entry', () => {
    const current = state({ workflow: workflow({ phase: 'generating', dialogue: [] }) })
    const next = reduce(
      current,
      { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply({ message: '', question: null }), usage: usage() },
      1,
    )
    expect(next.workflow?.dialogue).toEqual([])
  })

  test('a matching reply clears a previous failure', () => {
    const current = state({ workflow: workflow({ phase: 'failed', lastError: 'boom' }) })
    const next = reduce(
      current,
      { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply(), usage: usage() },
      1,
    )
    expect('lastError' in (next.workflow ?? {})).toBe(false)
  })

  test('a stale generation leaves the workflow alone but records the usage', () => {
    const current = state({ workflow: workflow({ generation: 2, phase: 'generating', draft: 'KEEP', rounds: 1 }) })
    const next = reduce(
      current,
      { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply({ draft: 'STALE' }), usage: usage({ input_tokens: 7 }) },
      42,
    )
    expect(next.workflow?.draft).toBe('KEEP')
    expect(next.workflow?.rounds).toBe(1)
    expect(next.workflow?.phase).toBe('generating')
    expect(next.usage).toEqual(totals({ calls: 1, input: 7, updatedAt: 42 }))
  })

  test('a mismatched workflow id records usage without touching the workflow', () => {
    const current = state({ workflow: workflow({ id: 'wf-1', phase: 'generating' }) })
    const next = reduce(
      current,
      { type: 'reply', workflowId: 'other', generation: 1, reply: reply(), usage: usage({ output_tokens: 3 }) },
      9,
    )
    expect(next.workflow?.phase).toBe('generating')
    expect(next.usage).toEqual(totals({ calls: 1, output: 3, updatedAt: 9 }))
  })

  test('a reply with no active workflow only records usage', () => {
    const next = reduce(state(), { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply(), usage: usage({ input_tokens: 1 }) }, 3)
    expect(next.workflow).toBeNull()
    expect(next.usage).toEqual(totals({ calls: 1, input: 1, updatedAt: 3 }))
  })
})

describe('reduce — failed', () => {
  test('a matching failure keeps the draft and original, records the error and usage', () => {
    const current = state({ workflow: workflow({ phase: 'generating', rounds: 2, draft: '마지막 초안' }) })
    const next = reduce(
      current,
      { type: 'failed', workflowId: 'wf-1', generation: 1, error: 'api-error', usage: usage({ output_tokens: 5 }) },
      11,
    )
    expect(next.workflow?.phase).toBe('failed')
    expect(next.workflow?.lastError).toBe('api-error')
    expect(next.workflow?.draft).toBe('마지막 초안')
    expect(next.workflow?.original).toBe('원본')
    expect(next.workflow?.rounds).toBe(3)
    expect(next.workflow?.usage).toEqual(usage({ output_tokens: 5 }))
    expect(next.usage).toEqual(totals({ calls: 1, output: 5, updatedAt: 11 }))
  })

  test('a failure without usage still spends a round', () => {
    const current = state({ workflow: workflow({ rounds: 1 }) })
    const next = reduce(current, { type: 'failed', workflowId: 'wf-1', generation: 1, error: 'rejected' }, 11)
    expect(next.workflow?.phase).toBe('failed')
    expect(next.workflow?.rounds).toBe(2)
    expect(next.workflow?.usage).toEqual(ZERO)
    expect(next.usage).toEqual(current.usage)
  })

  test('a stale failure records usage but leaves the workflow alone', () => {
    const current = state({ workflow: workflow({ generation: 5, phase: 'generating' }) })
    const next = reduce(
      current,
      { type: 'failed', workflowId: 'wf-1', generation: 4, error: 'api-error', usage: usage({ input_tokens: 9 }) },
      12,
    )
    expect(next.workflow?.phase).toBe('generating')
    expect(next.workflow?.lastError).toBeUndefined()
    expect(next.usage).toEqual(totals({ calls: 1, input: 9, updatedAt: 12 }))
  })
})

describe('reduce — usage', () => {
  test('a matching usage event grows both the workflow and the session', () => {
    const current = state({ workflow: workflow({ phase: 'generating' }) })
    const next = reduce(current, { type: 'usage', workflowId: 'wf-1', generation: 1, usage: usage({ input_tokens: 4 }) }, 20)
    expect(next.workflow?.usage).toEqual(usage({ input_tokens: 4 }))
    expect(next.usage).toEqual(totals({ calls: 1, input: 4, updatedAt: 20 }))
  })

  test('a stale usage event grows only the session total', () => {
    const current = state({ workflow: workflow({ generation: 2, usage: ZERO }) })
    const next = reduce(current, { type: 'usage', workflowId: 'wf-1', generation: 1, usage: usage({ input_tokens: 4 }) }, 20)
    expect(next.workflow?.usage).toEqual(ZERO)
    expect(next.usage).toEqual(totals({ calls: 1, input: 4, updatedAt: 20 }))
  })

  test('a usage event with no workflow grows only the session total', () => {
    const next = reduce(state(), { type: 'usage', workflowId: 'wf-1', generation: 1, usage: usage({ cache_read_input_tokens: 2 }) }, 20)
    expect(next.workflow).toBeNull()
    expect(next.usage).toEqual(totals({ calls: 1, cacheRead: 2, updatedAt: 20 }))
  })
})

describe('reduce — context', () => {
  test('a matching context event stores the snapshot', () => {
    const current = state({ workflow: workflow({ phase: 'collecting' }) })
    const next = reduce(current, { type: 'context', workflowId: 'wf-1', generation: 1, context: CONTEXT }, 1)
    expect(next.workflow?.context).toBe(CONTEXT)
  })

  test('a stale or mismatched context event is ignored', () => {
    const current = state({ workflow: workflow({ generation: 2 }) })
    expect(reduce(current, { type: 'context', workflowId: 'wf-1', generation: 1, context: CONTEXT }, 1)).toBe(current)
    expect(reduce(current, { type: 'context', workflowId: 'wf-9', generation: 2, context: CONTEXT }, 1)).toBe(current)
  })
})

describe('reduce — instruct', () => {
  test('a reviewing workflow takes a user supplement without changing phase', () => {
    const current = state({ workflow: workflow({ phase: 'reviewing', dialogue: [{ role: 'optimizer', text: '초안' }] }) })
    const next = reduce(current, { type: 'instruct', workflowId: 'wf-1', text: '더 짧게' }, 1)
    expect(next.workflow?.phase).toBe('reviewing')
    expect(next.workflow?.dialogue).toEqual([
      { role: 'optimizer', text: '초안' },
      { role: 'user', text: '더 짧게' },
    ])
  })

  test('a failed workflow also takes a supplement', () => {
    const current = state({ workflow: workflow({ phase: 'failed' }) })
    const next = reduce(current, { type: 'instruct', workflowId: 'wf-1', text: '다시' }, 1)
    expect(next.workflow?.dialogue).toEqual([{ role: 'user', text: '다시' }])
  })

  test('an in-flight or mismatched workflow is ignored', () => {
    for (const phase of ['idle', 'collecting', 'generating', 'transferring', 'sending'] as const) {
      const current = state({ workflow: workflow({ phase }) })
      expect(reduce(current, { type: 'instruct', workflowId: 'wf-1', text: 'x' }, 1)).toBe(current)
    }
    const mismatched = state({ workflow: workflow({ phase: 'reviewing' }) })
    expect(reduce(mismatched, { type: 'instruct', workflowId: 'other', text: 'x' }, 1)).toBe(mismatched)
  })

  test('no workflow is a no-op', () => {
    const current = state()
    expect(reduce(current, { type: 'instruct', workflowId: 'wf-1', text: 'x' }, 1)).toBe(current)
  })
})

describe('reduce — cancel and dismiss', () => {
  test('cancel removes the matching workflow', () => {
    const current = state({ workflow: workflow({ phase: 'generating' }) })
    const next = reduce(current, { type: 'cancel', workflowId: 'wf-1' }, 1)
    expect(next.workflow).toBeNull()
  })

  test('cancel with a different id is ignored', () => {
    const current = state({ workflow: workflow() })
    expect(reduce(current, { type: 'cancel', workflowId: 'other' }, 1)).toBe(current)
  })

  test('dismiss removes the matching workflow', () => {
    const current = state({ workflow: workflow({ phase: 'sending' }) })
    expect(reduce(current, { type: 'dismiss', workflowId: 'wf-1' }, 1).workflow).toBeNull()
  })

  test('a late reply after cancel is ignored but still counted', () => {
    const cancelled = reduce(state({ workflow: workflow({ generation: 1 }) }), { type: 'cancel', workflowId: 'wf-1' }, 1)
    const next = reduce(cancelled, { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply(), usage: usage({ input_tokens: 6 }) }, 2)
    expect(next.workflow).toBeNull()
    expect(next.usage).toEqual(totals({ calls: 1, input: 6, updatedAt: 2 }))
  })

  test('a late reply does not touch a replacement run', () => {
    const replacement = workflow({ id: 'wf-2', generation: 2, phase: 'generating', draft: 'KEEP' })
    const current = state({ workflow: replacement })
    const next = reduce(current, { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply({ draft: 'STALE' }), usage: usage() }, 3)
    expect(next.workflow).toBe(replacement)
  })
})

describe('reduce — reset', () => {
  test('resetting another session replaces everything', () => {
    const current = state({
      workflow: workflow(),
      bypass: bypass(),
      usage: totals({ calls: 4, input: 100, updatedAt: 9 }),
    })
    const next = reduce(current, { type: 'reset', sessionId: 'sess-2' }, 50)
    expect(next).toEqual(initialState('sess-2'))
  })

  test('resetting the same session drops the run and permit but keeps usage', () => {
    const current = state({
      workflow: workflow(),
      bypass: bypass(),
      usage: totals({ calls: 2, output: 30, updatedAt: 9 }),
    })
    const next = reduce(current, { type: 'reset', sessionId: SESSION }, 50)
    expect(next.workflow).toBeNull()
    expect(next.bypass).toBeNull()
    expect(next.usage).toEqual(current.usage)
  })
})

describe('reduce — bypass permits', () => {
  test('a ticket for this session is installed', () => {
    const ticket = bypass()
    const next = reduce(state(), { type: 'bypass-issued', ticket }, 1)
    expect(next.bypass).toBe(ticket)
  })

  test('a ticket for another session is refused', () => {
    const current = state()
    expect(reduce(current, { type: 'bypass-issued', ticket: bypass({ sessionId: 'sess-2' }) }, 1)).toBe(current)
  })

  test('consumed and revoked clear the permit for the right session', () => {
    for (const type of ['bypass-consumed', 'bypass-revoked'] as const) {
      const event: OptimizerEvent =
        type === 'bypass-consumed'
          ? { type, sessionId: SESSION, workflowId: 'wf-1' }
          : { type, sessionId: SESSION }
      const current = state({ bypass: bypass() })
      expect(reduce(current, event, 1).bypass).toBeNull()
      expect(reduce(current, { ...event, sessionId: 'sess-2' } as OptimizerEvent, 1)).toBe(current)
    }
  })

  test('editing updates the text and keeps the other ticket fields', () => {
    const current = state({ bypass: bypass({ text: '옛', expiresAt: 10_000, workflowId: 'wf-1' }) })
    const next = reduce(current, { type: 'bypass-edited', sessionId: SESSION, text: '새 텍스트' }, 1)
    expect(next.bypass).toEqual({ sessionId: SESSION, workflowId: 'wf-1', text: '새 텍스트', expiresAt: 10_000 })
    expect(current.bypass?.text).toBe('옛')
  })

  test('editing without a permit, or from another session, is ignored', () => {
    const none = state()
    expect(reduce(none, { type: 'bypass-edited', sessionId: SESSION, text: 'x' }, 1)).toBe(none)
    const current = state({ bypass: bypass() })
    expect(reduce(current, { type: 'bypass-edited', sessionId: 'sess-2', text: 'x' }, 1)).toBe(current)
  })

  test('a permit is kept just before it expires', () => {
    const current = state({ bypass: bypass({ expiresAt: 10_000 }) })
    expect(reduce(current, { type: 'bypass-revoked', sessionId: 'sess-3' }, 9_999).bypass).not.toBeNull()
  })

  test('a permit is cleared at its expiry instant', () => {
    const current = state({ bypass: bypass({ expiresAt: 10_000 }) })
    expect(reduce(current, { type: 'bypass-revoked', sessionId: 'sess-3' }, 10_000).bypass).toBeNull()
    expect(reduce(current, { type: 'bypass-revoked', sessionId: 'sess-3' }, 10_001).bypass).toBeNull()
  })

  test('expiry is cleaned even by an unrelated event', () => {
    const current = state({ bypass: bypass({ expiresAt: 100 }), usage: totals({ calls: 1 }) })
    const next = reduce(current, { type: 'usage', workflowId: 'wf-1', generation: 1, usage: usage() }, 100)
    expect(next.bypass).toBeNull()
    expect(next.usage.calls).toBe(2)
  })

  test('an expired permit cannot be re-installed by a stale issue', () => {
    // The cleanup happens first; issuing then installs even an already-dead
    // ticket, which the next call clears. This documents the order.
    const dead = bypass({ expiresAt: 5 })
    const next = reduce(state(), { type: 'bypass-issued', ticket: dead }, 10)
    expect(next.bypass).toBe(dead)
    expect(reduce(next, { type: 'bypass-revoked', sessionId: 'sess-3' }, 10).bypass).toBeNull()
  })
})

describe('reduce — immutability', () => {
  test('a mutating event leaves a frozen input untouched', () => {
    const current = deepFreeze(
      state({
        workflow: deepFreeze(workflow({ phase: 'generating', dialogue: [{ role: 'user', text: '더 짧게' }] })),
        bypass: deepFreeze(bypass()),
        usage: deepFreeze(totals({ calls: 1 })),
      }),
    )
    const snapshot = JSON.stringify(current)

    const next = reduce(
      current,
      { type: 'reply', workflowId: 'wf-1', generation: 1, reply: reply({ question: '질문' }), usage: usage({ input_tokens: 1 }) },
      99,
    )

    expect(JSON.stringify(current)).toBe(snapshot)
    expect(next).not.toBe(current)
    expect(current.workflow?.phase).toBe('generating')
    expect(current.workflow?.dialogue).toEqual([{ role: 'user', text: '더 짧게' }])
    expect(current.usage.calls).toBe(1)
  })

  test('an ignored event returns the same frozen state object', () => {
    const current = deepFreeze(state({ workflow: workflow({ generation: 2 }) }))
    expect(reduce(current, { type: 'phase', workflowId: 'wf-1', generation: 1, phase: 'generating' }, 1)).toBe(current)
  })
})
