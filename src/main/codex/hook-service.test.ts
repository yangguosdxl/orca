import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

let tmpHome: string
let userDataDir: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-user-data-'))
  homedirMock.mockReturnValue(tmpHome)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('CodexHookService', () => {
  it('installs PermissionRequest with trust so Codex approval prompts reach Orca', () => {
    const status = new CodexHookService().install()

    expect(status.state).toBe('installed')

    const hooksConfig = JSON.parse(
      readFileSync(join(tmpHome, '.codex', 'hooks.json'), 'utf-8')
    ) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }

    expect(Object.keys(hooksConfig.hooks).sort()).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(hooksConfig.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command).toContain('agent-hooks')
    expect(hooksConfig.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command).toContain('codex-hook')

    const trustConfig = readFileSync(join(tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(trustConfig).toContain(':permission_request:0:0')
  })

  it('installs Orca status hooks in the Codex profile instead of global hooks.json', () => {
    const service = new CodexHookService()
    const status = service.installProfile()

    expect(status.state).toBe('installed')

    const profileConfig = readFileSync(
      join(tmpHome, '.codex', 'orca-agent-status.config.toml'),
      'utf-8'
    )
    expect(profileConfig).toContain('# BEGIN ORCA AGENT STATUS HOOKS')
    expect(profileConfig).toContain('[[hooks.PermissionRequest]]')
    expect(profileConfig).toContain(':permission_request:0:0')
    expect(profileConfig).toContain('codex-hook')
    expect(service.getStatus().state).toBe('not_installed')
  })

  it('keeps the Codex profile hook-only and preserves user provider config', () => {
    const service = new CodexHookService()
    const baseConfigPath = join(tmpHome, '.codex', 'config.toml')
    mkdirSync(join(tmpHome, '.codex'), { recursive: true })
    const baseConfig = [
      'model_provider = "amazon-bedrock"',
      '',
      '[model_providers.amazon-bedrock]',
      'name = "Amazon Bedrock"',
      'base_url = "https://bedrock-runtime.us-west-2.amazonaws.com"',
      'env_key = "AWS_BEARER_TOKEN_BEDROCK"',
      ''
    ].join('\n')
    writeFileSync(baseConfigPath, baseConfig)

    const status = service.installProfile()

    expect(status.state).toBe('installed')
    expect(readFileSync(baseConfigPath, 'utf-8')).toBe(baseConfig)
    const profileConfig = readFileSync(
      join(tmpHome, '.codex', 'orca-agent-status.config.toml'),
      'utf-8'
    )
    expect(profileConfig).toContain('# BEGIN ORCA AGENT STATUS HOOKS')
    expect(profileConfig).not.toContain('model_provider')
    expect(profileConfig).not.toContain('model_providers')
    expect(profileConfig).not.toContain('env_key')
  })

  it('removes only the Orca-managed Codex profile block', () => {
    const service = new CodexHookService()
    service.installProfile()
    const profilePath = join(tmpHome, '.codex', 'orca-agent-status.config.toml')
    const withUserConfig = `${readFileSync(profilePath, 'utf-8')}\nmodel = "gpt-5.5"\n`
    writeFileSync(profilePath, withUserConfig)

    const status = service.removeProfile()

    expect(status.state).toBe('not_installed')
    const remaining = readFileSync(profilePath, 'utf-8')
    expect(remaining).not.toContain('ORCA AGENT STATUS HOOKS')
    expect(remaining).toContain('model = "gpt-5.5"')
  })

  it('does not create legacy global hooks.json when profile migration cleanup has nothing to remove', () => {
    const service = new CodexHookService()
    service.installProfile()

    const status = service.remove()

    expect(status.state).toBe('not_installed')
    expect(existsSync(join(tmpHome, '.codex', 'hooks.json'))).toBe(false)
  })
})
