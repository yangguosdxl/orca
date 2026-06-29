import { Notification } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/types'
import {
  activateNotificationTarget,
  canNavigateNotificationTarget,
  type NotificationNavigationTarget
} from './notification-navigation'
import {
  logNotificationActivationDiagnostic,
  summarizeActivationArguments,
  summarizeNotificationTarget
} from './notification-activation-diagnostics'

const ORCA_NOTIFICATION_PARAM = 'orcaNotification'
const ORCA_AGENT_SESSION_NOTIFICATION = 'agent-session'

type ToastNotificationOptions = {
  title?: string
  body?: string
  silent?: boolean
  toastXml?: string
}

export function buildWindowsNotificationActivationArguments(
  args: NotificationDispatchRequest
): string | null {
  if (!args.worktreeId) {
    return null
  }
  const target: NotificationNavigationTarget = {
    worktreeId: args.worktreeId,
    paneKey: args.paneKey
  }
  if (!canNavigateNotificationTarget(target)) {
    return null
  }

  const params = new URLSearchParams()
  params.set(ORCA_NOTIFICATION_PARAM, ORCA_AGENT_SESSION_NOTIFICATION)
  params.set('worktreeId', target.worktreeId)
  if (target.paneKey) {
    params.set('paneKey', target.paneKey)
  }
  return params.toString()
}

export function parseWindowsNotificationActivationArguments(
  rawArguments: string
): NotificationNavigationTarget | null {
  const params = new URLSearchParams(rawArguments)
  if (params.get(ORCA_NOTIFICATION_PARAM) !== ORCA_AGENT_SESSION_NOTIFICATION) {
    return null
  }

  const worktreeId = params.get('worktreeId')?.trim()
  if (!worktreeId) {
    return null
  }

  const target: NotificationNavigationTarget = {
    worktreeId,
    paneKey: params.get('paneKey')
  }
  return canNavigateNotificationTarget(target) ? target : null
}

export function withWindowsNotificationActivationOptions<T extends ToastNotificationOptions>(
  options: T,
  args: NotificationDispatchRequest
): T {
  if (process.platform !== 'win32') {
    return options
  }

  const activationArguments = buildWindowsNotificationActivationArguments(args)
  if (!activationArguments) {
    logNotificationActivationDiagnostic('toast-options-skip-activation', {
      platform: process.platform,
      source: args.source,
      reason: args.worktreeId ? 'non-navigable-target' : 'missing-worktree-id',
      ...summarizeNotificationTarget({ worktreeId: args.worktreeId, paneKey: args.paneKey })
    })
    return options
  }

  const toastXml = buildWindowsToastXml(options, activationArguments)
  logNotificationActivationDiagnostic('toast-options-set-activation', {
    platform: process.platform,
    source: args.source,
    activationArgumentsLength: activationArguments.length,
    toastXmlLength: toastXml.length,
    titlePresent: typeof options.title === 'string' && options.title.length > 0,
    bodyPresent: typeof options.body === 'string' && options.body.length > 0,
    silent: options.silent === true,
    ...summarizeNotificationTarget({ worktreeId: args.worktreeId, paneKey: args.paneKey })
  })

  return {
    ...options,
    toastXml
  }
}

export function registerWindowsNotificationActivationHandler(): void {
  if (process.platform !== 'win32') {
    return
  }

  if (typeof Notification.handleActivation !== 'function') {
    logNotificationActivationDiagnostic('handle-activation-unavailable', {
      platform: process.platform,
      handleActivationType: typeof Notification.handleActivation
    })
    return
  }

  logNotificationActivationDiagnostic('handle-activation-register', {
    platform: process.platform
  })

  Notification.handleActivation((details) => {
    logNotificationActivationDiagnostic('handle-activation-fired', {
      activationType: details.type ?? null,
      ...summarizeActivationArguments(details.arguments)
    })

    const target = parseWindowsNotificationActivationArguments(details.arguments)
    if (!target) {
      logNotificationActivationDiagnostic('handle-activation-ignored', {
        reason: 'unrecognized-arguments',
        ...summarizeActivationArguments(details.arguments)
      })
      return
    }
    const activated = activateNotificationTarget(target)
    logNotificationActivationDiagnostic('handle-activation-result', {
      activated,
      ...summarizeNotificationTarget(target)
    })
  })
}

function buildWindowsToastXml(
  options: ToastNotificationOptions,
  activationArguments: string
): string {
  const title = escapeXmlText(options.title ?? '')
  const body = escapeXmlText(options.body ?? '')
  const audio = options.silent ? '<audio silent="true"/>' : ''

  // Why: Windows Action Center only preserves navigation state carried by the
  // toast activation payload; per-instance Electron click handlers can be gone.
  return [
    `<toast launch="${escapeXmlAttribute(activationArguments)}">`,
    '<visual>',
    '<binding template="ToastGeneric">',
    `<text>${title}</text>`,
    `<text>${body}</text>`,
    '</binding>',
    '</visual>',
    audio,
    '</toast>'
  ].join('')
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
