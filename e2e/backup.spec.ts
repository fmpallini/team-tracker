// e2e/backup.spec.ts — src/core/backup-controller.ts's health states
// (currentHealth()'s orphaned/permission/password-mismatch/error ladder) and
// the save-state pill/backup-tab that surface them (src/ui/shell.ts) are
// deeply unit-tested with faked deps (test/backup-controller.test.ts), but
// nothing before this file ever drove a real backup write failure through
// the real File System Access path and watched the actual pill react, or
// proved a real write failure actually self-heals once the underlying
// problem is gone. This is that proof, from two different real call sites:
// a regular Ctrl+S (save-controller.ts's maybeWriteBackup) and a password
// change (change-password.ts's own direct writeBackupNow call).
//
// `installBackupWritePoison` patches `FileSystemFileHandle.createWritable`
// to fail only for the `.bck` file — not the primary `.tmv` — so a poisoned
// backup write happens alongside a perfectly normal primary save, the same
// as a real disk/permission problem confined to the backup target.
//
// Both tests land on a generic-write-failure state or 'backup-password-
// mismatch', never 'backup-permission': OPFS handles always report their
// permission as granted, so this file has no way to simulate a real
// permission lapse.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

declare global {
  interface Window {
    __poisonBackupWrites?: boolean
  }
}

/**
 * Fails every `createWritable()` call on a handle named `*.bck` while
 * `window.__poisonBackupWrites` is true; every other handle (the primary
 * `.tmv`) writes normally regardless of the flag. Installed once via
 * `addInitScript` so it survives navigation; toggled per-test with
 * `page.evaluate`.
 */
function installBackupWritePoisonInPage(): void {
  const proto = window.FileSystemFileHandle?.prototype
  if (!proto) return
  const original = proto.createWritable
  proto.createWritable = function (this: FileSystemFileHandle, ...args: unknown[]) {
    if (window.__poisonBackupWrites && this.name.endsWith('.bck')) {
      return Promise.reject(new Error('e2e: simulated backup write failure'))
    }
    return original.apply(this, args as never)
  }
}

async function enableBackup(page: Page): Promise<void> {
  await page.locator('.tt-btn-settings').click()
  const prefs = page.getByRole('dialog')
  await prefs.locator('.tt-prefs-tab-btn', { hasText: 'Backup' }).first().click()
  const backupCheckbox = page.locator('.tt-prefs-backup-checkbox')
  await expect(backupCheckbox).toBeEnabled()
  await backupCheckbox.check()
  // pickAndStoreBackupTarget()'s picker -> idbSet -> store.update chain is
  // all local (OPFS + IndexedDB), no network — a bounded settle.
  await page.waitForTimeout(500)
  await prefs.getByRole('button', { name: 'OK' }).click()
  await expect(prefs).toHaveCount(0)
}

test.describe('backup health pill', () => {
  test('a poisoned backup write shows backup-error on the pill and tab, and the next successful write clears it', async ({ page }) => {
    await page.addInitScript(installBackupWritePoisonInPage)
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'e2e-backup-password')
    await page.getByRole('button', { name: /Create first team/ }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.locator('input[name="tt-team-name"]').fill('Alpha')
    await createDialog.getByRole('button', { name: 'OK' }).click()
    await expect(createDialog).toHaveCount(0)

    await enableBackup(page)
    const pill = page.locator('.tt-save-pill')
    const tab = page.locator('.tt-save-pill-backup-tab')
    await expect(tab).toBeVisible()

    // Backup has never written yet this session (lastBackupAt is still the
    // disk-seeded 0 from the freshly-picked, empty .bck), so the interval
    // gate is wide open — the very next save attempts a real backup write.
    await page.evaluate(() => { window.__poisonBackupWrites = true })
    const editor = page.locator('.editor').first()
    await editor.click()
    await page.keyboard.type('first note')
    await page.waitForTimeout(400) // let the 300ms debounced commit (scheduleChange) mark the doc dirty before Ctrl+S, or the save no-ops on a still-clean doc
    await page.keyboard.press('Control+s')

    await expect(pill).toHaveAttribute('data-state', 'backup-error')
    await expect(tab).toHaveAttribute('data-backup', 'error')
    // Unlike backup-permission/backup-password-mismatch, a generic write
    // error has no dedicated retry action on the pill (shell.ts's
    // requestSaveNow only handles dirty/error/permission/backup-permission/
    // backup-password-mismatch) — clicking it must do nothing.
    await expect(pill).not.toHaveClass(/tt-save-pill-clickable/)

    // The write never advanced lastBackupAt, so the gate is still open —
    // clearing the poison and forcing another save is a genuine retry, not a
    // no-op skipped by the interval.
    await page.evaluate(() => { window.__poisonBackupWrites = false })
    await page.keyboard.type(' and a fix')
    await page.waitForTimeout(400) // let the 300ms debounced commit mark the doc dirty before Ctrl+S
    await page.keyboard.press('Control+s')

    await expect(pill).toHaveAttribute('data-state', 'saved')
    await expect(tab).toHaveAttribute('data-backup', 'ok')
  })

  test('a backup write that fails during a password change surfaces backup-password-mismatch, and clicking the pill retries and clears it', async ({ page }) => {
    await page.addInitScript(installBackupWritePoisonInPage)
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'e2e-backup-old-password')
    await page.getByRole('button', { name: /Create first team/ }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.locator('input[name="tt-team-name"]').fill('Alpha')
    await createDialog.getByRole('button', { name: 'OK' }).click()
    await expect(createDialog).toHaveCount(0)

    await enableBackup(page)
    const pill = page.locator('.tt-save-pill')
    const tab = page.locator('.tt-save-pill-backup-tab')

    // change-password.ts calls backupCtl.writeBackupNow() directly (not the
    // interval-gated maybeWriteBackup), specifically so the backup mirror is
    // re-encrypted immediately under the new password — poisoning it here
    // exercises exactly that direct call. change-password.ts's own guard
    // (`!backupOk && dailyBackupEnabled && backupHandleId`) then calls
    // markPasswordMismatch() right alongside the exception this poison
    // throws, which is what makes currentHealth()'s priority order between
    // 'password-mismatch' and a plain write failure matter here — see
    // backup-controller.ts's currentHealth() doc comment.
    await page.evaluate(() => { window.__poisonBackupWrites = true })
    await page.locator('.tt-btn-settings').click()
    const prefs = page.getByRole('dialog')
    await prefs.getByRole('tab', { name: 'Security' }).click()
    await prefs.locator('input[name="tt-prefs-current-password"]').fill('e2e-backup-old-password')
    await prefs.locator('input[name="tt-prefs-new-password"]').fill('e2e-backup-new-password')
    await prefs.locator('input[name="tt-prefs-new-password-confirm"]').fill('e2e-backup-new-password')
    await prefs.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Password changed successfully')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(prefs).toHaveCount(0)

    await expect(pill).toHaveAttribute('data-state', 'backup-password-mismatch')
    await expect(tab).toHaveAttribute('data-backup', 'mismatch')
    // Unlike a plain write failure, this state has a dedicated retry action
    // (shell.ts's requestSaveNow -> onBackupRetryRequest -> main.ts's
    // retryBackupWrite), so the pill is clickable.
    await expect(pill).toHaveClass(/tt-save-pill-clickable/)

    // The underlying problem is "resolved" (poison lifted) before the click,
    // same as a user fixing a permissions/disk issue out of band — the pill
    // click is what re-drives the actual write, not what fixes the cause.
    await page.evaluate(() => { window.__poisonBackupWrites = false })
    await pill.click()

    await expect(pill).toHaveAttribute('data-state', 'saved')
    await expect(tab).toHaveAttribute('data-backup', 'ok')
  })
})
