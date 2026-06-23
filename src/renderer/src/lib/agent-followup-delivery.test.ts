import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn()
}))

describe('sendFollowupPromptWhenAgentReady', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(inspectRuntimeTerminalProcess).mockReset()
    vi.mocked(sendRuntimePtyInputVerified).mockReset()
    vi.mocked(sendRuntimePtyInputVerified).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the follow-up once the expected agent owns the PTY', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'codex',
      hasChildProcesses: false
    })

    await expect(
      sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        expectedProcess: 'codex',
        prompt: 'review this',
        settings: { activeRuntimeEnvironmentId: 'runtime-1' }
      })
    ).resolves.toBe(true)

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      'pty-1',
      'review this\r'
    )
  })

  it('honors the readiness deadline when process inspection hangs', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockReturnValue(new Promise(() => {}))

    const promise = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'codex',
      prompt: 'review this',
      settings: { activeRuntimeEnvironmentId: 'runtime-1' }
    })

    await vi.advanceTimersByTimeAsync(4499)
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).resolves.toBe(false)
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })
})
