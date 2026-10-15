// e2e/external-change.spec.ts — exercises src/core/fs.ts's real
// ExternalChangeError detection (writeFile compares the OPFS file's actual
// lastModified against the session's last-known value) and the resulting
// conflict modal (src/ui/conflict.ts), wired in src/main.ts's
// onExternalChange. writeOpfsFile lets a test simulate "another program or
// tab touched the file" without any app code involved — a real OPFS write,
// not a mock.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, readOpfsFile, writeOpfsFile } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

async function addTeam(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /Create first team/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

test.describe('external file change conflict', () => {
  const PASSWORD = 'e2e-conflict-password'

  test('Overwrite writes the in-memory doc over the externally-changed file', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Simulate another program/tab clobbering the file after our last write —
    // any bytes will do, since the mismatch is detected by lastModified alone.
    await writeOpfsFile(page, 'team-tracker.tmv', Array(16).fill(0))

    await addTeam(page, 'Conflict Team')
    await page.keyboard.press('Control+s')

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.tt-modal-title')).toHaveText('File changed externally')
    await dialog.getByRole('button', { name: 'Overwrite' }).click()
    await expect(dialog).toBeHidden()

    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    // Disk now holds the real in-memory doc (valid ciphertext), not the garbage bytes.
    const bytes = await readOpfsFile(page, 'team-tracker.tmv')
    const magic = String.fromCharCode(...bytes.slice(0, 4))
    expect(magic).toBe('TMV1')
  })

  test('Fork writes a new file, leaves the original untouched, and moves the session onto it', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Turn the daily backup mirror on first, so the fork's own prefs can be
    // checked for it afterwards: a fork that inherited backupHandleId would
    // mirror its saves into the ORIGINAL file's .bck.
    await page.click('.tt-btn-settings')
    await page.getByRole('tab', { name: 'Saving & backup' }).click()
    const backupCheckbox = page.locator('.tt-prefs-backup-checkbox')
    await expect(backupCheckbox).toBeEnabled()
    await backupCheckbox.check()
    // See fs-api.spec.ts's backup test: the picker→idbSet→store.update chain
    // that actually persists backupHandleId has no DOM signal to wait on.
    await page.waitForTimeout(500)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+s')
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    // Another program clobbers the file behind the app's back.
    const EXTERNAL_BYTES = Array(16).fill(7) as number[]
    await writeOpfsFile(page, 'team-tracker.tmv', EXTERNAL_BYTES)

    await addTeam(page, 'Forked Team')
    await page.keyboard.press('Control+s')

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Save my copy as a new file…' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The session now belongs to the fork — the shell was rebuilt around it.
    await expect(page).toHaveTitle(/team-tracker \(copy\)\.tmv/)
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    // The fork holds a real encrypted document...
    const fork = await readOpfsFile(page, 'team-tracker (copy).tmv')
    expect(String.fromCharCode(...fork.slice(0, 4))).toBe('TMV1')

    // ...and the other writer's bytes survive untouched in the original.
    const original = await readOpfsFile(page, 'team-tracker.tmv')
    expect(Array.from(original)).toEqual(EXTERNAL_BYTES)

    // The in-memory edit that caused the conflict came along to the fork.
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Forked Team')

    // The fork does not inherit the original's backup target.
    await page.click('.tt-btn-settings')
    await page.getByRole('tab', { name: 'Saving & backup' }).click()
    await expect(page.locator('.tt-prefs-backup-checkbox')).not.toBeChecked()
  })

  test('Escape on the conflict modal does not lock saving: the next save raises it again', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    await writeOpfsFile(page, 'team-tracker.tmv', Array(16).fill(0))
    await addTeam(page, 'Conflict Team')
    await page.keyboard.press('Control+s')

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Used to be a silent no-op for the rest of the session.
    await page.keyboard.press('Control+s')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').locator('.tt-modal-title')).toHaveText('File changed externally')
  })

  test('a touched-but-identical file (cloud sync, antivirus) is not a conflict: the save just goes through', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Same bytes, new mtime — what a sync client does to a file it merely re-scanned.
    const original = await readOpfsFile(page, 'team-tracker.tmv')
    await writeOpfsFile(page, 'team-tracker.tmv', original)

    await addTeam(page, 'No Conflict Team')
    await page.keyboard.press('Control+s')

    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const after = await readOpfsFile(page, 'team-tracker.tmv')
    expect(after.length).not.toBe(0)
    expect(after).not.toEqual(original) // the new team really was written
  })

  test('Reload discards local edits and re-reads the file from disk', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Another program puts a DIFFERENT (but valid) version of the file on disk:
    // save once so the app's baseline is that save, then put the original,
    // team-less bytes back behind its back. A mere mtime bump with identical
    // content is deliberately NOT a conflict any more (see the next test).
    const original = await readOpfsFile(page, 'team-tracker.tmv')
    await addTeam(page, 'Saved Before The Conflict')
    await page.keyboard.press('Control+s')
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()
    await writeOpfsFile(page, 'team-tracker.tmv', original)

    // A nav-only change (sidebar toggle) is enough to make the document dirty.
    await page.locator('.tt-sidebar-toggle').click()
    await page.keyboard.press('Control+s')

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Reload' }).click()

    // confirmReload() stacks a second dialog on top without closing the first.
    const confirmDialog = page.getByRole('dialog').last()
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Reload' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    // The team added before Reload never made it to disk, so it's gone —
    // the empty-state CTA proves the reload really re-read the on-disk doc.
    await expect(page.getByRole('button', { name: /Create first team/ })).toBeVisible()
  })
})
