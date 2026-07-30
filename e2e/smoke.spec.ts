// e2e/smoke.spec.ts
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Runs against the self-contained dist/app.html build (`npm run build`),
// loaded via file:// exactly like a real user would open it.
const APP_URL = 'file://' + path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../dist/app.html')

test.describe('start screen', () => {
  test('renders with no console errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    await page.goto(APP_URL)

    await expect(page.locator('.tt-start-screen')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Team Tracker' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Open file/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Create new/ })).toBeVisible()

    expect(consoleErrors).toEqual([])
  })
})

// Chromium exposes `window.showOpenFilePicker` unconditionally, so the app's
// feature detection (src/core/fs.ts supportsFsApi) sends it down the native
// file-picker path — which Playwright cannot drive. Firefox never implements
// the File System Access API, so it takes the app's own fallback path
// (hidden <input type="file"> + anchor-click download), which automates
// cleanly. Restrict the full create/open flow to firefox for that reason.
test.describe('create → main shell (fallback flow)', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', 'exercises the no-FS-Access-API fallback path')

  test('create a new doc, land on the main shell, open the command palette', async ({ page }) => {
    await page.goto(APP_URL)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /Create new/ }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('input[name="tt-password"]').fill('smoke-test-password')
    await dialog.locator('input[name="tt-password-confirm"]').fill('smoke-test-password')
    await dialog.getByRole('button', { name: 'OK' }).click()

    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('team-tracker.tmv')

    await expect(page.locator('.tt-shell')).toBeVisible()
    await expect(page.locator('.tt-sidebar')).toBeVisible()

    await page.keyboard.press('Control+k')
    await expect(page.locator('.tt-palette-overlay')).toBeVisible()
    await expect(page.locator('.tt-palette-input')).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(page.locator('.tt-palette-overlay')).toBeHidden()
  })
})
