import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'

const webRuntimeClientMocks = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('./web-runtime-client', () => ({
  WebRuntimeClient: vi.fn().mockImplementation(function () {
    return {
      call: webRuntimeClientMocks.call,
      close: webRuntimeClientMocks.close,
      subscribe: webRuntimeClientMocks.subscribe
    }
  })
}))

const WEB_RUNTIME_ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installBrowserGlobals(userAgent = 'Linux'): {
  window: Window & typeof globalThis
  storage: MemoryStorage
} {
  const storage = new MemoryStorage()
  const windowStub = {
    localStorage: storage,
    location: {
      protocol: 'http:',
      reload: vi.fn()
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  } as unknown as Window & typeof globalThis
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('navigator', { userAgent, hardwareConcurrency: 8 })
  return { window: windowStub, storage }
}

async function installApi(userAgent?: string): Promise<{
  api: PreloadApi
  storage: MemoryStorage
  window: Window & typeof globalThis
}> {
  const globals = installBrowserGlobals(userAgent)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  return {
    api: globals.window.api,
    storage: globals.storage,
    window: globals.window
  }
}

function makeStoredRuntimeEnvironment(): unknown {
  return {
    id: 'web-test',
    name: 'Test Runtime',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws-web-test',
    endpoints: [
      {
        id: 'ws-web-test',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:1234',
        deviceToken: 'device-token',
        publicKeyB64: 'public-key'
      }
    ]
  }
}

describe('web keybindings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
    webRuntimeClientMocks.call.mockReset()
    webRuntimeClientMocks.close.mockReset()
    webRuntimeClientMocks.subscribe.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns snapshots and persists customized bindings in browser storage', async () => {
    const { api, storage } = await installApi('Linux')

    const initial = await api.keybindings.get()
    expect(initial.platform).toBe('linux')
    expect(initial.overrides).toEqual({})

    const updated = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })

    expect(updated.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
    expect(storage.getItem('orca.web.keybindings.v1')).toContain('worktree.palette')

    const disabled = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: []
    })
    expect(disabled.overrides['worktree.palette']).toEqual([])

    const reset = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: null
    })
    expect(reset.overrides['worktree.palette']).toBeUndefined()
  })

  it('rejects conflicts before mutating browser storage', async () => {
    const { api } = await installApi('Linux')

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })

    await expect(
      api.keybindings.setAction({
        actionId: 'worktree.quickOpen',
        bindings: ['Ctrl+Alt+J']
      })
    ).rejects.toThrow('conflicts')

    const snapshot = await api.keybindings.get()
    expect(snapshot.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
    expect(snapshot.overrides['worktree.quickOpen']).toBeUndefined()
  })

  it('notifies listeners when web keybindings change', async () => {
    const { api } = await installApi('Linux')
    const listener = vi.fn()
    const unsubscribe = api.keybindings.onChanged(listener)

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({ 'worktree.palette': ['Ctrl+Alt+J'] })
      })
    )

    unsubscribe()
  })
})

describe('web repos preload API', () => {
  beforeEach(() => {
    vi.resetModules()
    webRuntimeClientMocks.call.mockReset()
    webRuntimeClientMocks.close.mockReset()
    webRuntimeClientMocks.subscribe.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes git username lookup through the paired runtime', async () => {
    const { api, storage } = await installApi('Linux')
    storage.setItem(
      WEB_RUNTIME_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify(makeStoredRuntimeEnvironment())
    )
    webRuntimeClientMocks.call.mockResolvedValueOnce({
      ok: true,
      result: { username: 'remote-user' },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(api.repos.getGitUsername({ repoId: 'repo-1' })).resolves.toBe('remote-user')

    expect(webRuntimeClientMocks.call).toHaveBeenCalledWith(
      'repo.gitUsername',
      { repo: 'repo-1' },
      { timeoutMs: undefined }
    )
  })
})
