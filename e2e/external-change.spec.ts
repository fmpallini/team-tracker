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

  test('Reload discards local edits and re-reads the file from disk', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    // Re-write the same bytes already on disk: content is unchanged, but a
    // real OPFS write still bumps lastModified — enough alone to trigger the
    // external-change check on the next save.
    const original = await readOpfsFile(page, 'team-tracker.tmv')
    await writeOpfsFile(page, 'team-tracker.tmv', original)

    await addTeam(page, 'Should Be Discarded')
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
