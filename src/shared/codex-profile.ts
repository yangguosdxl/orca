export const ORCA_CODEX_AGENT_STATUS_PROFILE = 'orca-agent-status'

export function appendOrcaCodexAgentStatusProfile(command: string): string {
  return `${command} --profile-v2 ${ORCA_CODEX_AGENT_STATUS_PROFILE}`
}
