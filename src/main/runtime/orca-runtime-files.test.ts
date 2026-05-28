import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'fs'
import type * as FsPromises from 'fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'

const {
  lstatMock,
  renameMock,
  resolveAuthorizedPathMock,
  statMock,
  subscribeParcelWatcherMock,
  watchMock
} = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  renameMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  subscribeParcelWatcherMock: vi.fn(),
  watchMock: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    watch: watchMock
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    lstat: lstatMock,
    rename: renameMock,
    stat: statMock
  }
})

vi.mock('@parcel/watcher', () => ({
  subscribe: subscribeParcelWatcherMock
}))

vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))

import { awaitRuntimeFileWatcherUnsubscribes, RuntimeFileCommands } from './orca-runtime-files'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

function mockStats(dev: number, ino: number) {
  return { dev, ino, isDirectory: () => false }
}

function createRuntimeFileCommands() {
  const store = {
    getRepo: vi.fn((_repoId?: string) => undefined as { connectionId?: string } | undefined)
  }
  const commands = new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: vi.fn(async () => ({
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/repo'
    })),
    resolveRuntimeGitTarget: vi.fn(),
    openFile: vi.fn()
  } as never)
  return { commands, store }
}

describe('RuntimeFileCommands', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    lstatMock.mockReset()
    renameMock.mockReset()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    subscribeParcelWatcherMock.mockReset()
    watchMock.mockReset()
    lstatMock.mockRejectedValue(enoent())
    renameMock.mockResolvedValue(undefined)
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(async () => {
    await awaitRuntimeFileWatcherUnsubscribes()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    vi.useRealTimers()
  })

  it('opens source control diffs through the renderer host', async () => {
    const openDiff = vi.fn()
    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => ({ getRepo: vi.fn(() => undefined) }),
      resolveWorktreeSelector: vi.fn(async () => ({
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo'
      })),
      resolveRuntimeGitTarget: vi.fn(),
      openFile: vi.fn(),
      openDiff
    } as never)

    const result = await commands.openMobileDiff('id:wt-1', 'docs/readme.md', true)

    expect(openDiff).toHaveBeenCalledWith('wt-1', '/repo/docs/readme.md', 'docs/readme.md', true)
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'docs/readme.md',
      kind: 'markdown',
      opened: true
    })
  })

  it('renames a runtime-local file when destination does not exist', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

    await commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')

    expect(renameMock).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
  })

  it('allows runtime-local case-only rename with IPC parity guard behavior', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === '/repo/README.md' || p === '/repo/readme.md') {
        return mockStats(10, 100)
      }
      throw enoent()
    })

    await commands.renameFileExplorerPath('id:wt-1', 'README.md', 'readme.md')

    expect(renameMock).toHaveBeenCalledWith('/repo/README.md', '/repo/readme.md')
  })

  it('rejects runtime-local true destination collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === '/repo/old.ts') {
        return mockStats(11, 110)
      }
      if (p === '/repo/new.ts') {
        return mockStats(11, 111)
      }
      throw enoent()
    })

    await expect(commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')).rejects.toThrow(
      "A file or folder named 'new.ts' already exists in this location"
    )

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local hard-link alias collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === '/repo/README.md' || p === '/repo/README-hardlink.md') {
        return mockStats(12, 120)
      }
      throw enoent()
    })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'README.md', 'README-hardlink.md')
    ).rejects.toThrow("A file or folder named 'README-hardlink.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local cross-parent case-only collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockImplementation(async (p: string) => {
      if (p === '/repo/src/README.md' || p === '/repo/docs/readme.md') {
        return mockStats(13, 130)
      }
      throw enoent()
    })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'src/README.md', 'docs/readme.md')
    ).rejects.toThrow("A file or folder named 'readme.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('routes runtime remote rename through the SSH no-clobber provider method', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')

    expect(renameNoClobber).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('propagates runtime remote no-clobber rename failures', async () => {
    const renameNoClobber = vi.fn().mockRejectedValue(new Error('destination exists'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')).rejects.toThrow(
      'destination exists'
    )
    expect(renameMock).not.toHaveBeenCalled()
  })
})
