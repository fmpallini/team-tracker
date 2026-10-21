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

/** Lock/Close (the header lock button): writes the file now and returns to the start screen. */
export async function lockClose(page: Page): Promise<void> {
  await page.locator('.tt-btn-close-file').click()
  await expect(page.locator('.tt-start-screen')).toBeVisible()
}

/** Start screen -> "Reopen last" -> password -> the shell. */
export async function reopenLast(page: Page, password: string): Promise<void> {
  await page.getByRole('button', { name: /Reopen last/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-password"]').fill(password)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/** Forgets the browser's copy of every document, as "clear site data" would: the next open can only use the file. */
export async function clearBrowserCopy(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('team-tracker-live')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('could not delete the live database'))
    req.onblocked = () => resolve()
  }))
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
