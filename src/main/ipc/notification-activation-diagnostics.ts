import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const NOTIFICATION_ACTIVATION_DEBUG_LOG = 'notification-activation-debug.log'
const LOG_PREFIX = '[notification-activation]'

let cachedLogPath: string | null | undefined

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type DiagnosticDetails = Record<string, JsonValue | undefined>

export function getNotificationActivationDebugLogPath(): string | null {
  if (cachedLogPath !== undefined) {
    return cachedLogPath
  }

  try {
    cachedLogPath =
      typeof app.getPath === 'function'
        ? join(app.getPath('userData'), NOTIFICATION_ACTIVATION_DEBUG_LOG)
        : null
  } catch {
    cachedLogPath = null
  }
  return cachedLogPath
}

export function logNotificationActivationDiagnostic(
  event: string,
  details: DiagnosticDetails = {}
): void {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...dropUndefined(details)
  }
  const line = `${LOG_PREFIX} ${JSON.stringify(payload)}`
  console.info(line)

  const logPath = getNotificationActivationDebugLogPath()
  if (!logPath) {
    return
  }

  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${line}\n`, 'utf8')
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to append diagnostic log`, error)
  }
}

export function summarizeNotificationTarget(target: {
  worktreeId?: string | null
  paneKey?: string | null
}): DiagnosticDetails {
  return {
    worktreeIdPresent: typeof target.worktreeId === 'string' && target.worktreeId.length > 0,
    worktreeIdLength: typeof target.worktreeId === 'string' ? target.worktreeId.length : undefined,
    worktreeIdHasSeparator:
      typeof target.worktreeId === 'string' ? target.worktreeId.includes('::') : undefined,
    paneKeyPresent: typeof target.paneKey === 'string' && target.paneKey.length > 0,
    paneKeyLength: typeof target.paneKey === 'string' ? target.paneKey.length : undefined,
    paneKeyHasDelimiter:
      typeof target.paneKey === 'string' ? target.paneKey.includes(':') : undefined
  }
}

export function summarizeActivationArguments(rawArguments: unknown): DiagnosticDetails {
  if (typeof rawArguments !== 'string') {
    return {
      argumentsType: typeof rawArguments
    }
  }

  const params = new URLSearchParams(rawArguments)
  const worktreeId = params.get('worktreeId')
  const paneKey = params.get('paneKey')

  return {
    argumentsType: 'string',
    argumentsLength: rawArguments.length,
    argumentKeys: Array.from(new Set(params.keys())).sort(),
    notificationKind: params.get('orcaNotification'),
    ...summarizeNotificationTarget({ worktreeId, paneKey })
  }
}

function dropUndefined(details: DiagnosticDetails): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
  )
}
