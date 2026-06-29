import { app, BrowserWindow } from 'electron'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import {
  logNotificationActivationDiagnostic,
  summarizeNotificationTarget
} from './notification-activation-diagnostics'

export type NotificationNavigationTarget = {
  worktreeId: string
  paneKey?: string | null
}

export function canNavigateNotificationTarget(target: NotificationNavigationTarget): boolean {
  return target.worktreeId.includes('::')
}

export function activateNotificationTarget(target: NotificationNavigationTarget): boolean {
  if (!canNavigateNotificationTarget(target)) {
    logNotificationActivationDiagnostic('navigation-abort', {
      reason: 'non-navigable-target',
      ...summarizeNotificationTarget(target)
    })
    return false
  }

  logNotificationActivationDiagnostic('navigation-start', summarizeNotificationTarget(target))

  const windows = BrowserWindow.getAllWindows()
  const win = windows.find((w) => !w.isDestroyed())
  logNotificationActivationDiagnostic('navigation-window-search', {
    windowCount: windows.length,
    destroyedWindowCount: windows.filter((w) => readWindowBoolean(w, 'isDestroyed') === true)
      .length,
    usableWindowFound: Boolean(win)
  })
  if (!win) {
    logNotificationActivationDiagnostic('navigation-abort', {
      reason: 'no-window',
      ...summarizeNotificationTarget(target)
    })
    return false
  }

  if (process.platform === 'darwin') {
    app.focus({ steal: true })
  }
  if (win.isMinimized()) {
    logNotificationActivationDiagnostic('navigation-window-restore', {
      isVisibleBeforeRestore: readWindowBoolean(win, 'isVisible')
    })
    win.restore()
  }
  logNotificationActivationDiagnostic('navigation-window-before-focus', {
    isFocused: readWindowBoolean(win, 'isFocused'),
    isMinimized: readWindowBoolean(win, 'isMinimized'),
    isVisible: readWindowBoolean(win, 'isVisible'),
    showAvailable: typeof win.show === 'function',
    showCalled: false
  })
  win.focus()
  logNotificationActivationDiagnostic('navigation-window-focus-called', {
    isFocused: readWindowBoolean(win, 'isFocused'),
    isVisible: readWindowBoolean(win, 'isVisible')
  })

  const repoId = getRepoIdFromWorktreeId(target.worktreeId)
  win.webContents.send('ui:activateWorktree', {
    repoId,
    worktreeId: target.worktreeId
  })
  logNotificationActivationDiagnostic('navigation-ipc-sent', {
    channel: 'ui:activateWorktree',
    ...summarizeNotificationTarget(target)
  })

  const paneTarget = target.paneKey ? parsePaneKey(target.paneKey) : null
  if (paneTarget) {
    win.webContents.send('ui:focusTerminal', {
      tabId: paneTarget.tabId,
      worktreeId: target.worktreeId,
      leafId: paneTarget.leafId,
      ackPaneKeyOnSuccess: target.paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    logNotificationActivationDiagnostic('navigation-ipc-sent', {
      channel: 'ui:focusTerminal',
      paneKeyParsed: true,
      ...summarizeNotificationTarget(target)
    })
  } else if (target.paneKey) {
    logNotificationActivationDiagnostic('navigation-pane-skip', {
      reason: 'pane-key-parse-failed',
      ...summarizeNotificationTarget(target)
    })
  }

  return true
}

function readWindowBoolean(
  win: BrowserWindow,
  method: 'isDestroyed' | 'isFocused' | 'isMinimized' | 'isVisible'
): boolean | 'unavailable' | 'error' {
  const reader = win[method]
  if (typeof reader !== 'function') {
    return 'unavailable'
  }
  try {
    return reader.call(win)
  } catch {
    return 'error'
  }
}
