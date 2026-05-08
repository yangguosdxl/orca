import { useAppStore } from '@/store'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The tab group the user clicked from. Keeps split-group launches in the
   *  pane the user initiated from instead of falling through to the active group. */
  groupId?: string
  /** Optional initial prompt. When non-empty, dispatched per the agent's
   *  `promptInjectionMode`: argv/flag agents auto-submit via the launch
   *  command; followup-path agents land the prompt as an unsent draft. */
  prompt?: string
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar
   *  quick-launch entry point so existing callers stay unchanged. */
  launchSource?: LaunchSource
}

export type LaunchAgentInNewTabResult = {
  tabId: string
  startupPlan: AgentStartupPlan
} | null

/**
 * Create a new terminal tab and queue the agent's launch command, optionally
 * with an initial prompt.
 *
 * Why: this is the single entry point for "launch agent X in a new tab" from
 * the tab-bar quick-launch menu and the Source Control "send notes to agent"
 * action. It mirrors the `+` button's path (`createNewTerminalTab`) — createTab,
 * flip `activeTabType` to terminal, and persist the appended tab-bar order —
 * then queues the agent startup through the same `pendingStartupByTabId`
 * channel the new-workspace ("cmd+N") flow uses. TerminalPane consumes the
 * queued command on first mount and the local PTY provider writes it once the
 * shell is ready (see `pty-connection.ts`: startup-command path).
 *
 * Submission mode is hybrid by `promptInjectionMode`: argv/flag agents include
 * the prompt directly in the launch command (auto-submit, atomic via the
 * shell); followup-path agents prefer a native prefill flag if available
 * (`buildAgentDraftLaunchPlan`) and otherwise launch empty-prompt and paste
 * the prompt as a bracketed-paste draft after the agent's input box is ready.
 *
 * Returns `null` when no startup plan can be built — for example, a whitespace-
 * only prompt on the trim-empty branch of `buildAgentStartupPlan`. Callers
 * surface that as a launch failure (see `QuickLaunchButton.runLaunch`).
 */
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const { agent, worktreeId, groupId, prompt, launchSource } = args
  const store = useAppStore.getState()
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const injectionMode = TUI_AGENT_CONFIG[agent].promptInjectionMode
  const isFollowupPath = injectionMode === 'stdin-after-start'

  // Why: argv/flag agents fold the prompt into the launch command (atomic
  // shell handoff, no readiness race). Followup-path agents have no such
  // flag; we land the prompt as an unsent draft via the native prefill flag
  // when available, otherwise via post-launch bracketed paste.
  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null

  if (hasPrompt && isFollowupPath) {
    const draftPlan = buildAgentDraftLaunchPlan({
      agent,
      draft: trimmedPrompt,
      cmdOverrides,
      platform: CLIENT_PLATFORM
    })
    if (draftPlan) {
      startupPlan = {
        agent: draftPlan.agent,
        launchCommand: draftPlan.launchCommand,
        expectedProcess: draftPlan.expectedProcess,
        followupPrompt: null,
        ...(draftPlan.env ? { env: draftPlan.env } : {})
      }
    } else {
      // Why: no native prefill flag → launch empty and bracketed-paste the
      // draft once the agent's input box is ready. Auto-submitting via a
      // typed `\r` after a readiness wait carries a small race (if readiness
      // detection misses, the `\r` runs in the host shell). Drafting via
      // bracketed paste avoids the `\r` entirely and lets the user confirm
      // visually before sending.
      startupPlan = buildAgentStartupPlan({
        agent,
        prompt: '',
        cmdOverrides,
        platform: CLIENT_PLATFORM,
        allowEmptyPromptLaunch: true
      })
      pasteDraftAfterLaunch = trimmedPrompt
    }
  } else {
    // argv/flag agents OR no prompt at all (existing quick-launch behavior).
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }

  if (!startupPlan) {
    return null
  }

  // Why: queue the startup command BEFORE TerminalPane mounts — it captures
  // `pendingStartupByTabId[tabId]` in useState on first render. If the queue
  // lands after mount the agent binary never starts; the user sees a bare shell.
  // Since both calls happen synchronously in the same React batch, the queue
  // is in place by the time the pane commits.
  //
  // The telemetry payload is threaded through the queue → pty-connection →
  // pty-transport → pty:spawn IPC → main, where main fires `agent_started`
  // only after the spawn succeeds. `request_kind: 'new'` because
  // quick-launch always opens a fresh session.
  const tab = store.createTab(worktreeId, groupId)
  store.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  })

  // Why: schedule the bracketed-paste-after-ready follow-up immediately after
  // the startup command is queued. Fire-and-forget so callers keep their
  // synchronous `{ tabId, startupPlan }` signature. The helper short-circuits
  // for agents with a `draftPromptFlag`, so calling it on the followup path
  // is safe even when the draft was already injected via the native flag.
  if (pasteDraftAfterLaunch !== null) {
    void pasteDraftWhenAgentReady({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent
    })
  }

  // Why: match the `+` button's `createNewTerminalTab` sequence — without
  // `setActiveTabType('terminal')`, a worktree currently showing an editor
  // file keeps rendering the editor and the new terminal tab stays invisible.
  store.setActiveTabType('terminal')

  // Why: persist the tab-bar order with the new terminal appended. Without
  // this, `reconcileTabOrder` falls back to terminals-first when the stored
  // order is unset, which can jump the new tab to index 0 instead of the end.
  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(worktreeId, order)

  return { tabId: tab.id, startupPlan }
}
