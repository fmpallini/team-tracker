// e2e/update-check-now.spec.ts — Preferences → About's "Check now": a click asks GitHub even with the daily check off,
// says what it found, raises the banner for a newer version, and refuses a second request during its cooldown.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createPlainDoc } from './helpers'

test('"Check now" finds a newer version once, then waits out its cooldown', async ({ page }) => {
  let calls = 0
  await page.route('https://api.github.com/**', (route) => {
    calls++
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v99.0.0' }) })
  })
  await page.addInitScript(() => localStorage.setItem('tt-update-check-off', '1')) // no launch check: only the click asks
  await installOpfsPickerShim(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createPlainDoc(page)

  await page.locator('.tt-btn-settings').click()
  await page.getByRole('tab', { name: 'About' }).click()
  const button = page.getByRole('button', { name: 'Check now' })
  await button.click()
  await expect(page.locator('.tt-prefs-update-check-status')).toHaveText('Version 99.0.0 is available.')
  await expect(page.locator('.tt-update-banner')).toBeVisible()
  await expect(button).toBeDisabled()
  expect(calls).toBe(1)

  // closing and reopening Preferences does not reset the cooldown (the banner sits over the header until dismissed)
  await page.keyboard.press('Escape')
  await page.locator('.tt-update-banner-dismiss').click()
  await page.locator('.tt-btn-settings').click()
  await page.getByRole('tab', { name: 'About' }).click()
  await expect(page.locator('.tt-prefs-update-check-status')).toHaveText('Version 99.0.0 is available.')
  await expect(page.getByRole('button', { name: 'Check now' })).toBeDisabled()
  expect(calls).toBe(1)
})
