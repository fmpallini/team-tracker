// e2e/update-check-off.spec.ts — the daily GitHub version check is the app's only network request. Turned off in
// Preferences → About, a launch must make none (the check runs at launch, before any document is open).
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { blockUpdateCheck } from './helpers'

async function launchAndCountChecks(page: Page, off: boolean): Promise<number> {
  let calls = 0
  page.on('request', (r) => { if (r.url().startsWith('https://api.github.com/')) calls++ })
  await blockUpdateCheck(page)
  if (off) await page.addInitScript(() => localStorage.setItem('tt-update-check-off', '1'))
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await expect(page.locator('.tt-start-screen')).toBeVisible()
  await page.waitForTimeout(500)
  return calls
}

test('a launch checks GitHub for a new version by default', async ({ page }) => {
  expect(await launchAndCountChecks(page, false)).toBe(1)
})

test('with the check turned off, a launch makes no request at all', async ({ page }) => {
  expect(await launchAndCountChecks(page, true)).toBe(0)
})
