// e2e/fs-api.spec.ts — exercises the real File System Access API via the
// OPFS-backed picker shim in e2e/opfs-shim.ts. Unlike smoke.spec.ts's
// download-fallback flow, these tests exercise the real
// writeFile/readHandle/openFromHandle code in src/core/fs.ts against a real,
// disk-backed FileSystemFileHandle.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

test.describe('real File System Access API (served over http for OPFS)', () => {
  const PASSWORD = 'e2e-roundtrip-password'

  test('create with a password, close, reopen last — full real encrypt/write/read/decrypt round trip', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)

    await createEncryptedDoc(page, PASSWORD)

    // The bytes on "disk" (OPFS) must actually be AES-GCM ciphertext under
    // the .tmv format, not plaintext — proves the real encryptDocument +
    // writeFile path ran, not just the UI accepting the password.
    const bytes = await readOpfsFile(page, 'team-tracker.tmv')
    const magic = String.fromCharCode(...bytes.slice(0, 4))
    expect(magic).toBe('TMV1')

    // closeFile() saves (if dirty) and tears the document down in place —
    // no navigation, same page re-renders the start screen.
    await page.click('.tt-btn-close-file')
    await expect(page.locator('.tt-start-screen')).toBeVisible()

    // "Reopen last…" reads the handle straight back out of IndexedDB
    // (core/fs.ts's reopenLast) — a second real API this proves works,
    // independent of the picker shim.
    const reopenBtn = page.getByRole('button', { name: /Reopen last/ })
    await expect(reopenBtn).toBeVisible()
    await reopenBtn.click()

    const openDialog = page.getByRole('dialog')
    await openDialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await openDialog.getByRole('button', { name: 'OK' }).click()

    await expect(page.locator('.tt-shell')).toBeVisible()
  })

  test('a wrong password on reopen is rejected, and the correct one still works right after', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)
    await page.click('.tt-btn-close-file')

    await page.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill('definitely-wrong')
    await dialog.getByRole('button', { name: 'OK' }).click()

    await expect(page.getByText('Wrong password')).toBeVisible()
    await expect(page.locator('.tt-start-screen')).toBeVisible()

    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
  })

  test('daily backup mirrors a real, independently-readable second file on save', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    await page.click('.tt-btn-settings')
    await page.getByRole('button', { name: 'Advanced' }).click()
    const backupCheckbox = page.locator('.tt-prefs-backup-checkbox')
    await expect(backupCheckbox).toBeEnabled()
    await backupCheckbox.check()
    // The checkbox itself flips to checked synchronously (native DOM
    // behavior) the instant .check() runs — well before
    // pickAndStoreBackupTarget()'s real (shimmed) picker→idbSet→store.update
    // chain actually persists backupHandleId. The prefs tab doesn't
    // re-render live on that store.update (it only reflects backupHandleId
    // at the tab's own initial render), so there's no DOM signal to wait on
    // here — a bounded wait for the chain to settle is the pragmatic option.
    // Everything in that chain is local (OPFS + IndexedDB), not network, so
    // this margin is generous, not a source of flakiness.
    await page.waitForTimeout(500)
    // Enabling the pref is itself a store.update(), which marks the doc
    // dirty — closing the modal returns focus to the shell for the save
    // hotkey below.
    await page.keyboard.press('Escape')

    await page.keyboard.press('Control+s')
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    const primary = await readOpfsFile(page, 'team-tracker.tmv')
    const backup = await readOpfsFile(page, 'team-tracker.bck')
    expect(backup.length).toBeGreaterThan(0)
    // The backup is a byte-for-byte mirror of what was just written primary-side.
    expect(backup).toEqual(primary)
  })
})
