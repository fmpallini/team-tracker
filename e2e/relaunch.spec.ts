// e2e/relaunch.spec.ts — src/main.ts's onDocumentOpened() guards a second
// open while one is already open (File Handling API re-launch, e.g. a fresh
// .tmv double-click while `focus-existing` reuses this same tab), and its
// onBeforeUnload handler fires a save without awaiting it. Both are
// documented with long WHY comments in main.ts but had no test proving them
// — this closes that gap using the real File System Access API (OPFS-backed,
// see opfs-shim.ts) and a simulated File Handling API launch (see
// launch-queue-shim.ts).
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { installLaunchQueueCapture, relaunchWithFile } from './launch-queue-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

async function addTeam(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('.tt-team-add-btn').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test.describe('second-open guard (src/main.ts onDocumentOpened)', () => {
  const PASSWORD = 'e2e-relaunch-password'

  test('re-launching the SAME already-open file toasts and keeps in-memory state instead of reloading from disk', async ({ page }) => {
    await installOpfsPickerShim(page)
    await installLaunchQueueCapture(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Dirty, unsaved edit — if the guard didn't short-circuit and instead
    // reloaded from disk, this would be silently lost.
    await addTeam(page, 'Alpha')
    await expect(page.locator('.tt-save-pill[data-state="dirty"]')).toBeVisible()

    // The launch consumer still has to decrypt the file before onDocumentOpened
    // even runs its sameEntry() guard (src/ui/start.ts's openAndDecrypt) — so a
    // second launch of the very same file still re-prompts for the password.
    // The guard's job is what happens *after* that succeeds: it must not then
    // discard the in-memory session and swap in what it just re-read from disk.
    await relaunchWithFile(page, 'team-tracker.tmv')
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()

    await expect(page.locator('.tt-toast')).toHaveText('This file is already open')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The unsaved edit is still here — proves nothing was torn down/reloaded.
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Alpha')
  })

  test('re-launching a DIFFERENT file saves the previous document before swapping to the new one', async ({ page }) => {
    await installOpfsPickerShim(page)
    await installLaunchQueueCapture(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Clone A's pristine bytes under a second, distinct OPFS entry — same
    // password, different file identity (isSameEntry sees these as unrelated
    // handles even though today their ciphertext matches byte-for-byte).
    const pristine = await readOpfsFile(page, 'team-tracker.tmv')
    await writeOpfsFile(page, 'team-tracker-2.tmv', pristine)

    // Dirty, unsaved edit on A — never explicitly saved.
    await addTeam(page, 'Alpha')
    await expect(page.locator('.tt-save-pill[data-state="dirty"]')).toBeVisible()

    await relaunchWithFile(page, 'team-tracker-2.tmv')
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()

    // B is a fresh document — A's team must not leak across the swap.
    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-team-item .tt-team-name', { hasText: 'Alpha' })).toHaveCount(0)

    // Reopen A directly (not "Reopen last" — that now points at B) and prove
    // the dirty edit landed on disk before the swap tore A down.
    await page.click('.tt-btn-close-file')
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    await setNextOpenName(page, 'team-tracker.tmv')
    await page.getByRole('button', { name: /Open file/ }).click()
    const reopenDialog = page.getByRole('dialog')
    await reopenDialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await reopenDialog.getByRole('button', { name: 'OK' }).click()

    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Alpha')
  })
})

test.describe('onBeforeUnload fires a save without awaiting it (src/main.ts)', () => {
  const PASSWORD = 'e2e-unload-save-password'

  test('a synthetic beforeunload with a dirty document still results in a completed, real disk write', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    await addTeam(page, 'Alpha')
    await expect(page.locator('.tt-save-pill[data-state="dirty"]')).toBeVisible()

    // A synthetic (untrusted) event: dispatchEvent() returns synchronously,
    // well before the fire-and-forget saveNow() it kicks off has resolved —
    // exactly the gap onBeforeUnload's own comment describes.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))

    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()
    const bytes = await readOpfsFile(page, 'team-tracker.tmv')
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('TMV1')
  })
})
