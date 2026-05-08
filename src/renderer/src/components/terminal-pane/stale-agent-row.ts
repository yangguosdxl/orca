import { toast } from 'sonner'
import { useAppStore } from '@/store'

/** Emit a non-intrusive toast and drop the row from agent-status maps when a
 *  click-to-focus dispatch resolves to no live pane. This is the failure
 *  branch of the focus listener — the alternative (silent return) was the
 *  user-reported bug where clicking an agent row landed focus on the wrong
 *  pane. Dropping the row is safe because:
 *
 *    - the live entry's stablePaneId no longer maps to any pane in the
 *      manager, so the row was a stale projection of state from before a
 *      reload that didn't preserve the snapshot's stablePaneIds;
 *    - dropAgentStatus + dismissRetainedAgent purge the explicit + retained
 *      maps and clear the ack/suppressor entries for the same key, so the
 *      row can't reappear from a retention sync.
 *
 *  See docs/agent-status-pane-mismapping.md for the full rationale.
 */
export function surfaceStaleAgentRow(tabId: string, stablePaneId: string): void {
  const paneKey = `${tabId}:${stablePaneId}`
  const store = useAppStore.getState()
  const liveExisted = paneKey in store.agentStatusByPaneKey
  const retainedExisted = paneKey in store.retainedAgentsByPaneKey
  store.dropAgentStatus(paneKey)
  store.dismissRetainedAgent(paneKey)
  if (liveExisted || retainedExisted) {
    toast.info("Agent's pane is no longer available.", {
      id: `stale-agent-row-${paneKey}`
    })
  }
}
