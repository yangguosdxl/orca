import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

type SleepWakeTerminalDebug = {
  activeTabId: string | null
  activeWorktreeId: string | null
  tabs: {
    id: string
    ptyId?: string
    generation?: number
    pendingActivationSpawn?: boolean | number
  }[]
  ptyIdsByTabId: Record<string, string[]>
  ptyIdsByLeafIdByTabId: Record<string, Record<string, string>>
}

async function sleepWorktreeTerminals(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    const state = store.getState()
    await state.shutdownWorktreeBrowsers(id)
    await state.shutdownWorktreeTerminals(id, { keepIdentifiers: true })
  }, worktreeId)
}

async function readLivePtyCountForWorktree(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return 0
    }
    const state = store.getState()
    const tabs = state.tabsByWorktree[id] ?? []
    return tabs.reduce((count, tab) => count + (state.ptyIdsByTabId[tab.id]?.length ?? 0), 0)
  }, worktreeId)
}

async function readSleepWakeTerminalDebug(
  page: Page,
  worktreeId: string
): Promise<SleepWakeTerminalDebug> {
  return page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return {
        activeTabId: null,
        activeWorktreeId: null,
        tabs: [],
        ptyIdsByTabId: {},
        ptyIdsByLeafIdByTabId: {}
      }
    }
    const state = store.getState()
    const tabs = state.tabsByWorktree[id] ?? []
    return {
      activeTabId: state.activeTabId,
      activeWorktreeId: state.activeWorktreeId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        ptyId: tab.ptyId,
        generation: tab.generation,
        pendingActivationSpawn: tab.pendingActivationSpawn
      })),
      ptyIdsByTabId: Object.fromEntries(
        tabs.map((tab) => [tab.id, state.ptyIdsByTabId[tab.id] ?? []])
      ),
      ptyIdsByLeafIdByTabId: Object.fromEntries(
        tabs.map((tab) => [tab.id, state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}])
      )
    }
  }, worktreeId)
}

async function mainSnapshotContains(page: Page, ptyId: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ({ targetPtyId, expectedText }) => {
      const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
        scrollbackRows: 200
      })
      return snapshot?.data.includes(expectedText) ?? false
    },
    { targetPtyId: ptyId, expectedText: text }
  )
}

function richSleepWakePayload(runId: string): string {
  return [
    '\x1b[?2026h',
    '\x1b[2J\x1b[H',
    '╭────────────────────────────╮',
    `│ sleep wake restore ${runId.slice(0, 8)} 😀 │`,
    '╰────────────────────────────╯',
    `SLEEP_WAKE_RESTORE_${runId}`,
    '\x1b[?2026l'
  ].join('\r\n')
}

function nodeWriteCodePointPayloadCommand(payload: string): string {
  const codePoints = [...payload].map((char) => char.codePointAt(0) ?? 0)
  return `node -e "process.stdout.write(String.fromCodePoint(...${JSON.stringify(codePoints)}))"`
}

test.describe('Terminal sleep wake restore', () => {
  test('restores slept terminal output and accepts fresh input after wake', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'sleep wake restore needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const restoreMarker = `SLEEP_WAKE_RESTORE_${runId}`
    const freshMarker = `SLEEP_WAKE_FRESH_${runId}`
    await sendToTerminal(
      orcaPage,
      ptyId,
      `${nodeWriteCodePointPayloadCommand(richSleepWakePayload(runId))}\r`
    )
    await waitForTerminalOutput(orcaPage, restoreMarker, 10_000, 20_000)
    const beforeSleepDebug = await readSleepWakeTerminalDebug(orcaPage, secondWorktreeId)
    expect(await mainSnapshotContains(orcaPage, ptyId, restoreMarker)).toBe(true)

    await switchToWorktree(orcaPage, firstWorktreeId)
    await sleepWorktreeTerminals(orcaPage, secondWorktreeId)
    const afterSleepDebug = await readSleepWakeTerminalDebug(orcaPage, secondWorktreeId)
    await expect
      .poll(() => readLivePtyCountForWorktree(orcaPage, secondWorktreeId), {
        timeout: 10_000,
        message: 'sleep did not release live PTYs for the background worktree'
      })
      .toBe(0)

    await switchToWorktree(orcaPage, secondWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const awakePtyId = await waitForActivePanePtyId(orcaPage)
    const afterWakeDebug = await readSleepWakeTerminalDebug(orcaPage, secondWorktreeId)
    const awakeTerminalContent = await getTerminalContent(orcaPage, 20_000)
    expect
      .soft(awakeTerminalContent.includes(restoreMarker), {
        message: JSON.stringify(
          {
            ptyId,
            awakePtyId,
            beforeSleepDebug,
            afterSleepDebug,
            afterWakeDebug,
            terminalTail: awakeTerminalContent.slice(-2000)
          },
          null,
          2
        )
      })
      .toBe(true)
    await waitForTerminalOutput(orcaPage, restoreMarker, 15_000, 20_000)
    await sendToTerminal(orcaPage, awakePtyId, `printf '\\n${freshMarker}\\n'\r`)
    await waitForTerminalOutput(orcaPage, freshMarker, 10_000, 20_000)
  })
})
