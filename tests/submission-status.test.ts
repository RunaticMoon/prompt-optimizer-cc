import { describe, expect, test } from 'claude-code/testing'

import type { PassReason, PasteClassification, SubmissionStatus } from '../hooks/contracts'
import { formatSubmissionStatus } from '../hooks/submission-status'

/** One stored submission, with the composition filled in unless overridden. */
function status(over: Partial<SubmissionStatus> & { composition?: PasteClassification }): SubmissionStatus {
  return {
    kind: 'pass',
    passReason: 'pasted',
    composition: { pasted: true, reason: 'keyless-long-insert' },
    ...over,
  }
}

describe('formatSubmissionStatus', () => {
  test('no diagnostic, or a legacy controller without one, reads as none', () => {
    expect(formatSubmissionStatus(null)).toBe('최근 제출 분류: 없음')
    expect(formatSubmissionStatus(undefined)).toBe('최근 제출 분류: 없음')
  })

  test('a stored pasted pass shows its reason, input source and the recovery route', () => {
    const text = formatSubmissionStatus(status({}))
    expect(text).toContain('최근 제출 분류: 원문 통과 (붙여넣기 추정) · 입력: 키 없는 긴 삽입')
    expect(text).toContain('직접 최적화: /optimize -- <원문>')
  })

  test('every pass reason renders its own label', () => {
    const labels: Record<PassReason, string> = {
      disabled: '원문 통과 (꺼짐)',
      'not-composer': '원문 통과 (외부 제출)',
      empty: '원문 통과 (빈 입력)',
      attachments: '원문 통과 (첨부)',
      'mid-turn': '원문 통과 (턴 실행 중)',
      queued: '원문 통과 (대기 제출)',
      'slash-command': '원문 통과 (명령)',
      shell: '원문 통과 (셸)',
      'over-limit': '원문 통과 (길이 한도)',
      'no-trigger': '원문 통과 (접두어 없음)',
      pasted: '원문 통과 (붙여넣기 추정)',
    }
    for (const [reason, label] of Object.entries(labels) as Array<[PassReason, string]>) {
      const text = formatSubmissionStatus(status({ passReason: reason }))
      expect(text).toContain(`최근 제출 분류: ${label} · 입력: `)
    }
  })

  test('every composition reason renders its own input label', () => {
    const labels: Array<[PasteClassification, string]> = [
      [{ pasted: false, reason: 'typed' }, '직접 입력'],
      [{ pasted: true, reason: 'paste-placeholder' }, '붙여넣기 자리표시'],
      [{ pasted: true, reason: 'keyless-long-insert' }, '키 없는 긴 삽입'],
      [{ pasted: true, reason: 'no-input-events' }, '입력 이벤트 없음'],
      [{ pasted: false, reason: 'observed-other' }, '입력 관찰 (직접 입력·붙여넣기 신호 없음)'],
    ]
    for (const [composition, label] of labels) {
      expect(formatSubmissionStatus(status({ composition }))).toContain(`· 입력: ${label}`)
    }
  })

  test('a history composition names the base verdict it reuses', () => {
    const text = formatSubmissionStatus(
      status({ composition: { pasted: false, reason: 'history', previousReason: 'typed' } }),
    )
    expect(text).toContain('· 입력: 기록의 기존 판정 (직접 입력)')
  })

  test('each non-pass decision kind renders its own label and trigger', () => {
    expect(formatSubmissionStatus(status({ kind: 'optimize', trigger: 'auto' }))).toContain(
      '최근 제출 분류: 최적화 대상 (auto) · 입력: ',
    )
    expect(formatSubmissionStatus(status({ kind: 'optimize', trigger: 'prefix' }))).toContain(
      '최근 제출 분류: 최적화 대상 (prefix) · 입력: ',
    )
    expect(formatSubmissionStatus(status({ kind: 'reply' }))).toContain('최근 제출 분류: 보완 답변 · 입력: ')
    expect(formatSubmissionStatus(status({ kind: 'busy' }))).toContain('최근 제출 분류: 진행 중 작업 우선 · 입력: ')
    expect(formatSubmissionStatus(status({ kind: 'raw' }))).toContain('최근 제출 분류: 원문 우회 · 입력: ')
    expect(formatSubmissionStatus(status({ kind: 'bypass' }))).toContain('최근 제출 분류: 복원 초안 우회 · 입력: ')
  })

  test('a submission without composition metadata reads as unconfirmed input', () => {
    const text = formatSubmissionStatus(status({ composition: undefined }))
    expect(text).toBe('최근 제출 분류: 원문 통과 (붙여넣기 추정) · 입력: 미확인\n직접 최적화: /optimize -- <원문>')
  })

  test('the recovery route appears only for a pasted pass, not an overridden paste', () => {
    // A prefix trigger that beat the paste fact optimizes anyway: no route.
    const prefix = formatSubmissionStatus(
      status({ kind: 'optimize', trigger: 'prefix', composition: { pasted: true, reason: 'keyless-long-insert' } }),
    )
    expect(prefix).toContain('최적화 대상 (prefix)')
    expect(prefix).not.toContain('/optimize --')

    // An active reply over a pasted draft is a reply: no route either.
    const reply = formatSubmissionStatus(
      status({ kind: 'reply', composition: { pasted: true, reason: 'paste-placeholder' } }),
    )
    expect(reply).toContain('보완 답변')
    expect(reply).not.toContain('/optimize --')

    // A non-pasted pass gets no route.
    expect(formatSubmissionStatus(status({ passReason: 'empty' }))).not.toContain('/optimize --')
  })

  test('the rendering never carries a prompt substring', () => {
    const text = formatSubmissionStatus(status({}))
    expect(text).not.toContain('붙여넣은 여러 줄 텍스트')
    expect(text).not.toContain('[Pasted text #1')
  })
})
