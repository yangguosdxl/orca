export const TOGGLE_TERMINAL_PANE_EXPAND_EVENT = 'orca-toggle-terminal-pane-expand'
export const FOCUS_TERMINAL_PANE_EVENT = 'orca-focus-terminal-pane'
export const SPLIT_TERMINAL_PANE_EVENT = 'orca-split-terminal-pane'
export const CLOSE_TERMINAL_PANE_EVENT = 'orca-close-terminal-pane'

// Why: sidebar open/close is an instantaneous width change. If we wait for
// the ResizeObserver rAF (and the 150ms debounced global fit) to catch up,
// the user sees the terminal in a wrongly-fit state for ~16ms+ then a snap
// as it reflows. Dispatching this event in a useLayoutEffect lets the
// terminal fit synchronously before paint — so the new width and the
// reflowed terminal land on the same frame with no visible transient.
//
// Continuous drags (sidebar-width drag, tab-group split drag) don't need
// this: the per-pane ResizeObserver rAF path is fine on its own because
// xterm's terminal.resize() natively preserves viewportY across reflows
// (verified in scroll-reflow.test.ts "reference: undisturbed"). This is
// how Superset and VSCode handle the same case.
export const SYNC_FIT_PANES_EVENT = 'orca-sync-fit-panes'

export type ToggleTerminalPaneExpandDetail = {
  tabId: string
}

export type FocusTerminalPaneDetail = {
  tabId: string
  /** Opaque per-pane UUID minted by PaneManager (see ManagedPane.stablePaneId).
   *  Stable across renderer reload, unlike the renderer-local numeric paneId.
   *  Use the manager's getNumericIdForStable() to resolve back to the numeric
   *  handle on receipt. `null` means the dispatcher couldn't resolve a leaf
   *  (e.g. malformed paneKey) and the listener should not focus anything. */
  stablePaneId: string | null
  /** Optional paneKey the listener should ack on focus-success. Set only by
   *  callers that want the focus dispatch to double as a "user saw this row"
   *  signal (sidebar inline agent rows). Left undefined for plain focus
   *  routes (e.g. status-bar Resource Usage popover). */
  ackPaneKeyOnSuccess?: string
}

export type SplitTerminalPaneDetail = {
  tabId: string
  paneRuntimeId: number
  direction: 'horizontal' | 'vertical'
  command?: string
}

export type CloseTerminalPaneDetail = {
  tabId: string
  paneRuntimeId: number
}
