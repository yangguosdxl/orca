import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as WatcherEvent, SubscribeCallback } from '@parcel/watcher'
import type { GlobalSettings, Repo } from '../../shared/types'

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => ''),
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn()
}))

vi.mock('./worktree-remote', () => ({
  notifyWorktreesChanged: vi.fn()
}))

import { subscribe } from '@parcel/watcher'
import { notifyWorktreesChanged } from './worktree-remote'
import {
  disposeWorktreeBaseDirectoryWatchers,
  syncWorktreeBaseDirectoryWatchers
} from './worktree-base-directory-watcher'
import { matchingWorktreeBaseRepoIds } from './worktree-base-directory-event-filter'

type WatcherCallback = SubscribeCallback

const watcherCallbacks = new Map<string, WatcherCallback>()
const unsubscribeMocks = new Map<string, ReturnType<typeof vi.fn>>()

const settings = {
  workspaceDir: '/workspace/worktrees',
  nestWorkspaces: true
} as GlobalSettings

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/projects/project',
    displayName: 'Project',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeStore(repos: Repo[]) {
  return {
    getSettings: () => settings,
    getRepos: () => repos
  }
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}

function emit(root: string, events: WatcherEvent[]): void {
  const callback = watcherCallbacks.get(root)
  if (!callback) {
    throw new Error(`No watcher callback for ${root}`)
  }
  callback(null, events)
}

describe('worktree base directory watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    watcherCallbacks.clear()
    unsubscribeMocks.clear()
    vi.mocked(subscribe).mockImplementation(async (root, callback) => {
      const unsubscribe = vi.fn(async () => {})
      watcherCallbacks.set(root, callback)
      unsubscribeMocks.set(root, unsubscribe)
      return { unsubscribe }
    })
  })

  afterEach(async () => {
    await disposeWorktreeBaseDirectoryWatchers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('coalesces nested worktree completion events into one targeted notification', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit('/workspace/worktrees', [
      { type: 'create', path: '/workspace/worktrees/project/external-5104' },
      { type: 'create', path: '/workspace/worktrees/project/external-5104/.git' }
    ] as WatcherEvent[])

    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledTimes(1)
    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('ignores deep checkout churn below candidate roots', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit('/workspace/worktrees', [
      { type: 'update', path: '/workspace/worktrees/project/existing/src/file.ts' }
    ] as WatcherEvent[])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).not.toHaveBeenCalled()
  })

  it('uses Git common-dir worktree metadata as a low-churn completion signal', async () => {
    await syncWorktreeBaseDirectoryWatchers(makeStore([makeRepo()]) as never, makeWindow() as never)

    emit('/workspace/projects/project/.git', [
      { type: 'create', path: '/workspace/projects/project/.git/worktrees/external-5104/gitdir' }
    ] as WatcherEvent[])
    await vi.advanceTimersByTimeAsync(300)

    expect(notifyWorktreesChanged).toHaveBeenCalledWith(expect.anything(), 'repo-1')
  })

  it('does not install local desktop watchers for non-local or folder repos', async () => {
    await syncWorktreeBaseDirectoryWatchers(
      makeStore([
        makeRepo({ id: 'ssh', connectionId: 'ssh-1' }),
        makeRepo({ id: 'runtime', executionHostId: 'runtime:dev' }),
        makeRepo({ id: 'folder', kind: 'folder' })
      ]) as never,
      makeWindow() as never
    )

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('unsubscribes roots that disappear after repo settings change', async () => {
    const repo = makeRepo()
    const store = makeStore([repo])
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    repo.worktreeBasePath = '/workspace/other-worktrees'
    await syncWorktreeBaseDirectoryWatchers(store as never, makeWindow() as never)

    expect(unsubscribeMocks.get('/workspace/worktrees')).toHaveBeenCalled()
    expect(watcherCallbacks.has('/workspace/other-worktrees')).toBe(true)
  })

  it('matches flat workspace .git marker events without matching sibling churn', () => {
    const target = {
      key: 'base:/workspace/worktrees',
      kind: 'base' as const,
      path: '/workspace/worktrees',
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }

    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'create',
        path: '/workspace/worktrees/external-5104/.git'
      } as WatcherEvent)
    ).toEqual(['repo-1'])
    expect(
      matchingWorktreeBaseRepoIds(target, {
        type: 'update',
        path: '/workspace/worktrees/external-5104/src/file.ts'
      } as WatcherEvent)
    ).toEqual([])
  })
})
