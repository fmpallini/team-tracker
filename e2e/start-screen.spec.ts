// e2e/start-screen.spec.ts — the start screen before any file is open: Ctrl+wheel sizes the app's text instead of
// zooming the browser (which would be remembered for the site and carried into the opened file), and the diagnostic
// log a user can send after a crash downloads with what this launch did.
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { E2E_BASE_URL } from '../playwright.config'
import { blockUpdateCheck } from './helpers'

test.beforeEach(async ({ page }) => {
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await expect(page.locator('.tt-start-screen')).toBeVisible()
})

test('Ctrl+wheel on the start screen steps the text size, not the browser zoom', async ({ page }) => {
  const ratio = await page.evaluate(() => window.devicePixelRatio)
  await page.mouse.move(200, 200)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect(page.locator('html')).toHaveAttribute('data-size', 'L')
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(ratio)
})

test('the diagnostic log downloads with this launch in it', async ({ page }) => {
  const download = page.waitForEvent('download')
  await page.locator('.tt-start-diagnostics').click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^team-tracker-diagnostics-\d{8}-\d{4}\.txt$/)
  const text = await readFile(await file.path(), 'utf8')
  expect(text).toMatch(/ launch version=\S+ standalone=false ua=/)
})
