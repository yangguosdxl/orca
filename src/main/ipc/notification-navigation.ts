import { app, BrowserWindow } from 'electron'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'

export type NotificationNavigationTarget = {
  worktreeId: string
  paneKey?: string | null
}

export function canNavigateNotificationTarget(target: NotificationNavigationTarget): boolean {
  return target.worktreeId.includes('::')
}

export function activateNotificationTarget(target: NotificationNavigationTarget): boolean {
  if (!canNavigateNotificationTarget(target)) {
    return false
  }

  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) {
    return false
  }

  if (process.platform === 'darwin') {
    app.focus({ steal: true })
  }
  if (win.isMinimized()) {
    win.restore()
  }
  win.focus()

  const repoId = getRepoIdFromWorktreeId(target.worktreeId)
  win.webContents.send('ui:activateWorktree', {
    repoId,
    worktreeId: target.worktreeId
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
  }

  return true
}
