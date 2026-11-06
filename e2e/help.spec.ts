// e2e/help.spec.ts — the tabbed Help modal in a real browser: it opens on the
// focused pane's module, and no tab clips a key or scrolls sideways. jsdom has
// no layout, so the fixed 18rem key column against the widest key chord (and
// the rail beside the panel) can only be proven here.
import { test, expect } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createPlainDoc, blockUpdateCheck, openModule } from './helpers'

test.describe('help', () => {
  test.beforeEach(async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createPlainDoc(page)
    await page.getByRole('button', { name: /Create first team/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-team-name"]').fill('Help Team')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
  })

  test('opens on the focused pane\'s module and follows it to another module', async ({ page }) => {
    const activeTab = page.locator('.tt-prefs-tab-btn.active')

    await page.locator('.tt-btn-help').click()
    await expect(activeTab).toContainText('Notes')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await openModule(page.locator('.tt-pane').first(), /Risks/)
    await page.locator('.tt-btn-help').click()
    await expect(activeTab).toContainText('Risks')
    await expect(page.locator('.tt-help-pane-mark')).toHaveCount(1)
  })

  test('F1 opens Help on the focused pane\'s tab and closes it again, with the browser\'s own help never opening', async ({ page, context }) => {
    const popups: string[] = []
    context.on('page', (p) => popups.push(p.url()))
    const dialog = page.getByRole('dialog')

    await page.keyboard.press('F1')
    await expect(dialog).toBeVisible()
    await expect(page.locator('.tt-prefs-tab-btn.active')).toContainText('Notes')
    await page.keyboard.press('F1')
    await expect(dialog).toHaveCount(0)

    // From inside a note too: F1 must not wait for the caret to leave the editor.
    await page.locator('.editor').first().click()
    await page.keyboard.press('F1')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('F1')
    await expect(dialog).toHaveCount(0)
    expect(popups).toEqual([])
  })

  test('a new team opens on General notes, F2 and F3 switch between it and Daily notes', async ({ page }) => {
    const pane = page.locator('.tt-pane').first()
    await expect(pane.locator('.tt-pane-title-text')).toHaveText('General notes')
    await page.keyboard.press('F3')
    await expect(pane.locator('.tt-pane-title-text')).toContainText('Daily notes')
    await page.keyboard.press('F2')
    await expect(pane.locator('.tt-pane-title-text')).toHaveText('General notes')
  })

  test('no tab clips a key or scrolls sideways, at the default (M) and the largest (XL) text size', async ({ page }) => {
    for (const size of ['M', 'XL']) {
      await page.evaluate((s) => { document.documentElement.dataset.size = s }, size)
      await page.locator('.tt-btn-help').click()
      const dialog = page.getByRole('dialog')
      const tabs = dialog.locator('.tt-prefs-tab-btn')
      const count = await tabs.count()
      expect(count).toBe(7)
      for (let i = 0; i < count; i++) {
        await tabs.nth(i).click()
        const overflow = await dialog.evaluate((d) => {
          const panel = d.querySelector<HTMLElement>('.tt-prefs-content')!
          const clipped = Array.from(d.querySelectorAll<HTMLElement>('.tt-help-code')).filter((c) => c.scrollWidth > c.clientWidth + 1)
          return { sideways: panel.scrollWidth - panel.clientWidth, clipped: clipped.map((c) => c.textContent) }
        })
        expect(overflow, `tab ${i} at ${size}`).toEqual({ sideways: 0, clipped: [] })
      }
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
  })
})
