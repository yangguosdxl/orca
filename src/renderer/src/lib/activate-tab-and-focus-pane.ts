import { useAppStore } from '@/store'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'

/** Activate `tabId` and (optionally) focus a specific pane inside it. The
 *  caller passes the pane's stablePaneId (an opaque UUID) — the focus
 *  listener resolves it back to a numeric handle through the manager so the
 *  dispatch survives renderer-reload renumbers. Pass `null` for stablePaneId
 *  to activate the tab without targeting a specific pane (e.g. status-bar
 *  rows whose paneKey doesn't carry a UUID suffix).
 *
 *  `opts.ackPaneKeyOnSuccess` is the paneKey to ack on focus-success — the
 *  focus listener calls acknowledgeAgents only when setActivePane resolves
 *  to a real pane, so a stale row doesn't get acked silently. Used by the
 *  sidebar inline agent rows.
 */
export function activateTabAndFocusPane(
  tabId: string,
  stablePaneId: string | null,
  opts?: { ackPaneKeyOnSuccess?: string }
): void {
  useAppStore.getState().setActiveTab(tabId)
  if (stablePaneId === null) {
    return
  }
  // Why: defer one frame so the new TerminalPane has mounted its
  // FOCUS_TERMINAL_PANE_EVENT listener before we dispatch.
  requestAnimationFrame(() => {
    const detail: FocusTerminalPaneDetail = {
      tabId,
      stablePaneId,
      ...(opts?.ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess: opts.ackPaneKeyOnSuccess } : {})
    }
    window.dispatchEvent(
      new CustomEvent<FocusTerminalPaneDetail>(FOCUS_TERMINAL_PANE_EVENT, { detail })
    )
  })
}
