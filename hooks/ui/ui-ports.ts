import type { PaneOpenArgs, UiOpenResult } from 'claude-code'

import { PANE_ID } from '../controller'

export const PANE_ROWS = 12

/** The small UI boundary used by the controller's change presenter. */
export interface UiPorts {
  open(args: PaneOpenArgs): Promise<UiOpenResult>
  close(id: string): Promise<void>
  invalidate(): void
  status(text: string | undefined): void
  log(text: string): void
  toast(text: string): void
}

export function paneOpenArgs(): PaneOpenArgs {
  return {
    id: PANE_ID,
    title: '프롬프트 옵티마이저',
    focus: true,
    closeOnEscape: true,
    // Large inline and dock layouts request twelve rows. Compact inline panes
    // reserve their first view for the draft preview and controls; details scroll.
    rows: PANE_ROWS,
  }
}
