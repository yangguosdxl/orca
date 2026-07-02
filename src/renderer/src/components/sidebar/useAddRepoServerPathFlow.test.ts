import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  addRepoPath: vi.fn(),
  closeModal: vi.fn(),
  fetchWorktrees: vi.fn(),
  getNestedRepoRuntimeKind: vi.fn(),
  scanNestedRepos: vi.fn(),
  setActiveNestedScanId: vi.fn(),
  setNestedScanInProgress: vi.fn(),
  showNestedRepoReview: vi.fn(),
  onGitRepoReady: vi.fn(),
  setAddProjectBusyLabel: vi.fn(),
  markOnboardingProjectAdded: vi.fn(),
  track: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useRef: <T>(value: T) => ({ current: value }),
    useState: <T>(initial: T | (() => T)) => {
      const index = mocks.stateIndex++
      const value =
        index in mocks.stateValues
          ? mocks.stateValues[index]
          : typeof initial === 'function'
            ? (initial as () => T)()
            : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value as T, setter]
    }
  }
})

vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: mocks.markOnboardingProjectAdded
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'server-folder',
    path: '/server/docs',
    displayName: 'docs',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

function makeScan(
  path: string,
  overrides: Partial<NestedRepoScanResult> = {}
): NestedRepoScanResult {
  return {
    selectedPath: path,
    selectedPathKind: 'git_repo',
    repos: [],
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: null,
    ...overrides
  }
}

describe('useAddRepoServerPathFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = ['/server/docs', false]
    mocks.getNestedRepoRuntimeKind.mockReturnValue('local')
  })

  it('marks onboarding folder progress before closing server folder adds', async () => {
    const repo = makeRepo()
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder')
    expect(mocks.scanNestedRepos).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('adds a non-git server root path when nested repositories are present', async () => {
    const repo = makeRepo({ id: 'docs', kind: 'git' })
    const scan = makeScan('/server/docs', {
      selectedPathKind: 'non_git_folder',
      repos: [{ path: '/server/docs/app', displayName: 'app', depth: 1 }]
    })
    mocks.addRepoPath.mockResolvedValue(repo)
    mocks.fetchWorktrees.mockResolvedValue(true)
    mocks.scanNestedRepos.mockImplementation(async (_path, _connectionId, controls) => {
      controls?.onProgress?.(scan)
      return scan
    })
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddServerPath('git')

    expect(mocks.showNestedRepoReview).not.toHaveBeenCalled()
    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'git')
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith('docs', { requireAuthoritative: true })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith('docs', 'runtime_server_path')
  })
})
