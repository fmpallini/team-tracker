// e2e/helpers.ts — shared flows used across the e2e suite.
import type { Page, BrowserContext } from '@playwright/test'
import { expect } from '@playwright/test'

export async function createEncryptedDoc(page: Page, password: string): Promise<void> {
  await page.getByRole('button', { name: /Create new/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-password"]').fill(password)
  await dialog.locator('input[name="tt-password-confirm"]').fill(password)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/**
 * `src/main.ts` fires a real `fetch` to the GitHub releases API on every
 * boot (`runUpdateCheck`), unthrottled in a fresh browser context since
 * `localStorage`'s `LAST_CHECK_STORAGE_KEY` starts empty. Left alone, every
 * e2e run hits the live API — under a full parallel test run (or CI) that
 * reliably trips GitHub's unauthenticated rate limit, and Chromium logs a
 * "Failed to load resource: 403" console message for the failed fetch
 * *regardless* of how gracefully `checkForUpdate` handles the response,
 * which then fails any test asserting on `console` output (e.g.
 * smoke.spec.ts). Fulfilling with a synthetic "no update available" response
 * keeps the check's own code path real while decoupling every other test
 * from a flaky, rate-limited external dependency. Must be installed before
 * `goto` — call on the page (or context, for multi-page tests) before
 * navigating.
 */
export async function blockUpdateCheck(target: Page | BrowserContext): Promise<void> {
  await target.route('https://api.github.com/repos/**/releases/latest', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.0.1' }) })
  )
}
