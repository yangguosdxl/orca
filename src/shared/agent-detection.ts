/**
 * Compatibility barrel for shared terminal agent-title detection.
 *
 * Why shared: main and renderer both consume OSC titles for facts, stats, and
 * UI state. Keep existing imports stable while the implementation stays split
 * into focused modules that satisfy max-lines.
 */

export type { AgentStatus } from './agent-title-core'
export {
  isClaudeManagementTitle,
  isCursorNativeAgentTitle,
  isGeminiTerminalTitle,
  isPiTerminalTitle,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE
} from './agent-title-core'
export { getAgentLabel, isClaudeAgent } from './agent-title-identity'
export {
  clearWorkingIndicators,
  createAgentStatusTracker,
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from './agent-title-status'
export { MAX_OSC_TITLE_CHARS } from './osc-title-extraction'
export { extractAllOscTitles, extractLastOscTitle } from './terminal-osc-title'

// Re-export so existing `agent-detection` importers keep working.
export { AGENT_NAMES, titleHasAgentName } from './agent-name-token-match'
export { isShellProcess } from './shell-process-detection'
