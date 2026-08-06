// e2e/save-flow.spec.ts — proves the ordinary Ctrl+S save path end to end:
// an in-memory edit really lands on disk (real OPFS write) and survives a
// close+reopen. fs-api.spec.ts's round trip only covers an unmodified
// just-created doc; this covers the actual edit -> dirty -> save -> persisted
// cycle every real session goes through.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

test.describe('save flow', () => {
  const PASSWORD = 'e2e-save-flow-password'

  test('an edit marks the doc dirty, Ctrl+S persists it, and it survives reopen', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, PASSWORD)

    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    await page.getByRole('button', { name: /Create first team/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-team-name"]').fill('Save Flow Team')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toBeHidden()

    // Adding a team is itself a store.update() — the doc is dirty before any
    // save has run for it.
    await expect(page.locator('.tt-save-pill[data-state="dirty"]')).toBeVisible()

    await page.keyboard.press('Control+s')
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

    await page.click('.tt-btn-close-file')
    await expect(page.locator('.tt-start-screen')).toBeVisible()
    await page.getByRole('button', { name: /Reopen last/ }).click()
    const openDialog = page.getByRole('dialog')
    await openDialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await openDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()

    // The team only exists if the edit was really encrypted, written, and
    // read back — not just reflected in the still-live in-memory store.
    await expect(page.locator('.tt-team-item .tt-team-name')).toHaveText('Save Flow Team')
  })
})
