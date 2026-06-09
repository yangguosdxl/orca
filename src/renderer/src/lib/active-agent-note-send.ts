import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSend,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { makePaneKey, isTerminalLeafId } from '../../../shared/stable-pane-id'
import {
  detectAgentStatusFromTitle,
  getAgentLabel,
  isExplicitAgentStatusFresh
} from './agent-status'
import { resolveRuntimePaneTitleLeafId } from './runtime-pane-title-leaf-id'
import type { TerminalLayoutSnapshot } from '../../../shared/types'

const ACTIVE_AGENT_SEND_TIMEOUT_MS = 8000
const ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS = 15000
const ACTIVE_AGENT_TERMINAL_LIST_LIMIT = 200

export type ActiveTerminalNoteTarget = {
  tabId: string
  leafId: string
}

export type ActiveAgentNotesSendStatus =
  | 'sent'
  | 'empty'
  | 'no-active-terminal'
  | 'no-agent'
  | 'not-ready'
  | 'not-writable'

export type ActiveAgentNotesSendResult = {
  status: ActiveAgentNotesSendStatus
}

type ActiveTerminalNoteTargetState = {
  activeWorktreeId: AppState['activeWorktreeId']
  activeTabType: AppState['activeTabType']
  activeTabId: AppState['activeTabId']
  activeTabIdByWorktree: AppState['activeTabIdByWorktree']
  tabsByWorktree: Record<
    string,
    readonly { id: string; title?: string; launchAgent?: unknown }[] | undefined
  >
  ptyIdsByTabId?: Record<string, readonly string[] | undefined>
  terminalLayoutsByTabId: Record<
    string,
    | {
        activeLeafId: string | null
        root?: TerminalLayoutSnapshot['root']
        ptyIdsByLeafId?: Record<string, string | undefined>
      }
    | undefined
  >
  runtimePaneTitlesByTabId?: Record<string, Record<number, string> | undefined>
  agentStatusByPaneKey?: Record<string, AgentStatusEntry | undefined>
}

export function getActiveTerminalNoteTarget(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string
): ActiveTerminalNoteTarget | null {
  if (state.activeWorktreeId !== worktreeId) {
    return null
  }

  const tabId =
    state.activeTabType === 'terminal'
      ? (state.activeTabId ?? state.activeTabIdByWorktree[worktreeId])
      : state.activeTabIdByWorktree[worktreeId]
  if (!tabId || !(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
    return null
  }

  const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  return leafId ? { tabId, leafId } : null
}

export function useCanSendNotesToActiveTerminal(worktreeId: string): boolean {
  return useAppStore((state) => getActiveAgentNoteTarget(state, worktreeId) !== null)
}

export function getActiveAgentNoteTarget(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string,
  now = Date.now()
): ActiveTerminalNoteTarget | null {
  const noteTarget = getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget || !isTerminalLeafId(noteTarget.leafId)) {
    return null
  }

  const activePtyId = getActivePanePtyId(state, noteTarget)
  if (!activePtyId) {
    return null
  }

  const entry = state.agentStatusByPaneKey?.[makePaneKey(noteTarget.tabId, noteTarget.leafId)]
  if (entry && isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return noteTarget
  }
  // Why: freshly opened agents can be idle before their first hook event. Use
  // renderer title/launch hints only to show the option; runtime still verifies
  // the focused terminal is an idle agent before sending Enter.
  if (!hasFocusedPaneAgentHint(state, worktreeId, noteTarget)) {
    return null
  }

  return noteTarget
}

export async function sendNotesToActiveAgentSession({
  worktreeId,
  prompt,
  timeoutMs = ACTIVE_AGENT_SEND_TIMEOUT_MS
}: {
  worktreeId: string
  prompt: string
  timeoutMs?: number
}): Promise<ActiveAgentNotesSendResult> {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    return { status: 'empty' }
  }

  const state = useAppStore.getState()
  const noteTarget = getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget) {
    return { status: 'no-active-terminal' }
  }

  const runtimeTarget = getActiveRuntimeTarget(state.settings)
  const terminal = await findActiveRuntimeTerminal(runtimeTarget, worktreeId, noteTarget)
  if (!terminal) {
    return { status: 'no-active-terminal' }
  }

  // Why: sending notes submits with Enter, so only the runtime's agent/idle
  // checks can authorize it; tab labels and renderer state are not enough.
  const agentCheck = await callRuntimeRpc<{ isRunningAgent: boolean }>(
    runtimeTarget,
    'terminal.isRunningAgent',
    { terminal: terminal.handle },
    { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
  )
  if (!agentCheck.isRunningAgent) {
    return { status: 'no-agent' }
  }

  try {
    const { wait } = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
      runtimeTarget,
      'terminal.wait',
      { terminal: terminal.handle, for: 'tui-idle', timeoutMs },
      { timeoutMs: timeoutMs + 5000 }
    )
    if (!wait.satisfied) {
      return { status: 'not-ready' }
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return { status: 'no-active-terminal' }
    }
    if (isRuntimeTimeout(error)) {
      return { status: 'not-ready' }
    }
    throw error
  }

  const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    runtimeTarget,
    'terminal.send',
    {
      terminal: terminal.handle,
      text: trimmedPrompt,
      enter: true,
      client: { id: 'orca-desktop', type: 'desktop' }
    },
    { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
  )
  return send.accepted ? { status: 'sent' } : { status: 'not-writable' }
}

export function activeAgentNotesSendFailureMessage(status: ActiveAgentNotesSendStatus): string {
  switch (status) {
    case 'empty':
      return 'No notes to send.'
    case 'no-active-terminal':
      return 'Open the agent terminal in this worktree, then send the notes again.'
    case 'no-agent':
      return 'The active terminal is not a recognized agent session.'
    case 'not-ready':
      return 'The active agent was not ready for input yet.'
    case 'not-writable':
      return 'The active terminal did not accept the notes.'
    case 'sent':
      return ''
  }
}

async function findActiveRuntimeTerminal(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget
): Promise<RuntimeTerminalListResult['terminals'][number] | null> {
  const { terminals } = await callRuntimeRpc<RuntimeTerminalListResult>(
    runtimeTarget,
    'terminal.list',
    // Why: worktree ids can look like branch names or paths; keep the lookup unambiguous.
    { worktree: toRuntimeWorktreeSelector(worktreeId), limit: ACTIVE_AGENT_TERMINAL_LIST_LIMIT },
    { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
  )
  return (
    terminals.find(
      (terminal) => terminal.tabId === noteTarget.tabId && terminal.leafId === noteTarget.leafId
    ) ?? null
  )
}

function getActivePanePtyId(
  state: ActiveTerminalNoteTargetState,
  noteTarget: ActiveTerminalNoteTarget
): string | null {
  const livePtyIds = state.ptyIdsByTabId?.[noteTarget.tabId] ?? []
  if (livePtyIds.length === 0) {
    return null
  }

  const ptyIdsByLeafId = state.terminalLayoutsByTabId[noteTarget.tabId]?.ptyIdsByLeafId
  if (ptyIdsByLeafId && Object.keys(ptyIdsByLeafId).length > 0) {
    const activeLeafPtyId = ptyIdsByLeafId[noteTarget.leafId]
    // Why: layout maps can survive sleep/reconnect; ptyIdsByTabId is the live
    // PTY source of truth for whether submitting with Enter is currently safe.
    return activeLeafPtyId && livePtyIds.includes(activeLeafPtyId) ? activeLeafPtyId : null
  }
  return livePtyIds[0] ?? null
}

function hasFocusedPaneAgentHint(
  state: ActiveTerminalNoteTargetState,
  worktreeId: string,
  noteTarget: ActiveTerminalNoteTarget
): boolean {
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find(
    (entry) => entry.id === noteTarget.tabId
  )
  const runtimeTitle = getFocusedRuntimePaneTitle(state, noteTarget)
  if (runtimeTitle !== null) {
    return isRecognizedAgentTitle(runtimeTitle)
  }
  if (tab?.launchAgent) {
    return true
  }

  return tab?.title ? isRecognizedAgentTitle(tab.title) : false
}

function getFocusedRuntimePaneTitle(
  state: ActiveTerminalNoteTargetState,
  noteTarget: ActiveTerminalNoteTarget
): string | null {
  const paneTitles = state.runtimePaneTitlesByTabId?.[noteTarget.tabId]
  if (!paneTitles || Object.keys(paneTitles).length === 0) {
    return null
  }

  const layout = state.terminalLayoutsByTabId[noteTarget.tabId]
  const titleEntries = Object.entries(paneTitles)
  if (layout?.root) {
    // Why: split-pane title maps can be sparse; a lone background title must not
    // enable "send to active agent" for the focused shell pane.
    for (const [runtimePaneId, title] of titleEntries) {
      if (resolveRuntimePaneTitleLeafId(layout, runtimePaneId) === noteTarget.leafId) {
        return title
      }
    }
    return null
  }

  if (titleEntries.length === 1) {
    return titleEntries[0][1]
  }

  for (const [runtimePaneId, title] of titleEntries) {
    if (resolveRuntimePaneTitleLeafId(layout, runtimePaneId) === noteTarget.leafId) {
      return title
    }
  }
  return null
}

function isRecognizedAgentTitle(title: string): boolean {
  return detectAgentStatusFromTitle(title) !== null && getAgentLabel(title) !== null
}

function isRuntimeTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('timeout')
}

function isRuntimeTerminalUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_active_terminal')
  )
}
