import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TuiAgent } from '../../../../shared/types'

export type IpcPtyTransportOptions = {
  cwd?: string
  env?: Record<string, string>
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  /** Orca worktree identity for scoped shell history. */
  worktreeId?: string
  /** Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
   *  main patch + sync-flush the (worktreeId, tabId, leafId -> ptyId) binding
   *  before pty:spawn returns. Only the renderer's daemon-host path threads
   *  these from the calling pane's (tabId, leafId). */
  tabId?: string
  leafId?: string
  /** Whether renderer-backed runtime reveal should focus the created tab. */
  activate?: boolean
  /** Why: mirrors PtySpawnOptions.shellOverride. */
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  /** Telemetry metadata for the `agent_started` event. Forwarded verbatim to
   *  `pty:spawn`; the IPC handler re-validates the schema. */
  telemetry?: EventProps<'agent_started'>
  onPtyExit?: (ptyId: string) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** Callback for OSC 9999 agent status payloads parsed from PTY output. */
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}
