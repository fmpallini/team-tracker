// e2e/a11y.spec.ts — automated accessibility scan (axe-core) of the three
// surfaces a keyboard-driven app most needs to keep clean: the start screen,
// the main shell with a document open, and an open modal dialog. Nothing else
// in the suite checks ARIA roles/names, focus semantics, or contrast.
//
// Served over http://localhost (secure context) via the OPFS picker shim, the
// same setup fs-api.spec.ts uses, so the real create → shell flow runs.
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

// WCAG 2 A/AA is the bar; scope each scan to the surface under test.
const scan = (page: Page, selector: string) =>
  new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include(selector).analyze()

test.describe('accessibility (axe-core)', () => {
  test('start screen has no WCAG A/AA violations', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await expect(page.locator('.tt-start-screen')).toBeVisible()

    const results = await scan(page, '.tt-start-screen')
    expect(results.violations).toEqual([])
  })

  test('main shell (document open, first team created) has no WCAG A/AA violations', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'e2e-a11y-password')

    await page.getByRole('button', { name: /Create first team/ }).click()
    const teamDialog = page.getByRole('dialog')
    await teamDialog.locator('input[name="tt-team-name"]').fill('Team A')
    await teamDialog.getByRole('button', { name: 'OK' }).click()
    await teamDialog.waitFor({ state: 'hidden' })

    const results = await scan(page, '.tt-shell')
    expect(results.violations).toEqual([])
  })

  test('the Settings modal has no WCAG A/AA violations', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'e2e-a11y-password')

    await page.click('.tt-btn-settings')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const results = await scan(page, '.tt-modal-overlay')
    expect(results.violations).toEqual([])
  })
})
