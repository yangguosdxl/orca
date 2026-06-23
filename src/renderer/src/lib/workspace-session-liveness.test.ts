import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'

function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: 'worktree:wt-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    ...overrides
  }
}

describe('workspace session live PTY persistence', () => {
  it('does not treat slept terminal wake hints as active on restart', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              title: 'shell',
              ptyId: 'preserved-wake-hint',
              worktreeId: 'wt-1'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-1': [] }
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toEqual([])
  })

  it('keeps a restored-but-not-yet-opened inactive worktree reconnectable on the next restart', () => {
    // Why: reconnectPersistedTerminals only advertises live PTYs (ptyIdsByTabId)
    // for the active worktree. Inactive restored worktrees keep their reconnect
    // wake hint on tab.ptyId plus the unconsumed pendingActivationSpawn flag set
    // at hydration. A normal session save must not drop them from the persisted
    // reconnect lists, or the following restart spawns fresh shells instead of
    // reattaching the live session.
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-inactive': [
            {
              id: 'tab-inactive',
              title: 'shell',
              ptyId: 'wake-hint-session',
              pendingActivationSpawn: true,
              worktreeId: 'wt-inactive'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-inactive': [] }
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-inactive'])
  })

  it('carries a restored-but-not-yet-opened SSH worktree relay session id forward', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-ssh': [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: 'relay-sess-77',
              pendingActivationSpawn: true,
              worktreeId: 'wt-ssh'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh': [] },
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'SSH',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'conn-1'
          }
        ],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' } as never]
        }
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-ssh'])
    expect(payload.remoteSessionIdsByTabId).toEqual({ 'tab-ssh': 'relay-sess-77' })
  })

  it('does not persist remote session ids for slept SSH tabs', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-ssh': [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: 'relay-sess-42',
              worktreeId: 'wt-ssh'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh': [] },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'relay-sess-42' },
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'SSH',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'conn-1'
          }
        ],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' } as never]
        }
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toEqual([])
    expect(payload.remoteSessionIdsByTabId).toBeUndefined()
  })
})
