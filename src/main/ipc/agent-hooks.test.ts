import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: cover the agentStatus:drop IPC handler — it must propagate the
// renderer dismissal to clearPaneState so the on-disk last-status file
// evicts the entry. Gated on experimentalAgentDashboard so a non-opted-in
// renderer cannot churn the persistence path.

const clearPaneState = vi.fn()
const getStatusSnapshot = vi.fn()
const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const removeHandler = vi.fn()
const removeAllListeners = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    },
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      onHandlers.set(channel, handler)
    },
    removeHandler,
    removeAllListeners
  }
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    clearPaneState,
    getStatusSnapshot
  }
}))

vi.mock('../claude/hook-service', () => ({
  claudeHookService: { getStatus: vi.fn(() => ({ agent: 'claude', state: 'absent' })) }
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { getStatus: vi.fn(() => ({ agent: 'codex', state: 'absent' })) }
}))
vi.mock('../gemini/hook-service', () => ({
  geminiHookService: { getStatus: vi.fn(() => ({ agent: 'gemini', state: 'absent' })) }
}))
vi.mock('../cursor/hook-service', () => ({
  cursorHookService: { getStatus: vi.fn(() => ({ agent: 'cursor', state: 'absent' })) }
}))

beforeEach(() => {
  clearPaneState.mockReset()
  getStatusSnapshot.mockReset()
  onHandlers.clear()
  handleHandlers.clear()
  removeHandler.mockReset()
  removeAllListeners.mockReset()
})

afterEach(() => {
  vi.resetModules()
})

describe('agentStatus:getSnapshot IPC', () => {
  it('returns the hook cache snapshot when the experimental dashboard is on', async () => {
    const snapshot = [
      {
        paneKey: 'tab-1:0',
        state: 'done',
        prompt: 'p',
        agentType: 'claude',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_699_999_999_000
      }
    ]
    getStatusSnapshot.mockReturnValue(snapshot)
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    const store = {
      getSettings: () => ({ experimentalAgentDashboard: true })
    } as { getSettings: () => { experimentalAgentDashboard: boolean } }
    registerAgentHookHandlers(store as unknown as Parameters<typeof registerAgentHookHandlers>[0])

    const handler = handleHandlers.get('agentStatus:getSnapshot')
    expect(handler).toBeDefined()
    expect(handler!({})).toEqual(snapshot)
  })

  it('returns an empty snapshot when the experimental dashboard is off', async () => {
    getStatusSnapshot.mockReturnValue([{ paneKey: 'tab-1:0' }])
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    const store = {
      getSettings: () => ({ experimentalAgentDashboard: false })
    } as { getSettings: () => { experimentalAgentDashboard: boolean } }
    registerAgentHookHandlers(store as unknown as Parameters<typeof registerAgentHookHandlers>[0])

    const handler = handleHandlers.get('agentStatus:getSnapshot')!
    expect(handler({})).toEqual([])
    expect(getStatusSnapshot).not.toHaveBeenCalled()
  })
})

describe('agentStatus:drop IPC', () => {
  it('forwards drop to clearPaneState when the experimental dashboard is on', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    const store = {
      getSettings: () => ({ experimentalAgentDashboard: true })
    } as { getSettings: () => { experimentalAgentDashboard: boolean } }
    registerAgentHookHandlers(store as unknown as Parameters<typeof registerAgentHookHandlers>[0])

    const handler = onHandlers.get('agentStatus:drop')
    expect(handler).toBeDefined()
    handler!({}, 'tab-1:0')
    expect(clearPaneState).toHaveBeenCalledWith('tab-1:0')
  })

  it('no-ops when the experimental dashboard is off (the gate prevents persistence churn)', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    const store = {
      getSettings: () => ({ experimentalAgentDashboard: false })
    } as { getSettings: () => { experimentalAgentDashboard: boolean } }
    registerAgentHookHandlers(store as unknown as Parameters<typeof registerAgentHookHandlers>[0])

    onHandlers.get('agentStatus:drop')!({}, 'tab-1:0')
    expect(clearPaneState).not.toHaveBeenCalled()
  })

  it('rejects non-string paneKey (defensive against a malformed renderer message)', async () => {
    const { registerAgentHookHandlers } = await import('./agent-hooks')
    const store = {
      getSettings: () => ({ experimentalAgentDashboard: true })
    } as { getSettings: () => { experimentalAgentDashboard: boolean } }
    registerAgentHookHandlers(store as unknown as Parameters<typeof registerAgentHookHandlers>[0])

    const handler = onHandlers.get('agentStatus:drop')!
    const bad: unknown[] = [123, undefined, '', null, {}, []]
    for (const value of bad) {
      expect(() => handler({}, value)).not.toThrow()
    }
    expect(clearPaneState).not.toHaveBeenCalled()
  })
})
