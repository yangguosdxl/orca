import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type OrcaPage = Parameters<typeof waitForSessionReady>[0]

async function openSettings(page: OrcaPage, initialSearchQuery = ''): Promise<void> {
  await page.evaluate((query) => {
    const state = window.__store!.getState()
    state.setSettingsSearchQuery(query)
    state.openSettingsPage()
  }, initialSearchQuery)
}

test.describe('Settings search autofocus', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('focuses search on open without selecting existing text', async ({ orcaPage }) => {
    const initialSearchQuery = 'terminal'

    await openSettings(orcaPage, initialSearchQuery)

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await expect(searchInput).toHaveValue(initialSearchQuery)
    await expect(searchInput).toBeFocused()

    const selection = await searchInput.evaluate((element) => {
      const input = element as HTMLInputElement
      return {
        start: input.selectionStart,
        end: input.selectionEnd
      }
    })
    expect(selection.start).toBe(selection.end)
  })
})
