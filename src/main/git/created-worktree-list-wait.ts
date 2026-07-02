import { setTimeout as delay } from 'timers/promises'
import type { GitWorktreeInfo } from '../../shared/types'

const DEFAULT_CREATED_WORKTREE_LIST_WAIT_ATTEMPTS = 16
const DEFAULT_CREATED_WORKTREE_LIST_WAIT_DELAY_MS = 100

export type CreatedWorktreeListWaitResult = {
  created: GitWorktreeInfo | undefined
  worktrees: GitWorktreeInfo[]
  attempts: number
}

export type CreatedWorktreeListWaitOptions = {
  readWorktrees: () => Promise<GitWorktreeInfo[]>
  findCreatedWorktree: (worktrees: GitWorktreeInfo[]) => GitWorktreeInfo | undefined
  maxAttempts?: number
  delayMs?: number
}

type CreatedWorktreePathOrNameMatchOptions = {
  expectedPath: string
  expectedName: string
  branchName: string
  pathsEqual: (actualPath: string, expectedPath: string) => boolean
}

export function branchMatchesCreatedWorktree(
  branch: string | undefined,
  branchName: string
): boolean {
  return Boolean(branch && (branch === branchName || branch.endsWith(branchName)))
}

export function pathNameMatchesCreatedWorktree(path: string, expectedName: string): boolean {
  return path.replace(/\\/g, '/').endsWith(`/${expectedName}`)
}

export function matchesCreatedWorktreeByPathOrBranchName(
  worktree: GitWorktreeInfo,
  args: CreatedWorktreePathOrNameMatchOptions
): boolean {
  return (
    args.pathsEqual(worktree.path, args.expectedPath) ||
    // 为什么：Git 可能把刚创建的 Windows 路径规范化成另一个等价前缀。
    (branchMatchesCreatedWorktree(worktree.branch, args.branchName) &&
      pathNameMatchesCreatedWorktree(worktree.path, args.expectedName))
  )
}

export async function waitForCreatedWorktreeInList({
  readWorktrees,
  findCreatedWorktree,
  maxAttempts = DEFAULT_CREATED_WORKTREE_LIST_WAIT_ATTEMPTS,
  delayMs = DEFAULT_CREATED_WORKTREE_LIST_WAIT_DELAY_MS
}: CreatedWorktreeListWaitOptions): Promise<CreatedWorktreeListWaitResult> {
  const attemptCount = Math.max(1, maxAttempts)
  let lastWorktrees: GitWorktreeInfo[] = []

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    lastWorktrees = await readWorktrees()
    const created = findCreatedWorktree(lastWorktrees)
    if (created) {
      return { created, worktrees: lastWorktrees, attempts: attempt }
    }
    if (attempt < attemptCount) {
      // 为什么：git worktree add 成功返回后，部分平台的 worktree 列表可能短暂滞后。
      await delay(delayMs)
    }
  }

  return { created: undefined, worktrees: lastWorktrees, attempts: attemptCount }
}
