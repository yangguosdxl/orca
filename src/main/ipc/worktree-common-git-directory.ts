import { basename, dirname, isAbsolute, resolve } from 'path'
import { readFile, stat } from 'fs/promises'
import type { Repo } from '../../shared/types'

export async function resolveWorktreeCommonGitDirectory(repo: Repo): Promise<string | null> {
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
