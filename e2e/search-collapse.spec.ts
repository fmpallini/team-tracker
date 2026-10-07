// e2e/search-collapse.spec.ts — the header search rests as a square magnifier
// button and expands to the full field on focus or while it holds a query
// (styles.css .tt-search-wrap). The widths are layout, so jsdom can't see them.
import { test, expect, type Page } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

const input = (page: Page) => page.locator('.tt-search-input')
const width = (page: Page) => input(page).evaluate((e) => e.getBoundingClientRect().width)
const ctlHeight = (page: Page) => input(page).evaluate((e) => e.getBoundingClientRect().height)

/** Resting state needs nothing focused: the layout fixture opens with focus on a pane. */
async function rest(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test.describe('header search expands from an icon', () => {
  test.beforeEach(async ({ page }) => {
    await openDoc(page, buildDoc('M', { kind: 'general' }), { width: 1300, height: 700 })
    await rest(page)
  })

  test('at rest it is a control-sized square with no placeholder text showing', async ({ page }) => {
    await expect.poll(() => width(page)).toBeCloseTo(await ctlHeight(page), 0)
    expect(await page.locator('.tt-search-icon-mark').isVisible()).toBe(true)
    const color = await input(page).evaluate((e) => getComputedStyle(e, '::placeholder').color)
    expect(color).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  })

  test('click, Ctrl+F and / each expand it; Escape then folds it back', async ({ page }) => {
    const collapsed = await width(page)
    await input(page).click()
    await expect.poll(() => width(page)).toBeGreaterThan(collapsed * 4)
    await page.keyboard.press('Escape')
    await expect.poll(() => width(page)).toBeCloseTo(collapsed, 0)

    await page.keyboard.press('Control+f')
    await expect.poll(() => width(page)).toBeGreaterThan(collapsed * 4)
    await page.keyboard.press('Escape')
    await expect.poll(() => width(page)).toBeCloseTo(collapsed, 0)

    await page.keyboard.press('Control+Shift+f')
    await expect.poll(() => width(page)).toBeGreaterThan(collapsed * 4)
    await page.keyboard.press('Escape')
    await rest(page)
    await page.keyboard.press('/')
    await expect.poll(() => width(page)).toBeGreaterThan(collapsed * 4)
  })

  test('it stays expanded after blur while it holds a query, and folds once cleared', async ({ page }) => {
    const collapsed = await width(page)
    await input(page).click()
    await page.keyboard.type('plat')
    await page.locator('.tt-sidebar').click({ position: { x: 5, y: 5 } })
    await expect.poll(() => width(page)).toBeGreaterThan(collapsed * 4)
    await input(page).click()
    await page.locator('.tt-search-clear-btn').click()
    await page.locator('.tt-sidebar').click({ position: { x: 5, y: 5 } })
    await expect.poll(() => width(page)).toBeCloseTo(collapsed, 0)
  })

  test('with the sidebar open the glass sits on the sidebar edge, whatever the app-name width; collapsed, it closes up', async ({ page }) => {
    const geometry = () =>
      page.evaluate(() => ({
        glass: document.querySelector('.tt-search-input')!.getBoundingClientRect().left,
        sidebarRight: document.querySelector('.tt-sidebar')!.getBoundingClientRect().right,
        nameRight: document.querySelector('.tt-app-name')!.getBoundingClientRect().right,
      }))
    const open = await geometry()
    expect(open.glass - open.sidebarRight).toBeGreaterThanOrEqual(0)
    expect(open.glass - open.sidebarRight).toBeLessThanOrEqual(12)
    expect(open.glass - open.nameRight).toBeGreaterThan(30) // the name hugs its text; the slot's remainder is empty

    await page.locator('.tt-sidebar-toggle').click()
    await expect.poll(async () => { const g = await geometry(); return g.glass - g.nameRight }).toBeLessThan(20)
  })

  test('expanding moves no other header control', async ({ page }) => {
    const rights = () =>
      page.evaluate(() => ['.tt-save-pill-wrap', '.tt-btn-settings', '.tt-btn-close-file'].map((q) => Math.round(document.querySelector(q)!.getBoundingClientRect().left)))
    const before = await rights()
    await input(page).click()
    await expect.poll(() => width(page)).toBeGreaterThan(100)
    expect(await rights()).toEqual(before)
  })
})
