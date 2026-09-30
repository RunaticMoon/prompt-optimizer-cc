import type { RuntimeState, Workflow } from '../contracts'
import { PANE_ID } from '../controller'
import type { UiPorts } from './ui-ports'

export const COMPOSER_GUIDE =
  '보완 내용을 입력해 Enter · /optimize accept(입력창으로) · /optimize send · /optimize raw · /optimize cancel'

const phaseText: Record<Workflow['phase'], string> = {
  idle: '대기',
  collecting: '수집 중',
  generating: '생성 중',
  reviewing: '검토',
  failed: '실패',
  transferring: '전달 중',
  sending: '전송 중',
}

export function phaseLabel(phase: Workflow['phase']): string {
  return phaseText[phase]
}

/** Tracks published content per workflow so redraws never duplicate transcript lines. */
export function createPresenter(): {
  present(ui: UiPorts, state: Readonly<RuntimeState>, notice?: string): void
} {
  let activeId: string | undefined
  let lastDraft = ''
  let lastMessage = ''
  let lastError = ''
  let lastNotice = ''
  let hadStatus = false
  let lastWorkflowUi: Workflow['ui'] | undefined

  return {
    present(ui, state, notice) {
      const workflow = state.workflow
      if (!workflow) {
        const closedPane = lastWorkflowUi === 'pane'
        lastWorkflowUi = undefined
        if (closedPane) {
          try {
            void ui.close(PANE_ID).catch(() => undefined)
          } catch {
            // The pane may already have been closed by delivery or the user.
          }
          ui.invalidate()
        }
        if (hadStatus) ui.status(undefined)
        activeId = undefined
        lastDraft = ''
        lastMessage = ''
        lastError = ''
        lastNotice = ''
        hadStatus = false
        if (notice) ui.toast(notice)
        return
      }

      lastWorkflowUi = workflow.ui

      if (activeId !== workflow.id) {
        activeId = workflow.id
        lastDraft = ''
        lastMessage = ''
        lastError = ''
        lastNotice = ''
      }

      if (workflow.ui === 'pane') {
        if (hadStatus) ui.status(undefined)
        hadStatus = false
        ui.invalidate()
        if (notice) ui.toast(notice)
        return
      }

      ui.status(`옵티마이저 ${phaseLabel(workflow.phase)} (${workflow.rounds}회) · ${COMPOSER_GUIDE}`)
      hadStatus = true

      const message = [...workflow.dialogue].reverse().find((item) => item.role === 'optimizer')?.text ?? ''
      if (message && message !== lastMessage) {
        ui.log(`옵티마이저: ${message}`)
        lastMessage = message
      }
      if (workflow.draft && workflow.draft !== lastDraft) {
        ui.log(`개선안:\n${workflow.draft}`)
        lastDraft = workflow.draft
      }
      if (workflow.lastError && workflow.lastError !== lastError) {
        ui.log(`옵티마이저 오류: ${workflow.lastError}`)
        lastError = workflow.lastError
      }
      if (notice && notice !== lastNotice) {
        ui.log(notice)
        lastNotice = notice
      }
    },
  }
}
