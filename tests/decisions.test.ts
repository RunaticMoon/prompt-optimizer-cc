import { describe, expect, test } from 'claude-code/testing'

import type { AnswerSource, DecisionLedger, UserDecision } from '../hooks/contracts'
import {
  activeDecisions,
  appendAnswer,
  appendCorrection,
  decisionIdFor,
  emptyLedger,
  findDecision,
  isActiveDecision,
  ledgerOf,
  questionIdFor,
  resolveOption,
  supersededBy,
} from '../hooks/decisions'

function source(over: Partial<AnswerSource> = {}): AnswerSource {
  return {
    kind: 'user-answer',
    questionId: 'q:wf-1:0:1',
    question: '어느 쪽인가요?',
    options: ['변화 이력의 직전 값', '배포 기준'],
    answeredAfterRound: 1,
    ...over,
  }
}

function decision(over: Partial<UserDecision> = {}): UserDecision {
  return {
    id: 'd1',
    text: '변화 이력의 직전 값',
    source: source(),
    ...over,
  }
}

function ledger(entries: readonly UserDecision[], nextId = entries.length + 1): DecisionLedger {
  return { entries, nextId }
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

describe('emptyLedger and ledgerOf', () => {
  test('starts with no entries and the first id', () => {
    expect(emptyLedger()).toEqual({ entries: [], nextId: 1 })
    expect(decisionIdFor(1)).toBe('d1')
  })

  test('a workflow without a ledger reads as empty without being changed', () => {
    const workflow = { decisions: undefined }
    expect(ledgerOf(workflow as never).entries).toEqual([])
    expect(ledgerOf(null).entries).toEqual([])
    expect(workflow.decisions).toBeUndefined()
  })
})

describe('questionIdFor', () => {
  test('is unique per workflow, generation and attempt', () => {
    const first = questionIdFor('wf-1', 0, 1)
    expect(first).toBe('q:wf-1:0:1')
    expect(questionIdFor('wf-1', 0, 2)).not.toBe(first)
    expect(questionIdFor('wf-1', 1, 1)).not.toBe(first)
    expect(questionIdFor('wf-2', 0, 1)).not.toBe(first)
  })
})

describe('resolveOption', () => {
  test('resolves a bare offered number, with or without 번', () => {
    expect(resolveOption('1', ['A', 'B'])).toEqual({ index: 1, text: 'A' })
    expect(resolveOption('2번', ['A', 'B'])).toEqual({ index: 2, text: 'B' })
    expect(resolveOption(' 1번 ', ['A', 'B'])).toEqual({ index: 1, text: 'A' })
  })

  test('resolves an exact option text, including one that looks numeric', () => {
    expect(resolveOption('B', ['A', 'B'])).toEqual({ index: 2, text: 'B' })
    expect(resolveOption('3번', ['1번', '2번', '3번'])).toEqual({ index: 3, text: '3번' })
  })

  test('does not normalize an out-of-range, ambiguous or prose answer', () => {
    expect(resolveOption('3', ['A', 'B'])).toBeUndefined()
    expect(resolveOption('5번', ['A', 'B'])).toBeUndefined()
    expect(resolveOption('the former', ['A', 'B'])).toBeUndefined()
    expect(resolveOption('1, 2', ['A', 'B'])).toBeUndefined()
    expect(resolveOption('첫 번째', ['A', 'B'])).toBeUndefined()
    expect(resolveOption('', ['A', 'B'])).toBeUndefined()
    // A numeric answer with no offered choices is not a choice.
    expect(resolveOption('1번', [])).toBeUndefined()
  })
})

describe('appendAnswer', () => {
  test('mints the next id, keeps the raw text and records the resolved choice', () => {
    const base = ledger([])
    const { ledger: next, decision } = appendAnswer(base, '2번', source())
    expect(decision.id).toBe('d1')
    expect(decision.text).toBe('2번')
    expect(decision.selectedOption).toEqual({ index: 2, text: '배포 기준' })
    expect(next.entries).toEqual([decision])
    expect(next.nextId).toBe(2)
    // The input ledger is unchanged.
    expect(base).toEqual({ entries: [], nextId: 1 })
  })

  test('keeps free-text uncertainty verbatim and unresolved', () => {
    const uncertainty = '잘 모르겠어요. 아마 배포 기준일 수도 있습니다.'
    const { decision } = appendAnswer(ledger([]), uncertainty, source())
    expect(decision.text).toBe(uncertainty)
    expect(decision.selectedOption).toBeUndefined()
  })

  test('does not mutate a frozen ledger or its source arrays', () => {
    const base = deepFreeze(ledger([decision({ source: source() })]))
    const { ledger: next } = appendAnswer(base, '1번', source())
    expect(next.entries).toHaveLength(2)
    expect(next.entries[0]).toBe(base.entries[0])
    expect(base.entries).toHaveLength(1)
  })
})

describe('supersession and active decisions', () => {
  test('an explicit correction replaces the target in the active set but keeps history', () => {
    const base = ledger([decision({ id: 'd1' })])
    const corrected = appendCorrection(base, base.entries[0] as UserDecision, '배포 기준')
    expect(corrected.decision.id).toBe('d2')
    expect(corrected.decision.supersedes).toBe('d1')
    expect(corrected.decision.source).toBe(base.entries[0]?.source)
    expect(corrected.ledger.entries.map(entry => entry.id)).toEqual(['d1', 'd2'])

    expect(activeDecisions(corrected.ledger).map(entry => entry.id)).toEqual(['d2'])
    expect(supersededBy(corrected.ledger).get('d1')).toBe('d2')
    expect(isActiveDecision(corrected.ledger, 'd1')).toBe(false)
    expect(isActiveDecision(corrected.ledger, 'd2')).toBe(true)
    expect(isActiveDecision(corrected.ledger, 'd9')).toBe(false)
  })

  test('a correction chain applies only the newest entry', () => {
    const base = ledger([decision({ id: 'd1' })])
    const second = appendCorrection(base, base.entries[0] as UserDecision, '두 번째')
    const third = appendCorrection(
      second.ledger,
      second.ledger.entries[1] as UserDecision,
      '세 번째',
    )
    expect(activeDecisions(third.ledger).map(entry => entry.id)).toEqual(['d3'])
    expect(findDecision(third.ledger, 'd1')?.text).toBe('변화 이력의 직전 값')
    expect(findDecision(third.ledger, 'd2')?.supersedes).toBe('d1')
  })

  test('unrelated decisions stay active through a correction', () => {
    const first = appendAnswer(ledger([]), '로컬에서만 처리', source({
      questionId: 'q:wf-1:0:1', question: '처리 위치는?', options: [],
    })).ledger
    const second = appendAnswer(first, '파일 이름 유지', source({
      questionId: 'q:wf-1:0:2', question: '파일 이름은?', options: [],
    })).ledger
    const corrected = appendCorrection(second, second.entries[0] as UserDecision, '서버에서 처리')
    expect(activeDecisions(corrected.ledger).map(entry => entry.id)).toEqual(['d2', 'd3'])
  })
})
