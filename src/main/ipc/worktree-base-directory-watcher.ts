import { basename, dirname, isAbsolute, normalize, resolve } from 'path'
import { readFile, realpath, stat } from 'fs/promises'
import type { BrowserWindow } from 'electron'
import type { AsyncSubscription } from '@parcel/watcher'
import type { Store } from '../persistence'
import type { GlobalSettings, Repo } from '../../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'
import { notifyWorktreesChanged } from './worktree-remote'
import {
  matchingWorktreeBaseRepoIds,
  type WorktreeBaseRepoWatchConfig,
  type WorktreeBaseWatchKind,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

type ActiveWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  subscription: AsyncSubscription
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingRepoIds: Set<string>
}

const WATCH_DEBOUNCE_MS = 250
const activeWatches = new Map<string, ActiveWatch>()
const missingRootWarnings = new Set<string>()
const skippedWslWarnings = new Set<string>()
let syncGeneration = 0
let scheduledSync: ReturnType<typeof setTimeout> | null = null

function isLocalGitRepo(repo: Repo): boolean {
  return !isFolderRepo(repo) && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

function normalizeWatchKey(pathValue: string): string {
  return normalizeRuntimePathForComparison(normalize(pathValue))
}

async function canonicalizeExistingPath(pathValue: string): Promise<string> {
  try {
    return await realpath(pathValue)
  } catch {
    return normalize(pathValue)
  }
}

function scheduleNotification(watch: ActiveWatch, repoIds: readonly string[]): void {
  for (const repoId of repoIds) {
    watch.pendingRepoIds.add(repoId)
  }
  if (watch.notifyTimer) {
    clearTimeout(watch.notifyTimer)
  }
  watch.notifyTimer = setTimeout(() => {
    watch.notifyTimer = null
    const pending = [...watch.pendingRepoIds]
    watch.pendingRepoIds.clear()
    for (const repoId of pending) {
      notifyWorktreesChanged(watch.mainWindow, repoId)
    }
  }, WATCH_DEBOUNCE_MS)
}

async function subscribeTarget(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow
): Promise<ActiveWatch> {
  const watcher = await import('@parcel/watcher')
  let activeWatch: ActiveWatch | null = null
  const subscription = await watcher.subscribe(
    target.path,
    (error, events) => {
      const currentWatch = activeWatches.get(target.key) ?? activeWatch
      if (!currentWatch) {
        return
      }
      if (error) {
        console.warn(`[worktree-base-watcher] watcher failed for ${target.path}:`, error)
        scheduleNotification(currentWatch, [...currentWatch.repos.keys()])
        return
      }
      const repoIds = new Set<string>()
      for (const event of events) {
        for (const repoId of matchingWorktreeBaseRepoIds(currentWatch, event)) {
          repoIds.add(repoId)
        }
      }
      if (repoIds.size > 0) {
        scheduleNotification(currentWatch, [...repoIds])
      }
    },
    {
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.cache/**'],
      ...(process.platform === 'win32' ? { backend: 'windows' as const } : {})
    }
  )
  activeWatch = {
    ...target,
    mainWindow,
    subscription,
    notifyTimer: null,
    pendingRepoIds: new Set()
  }
  return activeWatch
}

async function resolveGitCommonDir(repo: Repo): Promise<string | null> {
  const dotGitPath = resolve(repo.path, '.git')
  try {
    const dotGitStat = await stat(dotGitPath)
    if (dotGitStat.isDirectory()) {
      return dotGitPath
    }
    if (!dotGitStat.isFile()) {
      return null
    }
    const content = await readFile(dotGitPath, 'utf8')
    const gitDir = content.match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim()
    if (!gitDir) {
      return null
    }
    const resolvedGitDir = isAbsolute(gitDir) ? gitDir : resolve(repo.path, gitDir)
    return basename(dirname(resolvedGitDir)) === 'worktrees'
      ? resolve(resolvedGitDir, '..', '..')
      : resolvedGitDir
  } catch (error) {
    console.warn(`[worktree-base-watcher] cannot resolve git common dir for ${repo.id}:`, error)
    return null
  }
}

async function addTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  kind: WorktreeBaseWatchKind,
  pathValue: string,
  config: WorktreeBaseRepoWatchConfig
): Promise<void> {
  const watchedPath = await canonicalizeExistingPath(pathValue)
  const key = `${kind}:${normalizeWatchKey(watchedPath)}`
  const existing = targets.get(key)
  if (existing) {
    existing.repos.set(config.repoId, config)
    return
  }
  targets.set(key, {
    key,
    kind,
    path: watchedPath,
    repos: new Map([[config.repoId, config]])
  })
}

async function maybeAddBaseTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  repo: Repo,
  settings: GlobalSettings
): Promise<void> {
  const pathSettings = getWorktreePathSettings(repo, settings)
  const workspaceRoot = computeWorkspaceRoot(repo.path, pathSettings)
  if (isWslUncPath(workspaceRoot) || isWslUncPath(repo.path)) {
    const key = `${repo.id}:${workspaceRoot}`
    if (!skippedWslWarnings.has(key)) {
      skippedWslWarnings.add(key)
      console.warn(
        `[worktree-base-watcher] skipping WSL worktree root watcher for ${workspaceRoot}`
      )
    }
    return
  }

  const config = {
    repoId: repo.id,
    repoName: getRuntimePathBasename(repo.path).replace(/\.git$/, ''),
    nestWorkspaces: pathSettings.nestWorkspaces
  }
  try {
    const rootStat = await stat(workspaceRoot)
    if (rootStat.isDirectory()) {
      await addTarget(targets, 'base', workspaceRoot, config)
    }
  } catch {
    const key = normalizeWatchKey(workspaceRoot)
    if (!missingRootWarnings.has(key)) {
      missingRootWarnings.add(key)
      console.warn(`[worktree-base-watcher] worktree root unavailable: ${workspaceRoot}`)
    }
  }

  const commonDir = await resolveGitCommonDir(repo)
  if (commonDir) {
    await addTarget(targets, 'git-common', commonDir, config)
  }
}

async function buildTargets(store: Store): Promise<Map<string, WorktreeBaseWatchTarget>> {
  const settings = store.getSettings()
  const targets = new Map<string, WorktreeBaseWatchTarget>()
  for (const repo of store.getRepos()) {
    if (!isLocalGitRepo(repo)) {
      continue
    }
    await maybeAddBaseTarget(targets, repo, settings)
  }
  return targets
}

async function replaceWatch(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow
): Promise<void> {
  const previous = activeWatches.get(target.key)
  if (previous) {
    previous.repos = target.repos
    previous.mainWindow = mainWindow
    return
  }
  try {
    const activeWatch = await subscribeTarget(target, mainWindow)
    activeWatches.set(target.key, activeWatch)
  } catch (error) {
    console.warn(`[worktree-base-watcher] failed to watch ${target.path}:`, error)
  }
}

async function removeWatch(key: string): Promise<void> {
  const watch = activeWatches.get(key)
  if (!watch) {
    return
  }
  activeWatches.delete(key)
  if (watch.notifyTimer) {
    clearTimeout(watch.notifyTimer)
  }
  await watch.subscription.unsubscribe().catch((error) => {
    console.warn(`[worktree-base-watcher] failed to unwatch ${watch.path}:`, error)
  })
}

export async function syncWorktreeBaseDirectoryWatchers(
  store: Store,
  mainWindow: BrowserWindow
): Promise<void> {
  const generation = ++syncGeneration
  const targets = await buildTargets(store)
  if (generation !== syncGeneration) {
    return
  }
  for (const key of activeWatches.keys()) {
    if (!targets.has(key)) {
      await removeWatch(key)
    }
  }
  for (const target of targets.values()) {
    await replaceWatch(target, mainWindow)
  }
}

export function scheduleWorktreeBaseDirectoryWatcherSync(
  store: Store,
  mainWindow: BrowserWindow
): void {
  if (scheduledSync) {
    clearTimeout(scheduledSync)
  }
  scheduledSync = setTimeout(() => {
    scheduledSync = null
    void syncWorktreeBaseDirectoryWatchers(store, mainWindow)
  }, 100)
}

export async function disposeWorktreeBaseDirectoryWatchers(): Promise<void> {
  syncGeneration++
  if (scheduledSync) {
    clearTimeout(scheduledSync)
    scheduledSync = null
  }
  await Promise.all([...activeWatches.keys()].map((key) => removeWatch(key)))
  missingRootWarnings.clear()
  skippedWslWarnings.clear()
}
