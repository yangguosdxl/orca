import { describe, expect, it } from 'vitest'
import { shouldWaitForAsyncQuitCleanup } from './update-quit-policy'

describe('update quit policy', () => {
  it('does not block updater installs on async daemon disconnect cleanup', () => {
    expect(
      shouldWaitForAsyncQuitCleanup({
        daemonDisconnectDone: false,
        isUpdaterInstallQuit: true
      })
    ).toBe(false)
  })

  it('waits for async cleanup during ordinary quits until daemon disconnect has completed', () => {
    expect(
      shouldWaitForAsyncQuitCleanup({
        daemonDisconnectDone: false,
        isUpdaterInstallQuit: false
      })
    ).toBe(true)
    expect(
      shouldWaitForAsyncQuitCleanup({
        daemonDisconnectDone: true,
        isUpdaterInstallQuit: false
      })
    ).toBe(false)
  })
})
