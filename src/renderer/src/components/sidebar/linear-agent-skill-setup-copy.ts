import type { LocalAgentRuntime } from '../settings/CliSkillRuntimeSetup'
import { translate } from '@/i18n/i18n'

export function getLinearAgentSkillSetupMissingLabel(
  cliAvailable: boolean,
  skillInstalled: boolean
): string {
  if (!cliAvailable && !skillInstalled) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingCliAndSkill',
      'Orca CLI and Linear agent skill are missing.'
    )
  }
  if (!cliAvailable) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingCli',
      'Orca CLI is missing.'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingSkill',
    'Linear agent skill is missing.'
  )
}

export function getLinearAgentSkillSetupToastTitle(
  cliAvailable: boolean,
  skillInstalled: boolean
): string {
  if (!cliAvailable && !skillInstalled) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastMissingCliAndSkill',
      'Orca CLI and Linear agent skill are missing'
    )
  }
  if (!cliAvailable) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastMissingCli',
      'Orca CLI is missing'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastMissingSkill',
    'Linear agent skill is missing'
  )
}

export function getLinearAgentSkillSetupToastDescription(
  remote: boolean,
  agentRuntime: LocalAgentRuntime
): string {
  if (remote) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.remoteToastDescription',
      'Install local setup for host handoffs; remote agent environments may still need their own setup.'
    )
  }
  if (agentRuntime.runtime === 'wsl') {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.wslToastDescription',
      'Install them for the selected WSL agent runtime so linked Linear ticket handoffs include ticket context.'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.hostToastDescription',
    'Install them so agents started from linked Linear tickets can read and update the ticket context.'
  )
}

export function getLinearAgentSkillSetupInlineRuntimeCopy(
  remote: boolean,
  agentRuntime: LocalAgentRuntime
): string {
  if (remote) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.remoteCopy',
      'This installs host setup; remote agent environments may need separate setup.'
    )
  }
  if (agentRuntime.runtime === 'wsl') {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.wslCopy',
      'Install it for WSL agent handoffs from linked Linear work.'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.hostCopy',
    'Install it for host agent handoffs from linked Linear work.'
  )
}
