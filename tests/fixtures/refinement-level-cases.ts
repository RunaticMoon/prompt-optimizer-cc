/**
 * Synthetic comparison cases for the refinement-level policies. Data only:
 * `tests/refinement-levels.test.ts` checks fixture integrity, prompt assembly,
 * and the untouched model/config payload. Actual question counts and draft
 * quality need the #37 runner or a separately authorized real-model smoke
 * (`docs/smoke.md` §5); a mock cannot measure them.
 */

import type { RefinementLevel } from '../../hooks/contracts'

/** What the expected policy does about user questions for one case. */
export type QuestionTarget = 'none' | 'at-least-one' | 'optional-only'

/** The narrowest draft scope the case expects. */
export type DraftScope =
  | 'narrow-rename'
  | 'wording-only'
  | 'baseline-question'
  | 'fixed-report'
  | 'investigation-only'
  | 'planning-only'

/** One level's expectation; it is a target, not a measured model result. */
export interface RefinementLevelExpectation {
  readonly questionTarget: QuestionTarget
  readonly draftScope: DraftScope
}

/** One synthetic prompt-comparison case shared by all three levels. */
export interface RefinementLevelCase {
  readonly id: string
  readonly original: string
  readonly context: string
  readonly requiredPreserved: readonly string[]
  readonly forbiddenChanges: readonly string[]
  readonly expected: Readonly<Record<RefinementLevel, RefinementLevelExpectation>>
}

/** Six cases covering the acceptance criteria's decision shapes. */
export const REFINEMENT_LEVEL_CASES: readonly RefinementLevelCase[] = [
  {
    id: 'rename-known-symbol',
    original: '`foo` 함수의 이름을 `bar`로 바꿔줘. 다른 동작은 그대로 둬.',
    context: '저장소에 이름이 foo인 함수는 하나뿐이며, 같은 이름을 쓰는 다른 심볼은 없다.',
    requiredPreserved: ['foo를 bar로 바꾸는 이름 변경', '다른 동작을 바꾸지 않는 범위'],
    forbiddenChanges: ['추가 리팩터링', '새 기능', '불필요한 요구사항 인터뷰'],
    expected: {
      quick: { questionTarget: 'none', draftScope: 'narrow-rename' },
      standard: { questionTarget: 'none', draftScope: 'narrow-rename' },
      deep: { questionTarget: 'none', draftScope: 'narrow-rename' },
    },
  },
  {
    id: 'short-wording-cleanup',
    original: '다음 문장을 한국어로 자연스럽게 다듬어줘: "회의는 내일 오후 3시에 시작합니다."',
    context: '문장의 의미와 언어를 바꾸지 말고, 문장 하나만 다룬다.',
    requiredPreserved: ['한국어', '원래 의미', '문장 하나 범위'],
    forbiddenChanges: ['새 요구사항 추가', '형식·분량 변경', '불필요한 질문'],
    expected: {
      quick: { questionTarget: 'none', draftScope: 'wording-only' },
      standard: { questionTarget: 'none', draftScope: 'wording-only' },
      deep: { questionTarget: 'none', draftScope: 'wording-only' },
    },
  },
  {
    id: 'undefined-comparison-baseline',
    original: '기존 API와 새 API의 응답 차이를 비교해줘.',
    context: '“기존 API”가 직전 배포 응답인지 현재 운영 응답인지 저장소 문서에 정해져 있지 않다.',
    requiredPreserved: ['비교 기준을 미결정으로 유지', '사용자 답변 없이 기준을 확정하지 않음'],
    forbiddenChanges: ['직전·현재·명시 기준 중 하나를 임의 선택', '비교 기준을 합의된 결정으로 기록'],
    expected: {
      quick: { questionTarget: 'at-least-one', draftScope: 'baseline-question' },
      standard: { questionTarget: 'at-least-one', draftScope: 'baseline-question' },
      deep: { questionTarget: 'at-least-one', draftScope: 'baseline-question' },
    },
  },
  {
    id: 'optional-report-format',
    original: '다음 내용으로 보고서를 작성해줘: 배경, 확인한 지표 3개, 결론. 분량은 800자 내외.',
    context: '세 지표와 결론의 내용은 모두 제공됐다. 항목 정렬과 소수점 반올림만 정해지지 않았다.',
    requiredPreserved: ['제공된 세 지표', '800자 내외', '배경·지표·결론 구조'],
    forbiddenChanges: ['제공되지 않은 지표·결론 추가', '정렬·반올림을 합의된 결정으로 확정'],
    expected: {
      quick: { questionTarget: 'none', draftScope: 'fixed-report' },
      standard: { questionTarget: 'none', draftScope: 'fixed-report' },
      deep: { questionTarget: 'optional-only', draftScope: 'fixed-report' },
    },
  },
  {
    id: 'investigate-only',
    original: '왜 `build`가 간헐적으로 실패하는지 원인만 조사해줘. 코드는 수정하지 마.',
    context: '실패 로그와 재현 명령은 저장소에서 확인할 수 있다.',
    requiredPreserved: ['조사만 수행', '코드 수정 금지'],
    forbiddenChanges: ['수정·구현 제안을 실행 요청으로 변경', '원인을 근거 없이 확정'],
    expected: {
      quick: { questionTarget: 'none', draftScope: 'investigation-only' },
      standard: { questionTarget: 'none', draftScope: 'investigation-only' },
      deep: { questionTarget: 'none', draftScope: 'investigation-only' },
    },
  },
  {
    id: 'english-planning-length',
    original:
      'Write a 1200-word implementation plan in English for the migration. Do not write code and do not summarize it as a short answer.',
    context: 'The target is a planning document; the length and language are explicit.',
    requiredPreserved: ['English', '약 1200단어', '계획 문서', '코드 미작성', '요약으로 축소하지 않음'],
    forbiddenChanges: ['한국어로 번역', '코드 구현', '짧은 요약으로 축소'],
    expected: {
      quick: { questionTarget: 'none', draftScope: 'planning-only' },
      standard: { questionTarget: 'none', draftScope: 'planning-only' },
      deep: { questionTarget: 'none', draftScope: 'planning-only' },
    },
  },
]
