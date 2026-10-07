import type { Workflow } from '../contracts'

const FRAMES = ['◐', '◓', '◑', '◒'] as const
const STAGES = {
  context: '대화·프로젝트 맥락 확인 중',
  instructions: '최적화 지침 읽는 중',
  'target-model': '대상 모델 확인 중',
  generating: '개선안 생성 중',
} as const

/** Use observed time only; a spinner is activity, never a completion estimate. */
export function progressText(workflow: Workflow): string | undefined {
  if (workflow.phase === 'reviewing' || workflow.phase === 'failed') return undefined
  if (workflow.phase === 'transferring') return '◐ 입력창으로 전달 중'
  if (workflow.phase === 'sending') return '◐ 프롬프트 전송 중'
  const progress = workflow.progress
  if (!progress) return `◐ ${workflow.phase === 'generating' ? STAGES.generating : '개선 준비 중'}`
  const seconds = Math.floor(Math.max(0, progress.updatedAt - progress.startedAt) / 1000)
  const elapsed = seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
  return `${FRAMES[seconds % FRAMES.length]} ${elapsed} · ${STAGES[progress.stage]}`
}

/** The completion API reports usage after a response, not while generating. */
export function tokenUsageText(workflow: Workflow): string {
  const tokens = Object.values(workflow.usage).reduce((sum, count) => sum + count, 0)
  return `완료 누적 ${tokens}토큰`
}
