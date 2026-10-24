import type { ModelCompleteRequest } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type {
  ContextSnapshot,
  ModelUsage,
  OptimizerConfig,
  RefinementLevel,
  Workflow,
} from '../hooks/contracts'
import { DEFAULT_CONFIG } from '../hooks/contracts'
import { buildModelRequest, parseReply, requestText } from '../hooks/model'
import { initialState, reduce } from '../hooks/state'
import { composeSystemPrompt } from '../hooks/system-prompt'
import { DEEP_SYSTEM_PROMPT } from './fixtures/deep-system-prompt'
import { REFINEMENT_LEVEL_CASES } from './fixtures/refinement-level-cases'

const LEVELS: readonly RefinementLevel[] = ['quick', 'standard', 'deep']

const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

function config(over: Partial<OptimizerConfig> = {}): OptimizerConfig {
  return { ...DEFAULT_CONFIG, ...over }
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-level',
    sessionId: 'sess-level',
    generation: 1,
    phase: 'reviewing',
    original: '원문',
    originalContext: [],
    draft: '',
    context: null,
    dialogue: [],
    rounds: 0,
    ui: 'pane',
    usage: ZERO_USAGE,
    ...over,
  }
}

function snapshot(text: string): ContextSnapshot {
  return {
    conversation: '',
    rules: '',
    location: '',
    tools: '',
    text,
    chars: text.length,
  }
}

/** One request per level for the same synthetic original and context. */
function requestsFor(original: string, context: string): Record<RefinementLevel, ModelCompleteRequest> {
  const built = {} as Record<RefinementLevel, ModelCompleteRequest>
  for (const level of LEVELS) {
    const system = composeSystemPrompt('', 'common', level)
    built[level] = buildModelRequest(
      workflow({ original, context: snapshot(context) }),
      config({ refinementLevel: level }),
      system,
    )
  }
  return built
}

describe('refinement level comparison fixtures', () => {
  test('cover the six required decision shapes with unique ids', () => {
    expect(REFINEMENT_LEVEL_CASES.map(c => c.id)).toEqual([
      'rename-known-symbol',
      'short-wording-cleanup',
      'undefined-comparison-baseline',
      'optional-report-format',
      'investigate-only',
      'english-planning-length',
    ])
    expect(new Set(REFINEMENT_LEVEL_CASES.map(c => c.id)).size).toBe(REFINEMENT_LEVEL_CASES.length)
  })

  test('each case is synthetic, non-empty, and defines every level expectation', () => {
    for (const c of REFINEMENT_LEVEL_CASES) {
      expect(c.original.trim()).not.toBe('')
      expect(c.context.trim()).not.toBe('')
      expect(c.requiredPreserved.length).toBeGreaterThan(0)
      expect(c.forbiddenChanges.length).toBeGreaterThan(0)
      expect(Object.keys(c.expected).sort()).toEqual([...LEVELS].sort())
      for (const level of LEVELS) {
        expect(['none', 'at-least-one', 'optional-only']).toContain(c.expected[level].questionTarget)
        expect(c.expected[level].draftScope).not.toBe('')
      }
    }
  })

  test('a missing comparison baseline is a question at every level, including quick', () => {
    const c = REFINEMENT_LEVEL_CASES.find(entry => entry.id === 'undefined-comparison-baseline')!
    for (const level of LEVELS) {
      expect(c.expected[level]).toEqual({ questionTarget: 'at-least-one', draftScope: 'baseline-question' })
    }
    expect(c.forbiddenChanges).toContain('직전·현재·명시 기준 중 하나를 임의 선택')
  })

  test('optional report format is never a quick/standard question and stays optional for deep', () => {
    const c = REFINEMENT_LEVEL_CASES.find(entry => entry.id === 'optional-report-format')!
    expect(c.expected.quick.questionTarget).toBe('none')
    expect(c.expected.standard.questionTarget).toBe('none')
    expect(c.expected.deep.questionTarget).toBe('optional-only')
    expect(c.requiredPreserved).toContain('800자 내외')
  })

  test('clear rename, wording, investigation and planning cases expect no interview', () => {
    for (const id of [
      'rename-known-symbol',
      'short-wording-cleanup',
      'investigate-only',
      'english-planning-length',
    ]) {
      const c = REFINEMENT_LEVEL_CASES.find(entry => entry.id === id)!
      for (const level of LEVELS) expect(c.expected[level].questionTarget).toBe('none')
    }
    const investigation = REFINEMENT_LEVEL_CASES.find(entry => entry.id === 'investigate-only')!
    expect(investigation.requiredPreserved).toContain('코드 수정 금지')
    const planning = REFINEMENT_LEVEL_CASES.find(entry => entry.id === 'english-planning-length')!
    expect(planning.requiredPreserved).toEqual(
      expect.arrayContaining(['English', '약 1200단어', '코드 미작성']),
    )
  })

  test('only the system policy differs; original, context, model, and caps stay the same', () => {
    for (const c of REFINEMENT_LEVEL_CASES) {
      const built = requestsFor(c.original, c.context)
      const prompts = LEVELS.map(level => requestText(built[level].prompt))
      const systems = LEVELS.map(level => requestText(built[level].system))

      expect(new Set(prompts).size).toBe(1)
      expect(prompts[0]).toContain(c.original)
      expect(prompts[0]).toContain(c.context)
      expect(new Set(systems).size).toBe(LEVELS.length)
      expect(systems[0]).toContain('[보완 수준: quick]')
      expect(systems[1]).toContain('[보완 수준: standard]')
      expect(systems[2]).toBe(DEEP_SYSTEM_PROMPT)

      for (const level of LEVELS) {
        expect(built[level].model).toBe(built.deep.model)
        expect(built[level].maxTokens).toBe(built.deep.maxTokens)
        expect(built[level].timeoutMs).toBe(built.deep.timeoutMs)
        expect(built[level].effort).toBe(built.deep.effort)
        expect(requestText(built[level].prompt)).toContain('max: 5')
      }
    }
  })

  test('deep keeps the captured byte-for-byte baseline', () => {
    expect(composeSystemPrompt('', 'common', 'deep')).toBe(DEEP_SYSTEM_PROMPT)
    expect(composeSystemPrompt('', 'common')).toBe(DEEP_SYSTEM_PROMPT)
  })

  test('mocked null and unresolved replies retain the draft for the accept path', () => {
    const replied = (question: string | null) =>
      parseReply(JSON.stringify({ draft: '보존할 개선안', message: '설명', question }))
    const closed = replied(null)
    const open = replied('비교 기준은 무엇인가요?')
    expect(closed.ok).toBe(true)
    expect(open.ok).toBe(true)
    if (!closed.ok || !open.ok) return

    const started = reduce(
      initialState('sess-level'),
      { type: 'start', workflow: workflow({ phase: 'generating', rounds: 0 }) },
      0,
    )
    const afterClosed = reduce(
      started,
      { type: 'reply', workflowId: 'wf-level', generation: 1, reply: closed.reply, usage: ZERO_USAGE },
      0,
    )
    expect(afterClosed.workflow?.draft).toBe('보존할 개선안')
    expect(afterClosed.workflow?.question).toBeNull()
    expect(afterClosed.workflow?.options).toEqual([])

    const afterOpen = reduce(
      started,
      { type: 'reply', workflowId: 'wf-level', generation: 1, reply: open.reply, usage: ZERO_USAGE },
      0,
    )
    expect(afterOpen.workflow?.draft).toBe('보존할 개선안')
    expect(afterOpen.workflow?.question).toBe('비교 기준은 무엇인가요?')
    expect(afterOpen.workflow?.options).toEqual([])
    // The controller's accept path fills this retained draft; 30-3's controller
    // tests assert the fill and the absence of an automatic submit.
  })
})
