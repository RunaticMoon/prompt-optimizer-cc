/**
 * Pure label rendering for the last classified composer submission (#35).
 *
 * `/optimize status` shows what the classifier decided for the most recent
 * composer submission and why it decided that, without any of the submission's
 * text: the labels below render the stored {@link SubmissionStatus} metadata
 * only. This module imports contract types, never the controller, and reads
 * nothing but its argument.
 *
 * The wording stays `최적화 대상` even when a later scheduling step fails: the
 * status describes the classifier's decision, not a successful send.
 */

import type { CompositionReason, PassReason, PasteClassification, SubmissionStatus } from './contracts'

/** The decision half of a `pass` submission, by reason. */
const PASS_LABELS: Record<PassReason, string> = {
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
  'smart-continuation': '원문 통과 (명확한 승인·이어가기)',
  'already-optimized': '원문 통과 (이미 다듬은 개선안)',
}

/** How the draft was built, for every reason the composition classifier reports. */
const COMPOSITION_LABELS: Record<Exclude<CompositionReason, 'history'>, string> = {
  typed: '직접 입력',
  'paste-placeholder': '붙여넣기 자리표시',
  'keyless-long-insert': '키 없는 긴 삽입',
  'no-input-events': '입력 이벤트 없음',
  'observed-other': '입력 관찰 (직접 입력·붙여넣기 신호 없음)',
}

/** The decision label for one stored submission, per its kind. */
function decisionLabel(status: Readonly<SubmissionStatus>): string {
  if (status.kind === 'pass') {
    return status.passReason === undefined ? '원문 통과' : PASS_LABELS[status.passReason]
  }
  switch (status.kind) {
    case 'optimize':
      return status.trigger === undefined ? '최적화 대상' : `최적화 대상 (${status.trigger})`
    case 'reply':
      return '보완 답변'
    case 'busy':
      return '진행 중 작업 우선'
    case 'raw':
      return '원문 우회'
    case 'bypass':
      return '복원 초안 우회'
  }
}

/** The 입력 half of the line: how the draft was built, or `history`'s base verdict. */
function compositionLabel(c: PasteClassification): string {
  if (c.reason !== 'history') return COMPOSITION_LABELS[c.reason]
  const previous = c.previousReason === undefined ? undefined : COMPOSITION_LABELS[c.previousReason]
  return previous === undefined ? '기록의 기존 판정' : `기록의 기존 판정 (${previous})`
}

/**
 * Renders the `최근 제출 분류` line(s) for `/optimize status`.
 *
 * Without a stored submission (never classified yet, a session start/end, a
 * classification failure, or a controller from before the diagnostic) the line
 * reads `없음`. A pass the person would likely want optimized anyway — a pasted
 * draft, or a smart-mode approval reply — adds the one-line recovery route, so
 * the person can optimize this input explicitly without the plugin storing or
 * repeating its text; a prefix trigger or an active dialogue that overrode the
 * paste does not get the route, since the paste is not what decided those.
 *
 * @param submission the controller's stored diagnostic, when it has one
 * @returns one line, plus the recovery line for a passed-through approval
 */
export function formatSubmissionStatus(submission: Readonly<SubmissionStatus> | null | undefined): string {
  if (submission === null || submission === undefined) return '최근 제출 분류: 없음'
  const input = submission.composition === undefined
    ? '미확인'
    : compositionLabel(submission.composition)
  const lines = [`최근 제출 분류: ${decisionLabel(submission)} · 입력: ${input}`]
  if (
    submission.kind === 'pass'
    && (submission.passReason === 'pasted'
      || submission.passReason === 'smart-continuation'
      || submission.passReason === 'already-optimized')
  ) {
    lines.push('직접 최적화: /optimize -- <원문>')
  }
  return lines.join('\n')
}
