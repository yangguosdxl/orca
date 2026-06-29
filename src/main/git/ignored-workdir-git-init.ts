import { readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { IFilesystemProvider, IGitProvider } from '../providers/types'
import { gitExecFileAsync } from './runner'

export const IGNORED_WORKDIR_GITIGNORE_BLOCK = '*\n!.gitignore\n'

type ExistingTextFile = { exists: true; content: string } | { exists: false; content: null }

type InitStep = 'init' | 'gitignore' | 'stage' | 'commit'

export function buildIgnoredWorkdirGitignore(existingContent: string | null): string {
  if (!existingContent) {
    return IGNORED_WORKDIR_GITIGNORE_BLOCK
  }
  const separator = existingContent.endsWith('\n') ? '' : '\n'
  return `${existingContent}${separator}${IGNORED_WORKDIR_GITIGNORE_BLOCK}`
}

export async function initializeIgnoredLocalGitRepo(repoPath: string): Promise<void> {
  const gitignorePath = join(repoPath, '.gitignore')
  const gitMetadataPath = join(repoPath, '.git')
  const existingGitignore = await readExistingLocalTextFile(gitignorePath)
  const hadGitMetadata = await localPathExists(gitMetadataPath)
  let wroteGitignore = false
  let step: InitStep = 'init'

  try {
    await gitExecFileAsync(['init'], { cwd: repoPath })
    step = 'gitignore'
    // Why: the bootstrap commit needs exactly one tracked file so future
    // worktrees preserve the "ignore the existing directory contents" rule.
    await writeFile(gitignorePath, buildIgnoredWorkdirGitignore(existingGitignore.content), 'utf-8')
    wroteGitignore = true
    step = 'stage'
    await gitExecFileAsync(['add', '-f', '.gitignore'], { cwd: repoPath })
    step = 'commit'
    await gitExecFileAsync(['commit', '-m', 'Initial commit'], { cwd: repoPath })
  } catch (error) {
    await rollbackLocalIgnoredGitInit({
      gitMetadataPath,
      gitignorePath,
      existingGitignore,
      hadGitMetadata,
      wroteGitignore
    })
    throw new Error(formatIgnoredGitInitError(step, error, false))
  }
}

export async function initializeIgnoredRemoteGitRepo({
  repoPath,
  gitignorePath,
  gitMetadataPath,
  gitProvider,
  filesystemProvider
}: {
  repoPath: string
  gitignorePath: string
  gitMetadataPath: string
  gitProvider: Pick<IGitProvider, 'exec'>
  filesystemProvider: Pick<IFilesystemProvider, 'readFile' | 'writeFile' | 'deletePath' | 'stat'>
}): Promise<void> {
  const existingGitignore = await readExistingRemoteTextFile(filesystemProvider, gitignorePath)
  const hadGitMetadata = await remotePathExists(filesystemProvider, gitMetadataPath)
  let wroteGitignore = false
  let step: InitStep = 'init'

  try {
    await gitProvider.exec(['init'], repoPath)
    step = 'gitignore'
    await filesystemProvider.writeFile(
      gitignorePath,
      buildIgnoredWorkdirGitignore(existingGitignore.content)
    )
    wroteGitignore = true
    step = 'stage'
    await gitProvider.exec(['add', '-f', '.gitignore'], repoPath)
    step = 'commit'
    await gitProvider.exec(['commit', '-m', 'Initial commit'], repoPath)
  } catch (error) {
    await rollbackRemoteIgnoredGitInit({
      filesystemProvider,
      gitMetadataPath,
      gitignorePath,
      existingGitignore,
      hadGitMetadata,
      wroteGitignore
    })
    throw new Error(formatIgnoredGitInitError(step, error, true))
  }
}

async function readExistingLocalTextFile(filePath: string): Promise<ExistingTextFile> {
  try {
    return { exists: true, content: await readFile(filePath, 'utf-8') }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false, content: null }
    }
    throw error
  }
}

async function readExistingRemoteTextFile(
  filesystemProvider: Pick<IFilesystemProvider, 'readFile'>,
  filePath: string
): Promise<ExistingTextFile> {
  try {
    const result = await filesystemProvider.readFile(filePath)
    if (result.isBinary) {
      throw new Error('Existing .gitignore is binary; cannot safely update it.')
    }
    return { exists: true, content: result.content }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false, content: null }
    }
    throw error
  }
}

async function rollbackLocalIgnoredGitInit(args: {
  gitMetadataPath: string
  gitignorePath: string
  existingGitignore: ExistingTextFile
  hadGitMetadata: boolean
  wroteGitignore: boolean
}): Promise<void> {
  await restoreLocalGitignore(args.gitignorePath, args.existingGitignore, args.wroteGitignore)
  if (!args.hadGitMetadata) {
    await rm(args.gitMetadataPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function rollbackRemoteIgnoredGitInit(args: {
  filesystemProvider: Pick<IFilesystemProvider, 'writeFile' | 'deletePath'>
  gitMetadataPath: string
  gitignorePath: string
  existingGitignore: ExistingTextFile
  hadGitMetadata: boolean
  wroteGitignore: boolean
}): Promise<void> {
  await restoreRemoteGitignore(
    args.filesystemProvider,
    args.gitignorePath,
    args.existingGitignore,
    args.wroteGitignore
  )
  if (!args.hadGitMetadata) {
    await args.filesystemProvider.deletePath(args.gitMetadataPath, true).catch(() => undefined)
  }
}

async function restoreLocalGitignore(
  gitignorePath: string,
  existingGitignore: ExistingTextFile,
  wroteGitignore: boolean
): Promise<void> {
  if (!wroteGitignore) {
    return
  }
  if (existingGitignore.exists) {
    await writeFile(gitignorePath, existingGitignore.content, 'utf-8').catch(() => undefined)
    return
  }
  await rm(gitignorePath, { force: true }).catch(() => undefined)
}

async function restoreRemoteGitignore(
  filesystemProvider: Pick<IFilesystemProvider, 'writeFile' | 'deletePath'>,
  gitignorePath: string,
  existingGitignore: ExistingTextFile,
  wroteGitignore: boolean
): Promise<void> {
  if (!wroteGitignore) {
    return
  }
  if (existingGitignore.exists) {
    await filesystemProvider
      .writeFile(gitignorePath, existingGitignore.content)
      .catch(() => undefined)
    return
  }
  await filesystemProvider.deletePath(gitignorePath, false).catch(() => undefined)
}

async function localPathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    return !isMissingPathError(error)
  }
}

async function remotePathExists(
  filesystemProvider: Pick<IFilesystemProvider, 'stat'>,
  filePath: string
): Promise<boolean> {
  try {
    await filesystemProvider.stat(filePath)
    return true
  } catch (error) {
    return !isMissingPathError(error)
  }
}

function formatIgnoredGitInitError(step: InitStep, error: unknown, remote: boolean): string {
  const message = error instanceof Error ? error.message : String(error)
  if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
    const command =
      'Run `git config --global user.name "Your Name"` and ' +
      '`git config --global user.email "you@example.com"`'
    return remote
      ? `Git author identity is not configured on the SSH host. ${command} on that host, then try again.`
      : `Git author identity is not configured. ${command}, then try again.`
  }
  const stepLabel =
    step === 'init'
      ? 'Failed to initialize git repository'
      : step === 'gitignore'
        ? 'Failed to write .gitignore'
        : step === 'stage'
          ? 'Failed to stage .gitignore'
          : 'Failed to create initial commit'
  return `${stepLabel}: ${message}`
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const maybe = error as { code?: unknown; message?: unknown }
  return (
    maybe.code === 'ENOENT' ||
    /not found|no such file or directory|ENOENT/i.test(String(maybe.message ?? ''))
  )
}
