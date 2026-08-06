// e2e/password-change.spec.ts — proves src/core/change-password.ts's real
// re-encrypt/serializePlain-and-write path end to end through the prefs UI
// (src/ui/prefs.ts's Security tab), by closing the file and reopening it
// under the new credentials. Unit tests (test/change-password.test.ts) cover
// this logic with fake deps; this proves the actual encrypt/write/decrypt
// round trip against a real OPFS file.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc } from './helpers'

async function openSecurityTab(page: Page): Promise<void> {
  await page.click('.tt-btn-settings')
  await page.getByRole('button', { name: 'Security' }).click()
}

async function closeAndReopen(page: Page): Promise<void> {
  await page.click('.tt-btn-close-file')
  await expect(page.locator('.tt-start-screen')).toBeVisible()
  await page.getByRole('button', { name: /Reopen last/ }).click()
}

test.describe('password change round trip', () => {
  test('encrypted -> new password: old password rejected, new one opens', async ({ page }) => {
    const OLD = 'e2e-old-password'
    const NEW = 'e2e-new-password'
    await installOpfsPickerShim(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, OLD)

    await openSecurityTab(page)
    await page.locator('input[name="tt-prefs-current-password"]').fill(OLD)
    await page.locator('input[name="tt-prefs-new-password"]').fill(NEW)
    await page.locator('input[name="tt-prefs-new-password-confirm"]').fill(NEW)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByText('Password changed successfully')).toBeVisible()
    await page.keyboard.press('Escape')

    await closeAndReopen(page)
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(OLD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Wrong password')).toBeVisible()

    await dialog.locator('input[name="tt-password"]').fill(NEW)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
  })

  test('encrypted -> password-less: reopens with no password prompt at all', async ({ page }) => {
    const PASSWORD = 'e2e-migrate-password'
    await installOpfsPickerShim(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    await openSecurityTab(page)
    await page.getByRole('button', { name: 'Migrate to password-less' }).click()
    const confirmDialog = page.getByRole('dialog').last()
    await confirmDialog.locator('input[type="password"]').fill(PASSWORD)
    await confirmDialog.getByRole('button', { name: 'Migrate to password-less' }).click()
    await expect(page.getByText('Password changed successfully')).toBeVisible()
    await page.keyboard.press('Escape')

    await closeAndReopen(page)
    // A password-less file is sniffed and opened directly — no dialog at all.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.tt-shell')).toBeVisible()
  })

  test('password-less -> encrypted: reopening now requires the new password', async ({ page }) => {
    const PASSWORD = 'e2e-set-password'
    await installOpfsPickerShim(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)

    await page.getByRole('button', { name: /Create new/ }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.getByRole('button', { name: 'Use without password' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()

    await openSecurityTab(page)
    await page.locator('input[name="tt-prefs-new-password"]').fill(PASSWORD)
    await page.locator('input[name="tt-prefs-new-password-confirm"]').fill(PASSWORD)
    await page.getByRole('button', { name: 'Set password' }).click()
    await expect(page.getByText('Password changed successfully')).toBeVisible()
    await page.keyboard.press('Escape')

    await closeAndReopen(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()
  })
})
