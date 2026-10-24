import { describe, expect, test } from 'claude-code/testing'

import type { AnswerSource, DecisionLedger, UserDecision, Workflow } from '../hooks/contracts'
import { display, formatDecisions } from '../hooks/decision-view'

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as const

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    sessionId: 'sess-1',
    generation: 1,
    phase: 'reviewing',
    original: '원본 요청',
    originalContext: [],
    draft: '초안',
    context: null,
    dialogue: [],
    rounds: 1,
    ui: 'pane',
    usage: ZERO_USAGE,
    ...over,
  }
}

function source(over: Partial<AnswerSource> = {}): AnswerSource {
  return {
    kind: 'user-answer',
    questionId: 'q:wf-1:1:1',
    question: '대상 독자는?',
    options: ['경영진', '개발팀'],
    answeredAfterRound: 1,
    ...over,
  }
}

function entry(over: Partial<UserDecision> = {}): UserDecision {
  return { id: 'd1', text: '경영진', source: source(), ...over }
}

function ledger(entries: readonly UserDecision[]): DecisionLedger {
  return { entries, nextId: entries.length + 1 }
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

describe('formatDecisions', () => {
  test('names the invariant original and its warning even with no answers', () => {
    const text = formatDecisions(workflow({ decisions: ledger([]) }))
    expect(text).toContain('확정된 사용자 결정:')
    expect(text).toContain('원문: 사용자 원문 · 항상 적용되며 정정 id 대상이 아닙니다.')
    expect(text).toContain('아직 기록된 사용자 답변이 없습니다.')
    expect(text).toContain('초안·변경 메모·모델 추천은 확정된 사용자 결정이 아닙니다.')
    expect(text).toContain('정정: /optimize correct <id> <내용> 후 /optimize retry')
    // A fixture without a ledger reads the same as an empty one.
    expect(formatDecisions(workflow())).toContain('아직 기록된 사용자 답변이 없습니다.')
  })

  test('shows the id, source, question, numbered choices, raw answer and resolved choice', () => {
    const text = formatDecisions(workflow({
      decisions: ledger([entry({ selectedOption: { index: 1, text: '경영진' } })]),
    }))
    expect(text).toContain('- d1 · 활성')
    expect(text).toContain('출처: 사용자 답변 · 질문 q:wf-1:1:1 · 답변 시점 1라운드')
    expect(text).toContain('질문: 대상 독자는?')
    expect(text).toContain('선택지: 1) 경영진 / 2) 개발팀')
    expect(text).toContain('답변: 경영진')
    expect(text).toContain('선택: 1) 경영진')
    // No id the person cannot use.
    expect(text).not.toContain('d0')
  })

  test('shows replaced history with both replacement pointers', () => {
    const first = entry()
    const second = entry({ id: 'd2', text: '로컬에서만 처리', source: first.source, supersedes: 'd1' })
    const text = formatDecisions(workflow({ decisions: ledger([first, second]) }))
    expect(text).toContain('- d1 · 대체됨 → d2')
    expect(text).toContain('- d2 · 활성')
    expect(text).toContain('이전 결정 대체: d1')
    expect(text).toContain('답변: 로컬에서만 처리')
  })

  test('an answer without a question reports a plain user-answer source', () => {
    const text = formatDecisions(workflow({
      decisions: ledger([entry({ source: source({ questionId: null, question: null, options: [] }) })]),
    }))
    expect(text).toContain('출처: 사용자 답변 · 답변 시점 1라운드')
    expect(text).not.toContain('질문:')
    expect(text).not.toContain('선택지:')
  })

  test('control characters are displayed safely without altering stored text', () => {
    const decision = deepFreeze(entry({
      text: '첫 줄\n둘째\t줄\u0000끝',
      source: source({ question: '질문\n줄' }),
    }))
    const text = formatDecisions(workflow({ decisions: ledger([decision]) }))
    expect(text).toContain('답변: 첫 줄\\n둘째\\t줄\\u0000끝')
    expect(text).toContain('질문: 질문\\n줄')
    // The stored values are untouched.
    expect(decision.text).toBe('첫 줄\n둘째\t줄\u0000끝')
    expect(decision.source.question).toBe('질문\n줄')
    // The display still has structural newlines only where the formatter put them.
    expect(text.split('\n').filter(line => line.trim().startsWith('답변:'))).toHaveLength(1)
  })

  test('display keeps ordinary text and escapes only controls', () => {
    expect(display('그대로 😀 <tag>')).toBe('그대로 😀 <tag>')
    expect(display('a\rb\nc\td')).toBe('a\\rb\\nc\\td')
    expect(display('\u007f\u0085')).toBe('\\u007f\\u0085')
  })

  test('formatting does not mutate a frozen workflow', () => {
    const frozen = deepFreeze(workflow({ decisions: ledger([entry()]) }))
    const before = JSON.stringify(frozen)
    formatDecisions(frozen)
    expect(JSON.stringify(frozen)).toBe(before)
  })
})
