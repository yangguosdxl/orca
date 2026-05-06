import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
import { recordCliFeatureUsed } from './telemetry'
import { CORE_HANDLERS } from './handlers/core'
import { REPO_HANDLERS } from './handlers/repo'
import { WORKTREE_HANDLERS } from './handlers/worktree'
import { TERMINAL_HANDLERS } from './handlers/terminal'
import { BROWSER_NAV_HANDLERS } from './handlers/browser-nav'
import { BROWSER_INTERACT_HANDLERS } from './handlers/browser-interact'
import { BROWSER_TAB_HANDLERS } from './handlers/browser-tab'
import { BROWSER_PROFILE_HANDLERS } from './handlers/browser-profile'
import { BROWSER_COOKIE_HANDLERS } from './handlers/browser-cookie'
import { BROWSER_CAPTURE_HANDLERS } from './handlers/browser-capture'
import { BROWSER_ENV_HANDLERS } from './handlers/browser-env'
import { BROWSER_STORAGE_HANDLERS } from './handlers/browser-storage'
import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'

export type HandlerContext = {
  flags: Map<string, string | boolean>
  client: RuntimeClient
  cwd: string
  json: boolean
}

export type CommandHandler = (ctx: HandlerContext) => Promise<void>

function buildHandlers(): Map<string, CommandHandler> {
  const table = new Map<string, CommandHandler>()
  const groups = [
    CORE_HANDLERS,
    REPO_HANDLERS,
    WORKTREE_HANDLERS,
    TERMINAL_HANDLERS,
    BROWSER_NAV_HANDLERS,
    BROWSER_INTERACT_HANDLERS,
    BROWSER_TAB_HANDLERS,
    BROWSER_PROFILE_HANDLERS,
    BROWSER_COOKIE_HANDLERS,
    BROWSER_CAPTURE_HANDLERS,
    BROWSER_ENV_HANDLERS,
    BROWSER_STORAGE_HANDLERS,
    ORCHESTRATION_HANDLERS
  ]
  for (const group of groups) {
    for (const [key, handler] of Object.entries(group)) {
      if (table.has(key)) {
        throw new Error(`Duplicate CLI handler registration for "${key}"`)
      }
      table.set(key, handler)
    }
  }
  return table
}

const HANDLERS = buildHandlers()

export async function dispatch(commandPath: string[], ctx: HandlerContext): Promise<void> {
  const handler = HANDLERS.get(commandPath.join(' '))
  if (!handler) {
    throw new RuntimeClientError('invalid_argument', `Unknown command: ${commandPath.join(' ')}`)
  }
  // Why: telemetry is fire-at-action — emit on the first call in a feature
  // group with that call's exit_status, then never again for this process.
  // The recording call is non-blocking and silent on failure, so it cannot
  // observably affect the command. We record `failure` if the handler
  // throws and `success` otherwise, then re-throw to preserve the original
  // error path. No buffering, no process-exit flush.
  try {
    await handler(ctx)
  } catch (error) {
    recordCliFeatureUsed(commandPath, 'failure')
    throw error
  }
  recordCliFeatureUsed(commandPath, 'success')
}
