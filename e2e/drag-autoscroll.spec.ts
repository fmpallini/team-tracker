// e2e/drag-autoscroll.spec.ts — a native drag sends no wheel events, so a card, risk row or
// person held at the edge of its scroller has to scroll it (ui/drag-autoscroll.ts). Real layout,
// real HTML5 drag: Playwright's mouse drives Chromium's native drag-and-drop.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

const VIEWPORT = { width: 1280, height: 900 }

/** Picks `source` up, drags it to `(x, y)` in steps, holds there, and reports the scroller's position once it moved. */
async function dragToEdgeAndHold(page: Page, source: Locator, x: number, y: number, scroller: Locator, prop: 'scrollLeft' | 'scrollTop', grabX?: number): Promise<number> {
  const box = (await source.boundingBox())!
  const gx = box.x + (grabX ?? box.width / 2) // a row's middle is an input, which cannot start a drag
  const gy = box.y + box.height / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 10, gy + 10) // starts the native drag
  await page.mouse.move(x, y, { steps: 8 })
  await expect.poll(() => scroller.evaluate((s, p) => (s as unknown as Record<string, number>)[p], prop)).toBeGreaterThan(0)
  const at = await scroller.evaluate((s, p) => (s as unknown as Record<string, number>)[p], prop)
  await page.mouse.up()
  return at
}

test('kanban: a card held at the board edge scrolls the board sideways', async ({ page }) => {
  await openDoc(page, buildDoc('M', { kind: 'actions' }, { splitRight: { kind: 'general' } }), VIEWPORT)
  const board = page.locator('.tt-kanban-board')
  const box = (await board.boundingBox())!
  expect(await board.evaluate((b) => b.scrollWidth > b.clientWidth)).toBe(true)
  await dragToEdgeAndHold(page, page.locator('.tt-kanban-card').first(), box.x + box.width - 4, box.y + 200, board, 'scrollLeft')
})

test('kanban: a card held at the top of a scrolled column scrolls that column back up', async ({ page }) => {
  // The bottom edge is the delete-trash strip while a card is in the air, so the top edge is the one to prove.
  await openDoc(page, buildDoc('M', { kind: 'actions' }), VIEWPORT)
  const body = page.locator('.tt-kanban-col-body').first()
  expect(await body.evaluate((b) => b.scrollHeight > b.clientHeight)).toBe(true)
  await body.evaluate((b) => { b.scrollTop = 600 })
  const box = (await body.boundingBox())!
  const card = page.locator('.tt-kanban-card').nth(12) // somewhere inside the scrolled-to window
  const c = (await card.boundingBox())!
  expect(c.y).toBeGreaterThan(box.y)
  expect(c.y + c.height).toBeLessThan(box.y + box.height)
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
  await page.mouse.down()
  await page.mouse.move(c.x + c.width / 2 + 10, c.y + c.height / 2 + 10)
  await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 8 })
  await expect.poll(() => body.evaluate((b) => b.scrollTop)).toBeLessThan(600)
  await page.mouse.up()
})

test('risks: a row held at the bottom edge scrolls the list', async ({ page }) => {
  await openDoc(page, buildDoc('M', { kind: 'risks' }), VIEWPORT)
  const pane = page.locator('.tt-risks')
  const box = (await pane.boundingBox())!
  expect(await pane.evaluate((p) => p.scrollHeight > p.clientHeight)).toBe(true)
  await dragToEdgeAndHold(page, page.locator('.tt-risk-row').first(), box.x + box.width / 2, box.y + box.height - 4, pane, 'scrollTop', 3)
})

test('people: a person held at the chart edge scrolls the org chart sideways', async ({ page }) => {
  await openDoc(page, buildDoc('M', { kind: 'stakeholders' }, { stakeholderRoots: 14 }), VIEWPORT)
  const tree = page.locator('.tt-org-root')
  const box = (await tree.boundingBox())!
  expect(await tree.evaluate((t) => t.scrollWidth > t.clientWidth)).toBe(true)
  await dragToEdgeAndHold(page, page.locator('.tt-org-box').first(), box.x + box.width - 4, box.y + 40, tree, 'scrollLeft')
})
