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

  test('Alt+Arrow drives pane layout (select/split/swap), Alt+Shift+Arrow drives pane history', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // A first team opens split by default (daily notes left, members right,
    // pane 0 focused) — see openTeamDefaultLayout in src/ui/panes.ts.
    await page.locator('.tt-team-add-btn').click()
    const teamDialog = page.getByRole('dialog')
    await teamDialog.locator('input[name="tt-team-name"]').fill('Alpha')
    await teamDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const grid = page.locator('.tt-panes-grid')
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const pane1 = page.locator('.tt-pane[data-pane-idx="1"]')
    const title0 = pane0.locator('.tt-pane-title-text')
    const title1 = pane1.locator('.tt-pane-title-text')

    await expect(grid).toHaveAttribute('data-split', 'true')
    await expect(pane0).toHaveClass(/focused/)
    await expect(pane1).not.toHaveClass(/focused/)

    // Alt+Right / Alt+Left select the right/left pane.
    await page.keyboard.press('Alt+ArrowRight')
    await expect(pane1).toHaveClass(/focused/)
    await expect(pane0).not.toHaveClass(/focused/)
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(pane0).toHaveClass(/focused/)

    // Alt+Down swaps the two panes' contents, focus following the content
    // that was focused before the swap.
    const leftBefore = await title0.textContent()
    const rightBefore = await title1.textContent()
    await page.keyboard.press('Alt+ArrowDown')
    await expect(title0).toHaveText(rightBefore ?? '')
    await expect(title1).toHaveText(leftBefore ?? '')
    await expect(pane1).toHaveClass(/focused/)
    // Swap back to a known baseline (left content on the left, pane 0 focused).
    await page.keyboard.press('Alt+ArrowDown')
    await expect(title0).toHaveText(leftBefore ?? '')
    await expect(pane0).toHaveClass(/focused/)

    // Alt+Up cycles single/dual pane mode.
    await page.keyboard.press('Alt+ArrowUp')
    await expect(grid).toHaveAttribute('data-split', 'false')
    await page.keyboard.press('Alt+ArrowUp')
    await expect(grid).toHaveAttribute('data-split', 'true')

    // Switch pane 0's module (a real navigation, distinct from the swap
    // above) to give it a second history entry, then step through it with
    // Alt+Shift+Left/Right.
    await pane0.locator('.tt-pane-modules-btn').click()
    await pane0.locator('.tt-pane-menu-item', { hasText: /Milestones|Marcos/i }).first().click()
    const afterSwitch = await title0.textContent()
    expect(afterSwitch).not.toBe(leftBefore)

    await page.keyboard.press('Alt+Shift+ArrowLeft')
    await expect(title0).toHaveText(leftBefore ?? '')

    // Plain Alt+Left must NOT step history (that's the old, broken binding) —
    // it only changes pane focus. Pane 0 is already focused, so this is a
    // pure no-op and the title must stay put.
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(title0).toHaveText(leftBefore ?? '')

    await page.keyboard.press('Alt+Shift+ArrowRight')
    await expect(title0).toHaveText(afterSwitch ?? '')
  })
})
