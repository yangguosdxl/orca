import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { HookInstallAgent } from '../../shared/telemetry-events'
import type { GlobalSettings } from '../../shared/types'
import { antigravityHookService } from '../antigravity/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { droidHookService } from '../droid/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'

export type ManagedAgentHookInstaller = readonly [HookInstallAgent, () => void]
type ManagedHookRemover = readonly [HookInstallAgent, () => AgentHookInstallStatus]
type ManagedHookStatusReader = readonly [HookInstallAgent, () => AgentHookInstallStatus]

export const MANAGED_AGENT_HOOK_INSTALLERS: readonly ManagedAgentHookInstaller[] = [
  ['claude', () => claudeHookService.install()],
  [
    'codex',
    () => {
      // Why: the Orca-specific Codex profile keeps normal external `codex`
      // runs from loading Orca hooks; remove legacy global entries after it is ready.
      codexHookService.installProfile()
      codexHookService.remove()
    }
  ],
  ['gemini', () => geminiHookService.install()],
  ['antigravity', () => antigravityHookService.install()],
  ['cursor', () => cursorHookService.install()],
  ['droid', () => droidHookService.install()],
  ['grok', () => grokHookService.install()],
  ['copilot', () => copilotHookService.install()],
  ['hermes', () => hermesHookService.install()]
]

const LOCAL_MANAGED_HOOK_REMOVERS: readonly ManagedHookRemover[] = [
  ['claude', () => claudeHookService.remove()],
  [
    'codex',
    () => {
      const globalStatus = codexHookService.remove()
      const profileStatus = codexHookService.removeProfile()
      return profileStatus.state === 'error' ? profileStatus : globalStatus
    }
  ],
  ['gemini', () => geminiHookService.remove()],
  ['antigravity', () => antigravityHookService.remove()],
  ['cursor', () => cursorHookService.remove()],
  ['droid', () => droidHookService.remove()],
  ['grok', () => grokHookService.remove()],
  ['copilot', () => copilotHookService.remove()],
  ['hermes', () => hermesHookService.remove()]
]

const LOCAL_MANAGED_HOOK_STATUS_READERS: readonly ManagedHookStatusReader[] = [
  ['claude', () => claudeHookService.getStatus()],
  ['codex', () => codexHookService.getProfileStatus()],
  ['gemini', () => geminiHookService.getStatus()],
  ['antigravity', () => antigravityHookService.getStatus()],
  ['cursor', () => cursorHookService.getStatus()],
  ['droid', () => droidHookService.getStatus()],
  ['grok', () => grokHookService.getStatus()],
  ['copilot', () => copilotHookService.getStatus()],
  ['hermes', () => hermesHookService.getStatus()]
]

export function isAgentStatusHooksEnabled(
  settings: Pick<GlobalSettings, 'agentStatusHooksEnabled'> | null | undefined
): boolean {
  return settings?.agentStatusHooksEnabled !== false
}

export function installManagedAgentHooks(): void {
  for (const [agent, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
    try {
      install()
    } catch (error) {
      console.warn(`[agent-hooks] Failed to install ${agent} managed hooks:`, error)
    }
  }
}

function errorStatus(agent: HookInstallAgent, error: unknown): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

export function removeManagedAgentHooks(): AgentHookInstallStatus[] {
  return LOCAL_MANAGED_HOOK_REMOVERS.map(([agent, remove]) => {
    try {
      return remove()
    } catch (error) {
      return errorStatus(agent, error)
    }
  })
}

export function getManagedAgentHookStatuses(): AgentHookInstallStatus[] {
  return LOCAL_MANAGED_HOOK_STATUS_READERS.map(([agent, getStatus]) => {
    try {
      return getStatus()
    } catch (error) {
      return errorStatus(agent, error)
    }
  })
}

export function applyAgentStatusHooksEnabled(enabled: boolean): AgentHookInstallStatus[] {
  if (enabled) {
    installManagedAgentHooks()
    return getManagedAgentHookStatuses()
  }
  return removeManagedAgentHooks()
}
