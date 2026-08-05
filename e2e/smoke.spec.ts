// e2e/smoke.spec.ts
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { forceFallbackMode } from './opfs-shim'

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
// feature detection (src/core/fs.ts supportsFsApi) would otherwise send it
// down the native file-picker path — which Playwright cannot drive.
// forceFallbackMode removes the pickers before load so the app takes its own
// download-fallback path instead (hidden <input type="file"> + anchor-click
// download), which Playwright automates cleanly via
// `page.on('filechooser')` / `page.waitForEvent('download')`.
test.describe('create → main shell (fallback flow)', () => {
  test('create a new doc, land on the main shell, open the command palette', async ({ page }) => {
    await forceFallbackMode(page)
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

    // A brand-new doc has zero teams — the command palette (like the header
    // search/title button) is deliberately disabled in that state (nothing
    // for it to open), so Ctrl+K is a no-op until a team exists.
    await page.getByRole('button', { name: /Create first team/ }).click()
    const teamDialog = page.getByRole('dialog')
    await teamDialog.locator('input[name="tt-team-name"]').fill('Smoke Test Team')
    await teamDialog.getByRole('button', { name: 'OK' }).click()
    await expect(teamDialog).toBeHidden()

    await page.keyboard.press('Control+k')
    await expect(page.locator('.tt-palette-overlay')).toBeVisible()
    await expect(page.locator('.tt-palette-input')).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(page.locator('.tt-palette-overlay')).toBeHidden()
  })
})
