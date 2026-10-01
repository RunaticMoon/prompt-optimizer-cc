import type { PaneOpenArgs, UiOpenResult } from 'claude-code'

import { PANE_ID } from '../controller'

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
    // Inline pane: header/hint (2), primary action (2 with spacing), refinement
    // label/input (3), send actions (2), and message start (3). Longer messages
    // and the original toggle remain scrollable, leaving room for AbovePrompt.
    rows: 12,
  }
}
