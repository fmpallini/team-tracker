// e2e/kanban-layout.spec.ts — the kanban board in a pane narrower than its
// columns (split view) at the smallest and largest text sizes: edge fades say
// the board scrolls, the due/assignee/tag chips stay inside their card, and
// the mouse wheel does exactly what it did before the fades existed — a tall
// column scrolls itself, anywhere else the wheel pans the board sideways.
// jsdom has no layout engine, so this is measured in Chromium.
import { test, expect } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

for (const size of ['XS', 'XL'] as const) {
  test.describe(`kanban board in split view, font size ${size}`, () => {
    test.beforeEach(async ({ page }) => {
      await openDoc(page, buildDoc(size, { kind: 'actions' }, { splitRight: { kind: 'general' } }), { width: 1280, height: 900 })
      await expect(page.locator('.tt-kanban-card').first()).toBeVisible()
    })

    test('edge fades follow the horizontal scroll position', async ({ page }) => {
      const state = (): Promise<{ left: string; right: string; wide: boolean }> =>
        page.evaluate(() => {
          const wrap = document.querySelector('.tt-kanban-board-wrap')!
          const board = wrap.querySelector<HTMLElement>('.tt-kanban-board')!
          const op = (side: 'left' | 'right'): string => getComputedStyle(wrap.querySelector(`.tt-kanban-fade.${side}`)!).opacity
          return { left: op('left'), right: op('right'), wide: board.scrollWidth > board.clientWidth + 1 }
        })
      const start = await state()
      expect(start.wide).toBe(true) // the pane really is narrower than the board
      expect(start.left).toBe('0')
      await expect.poll(async () => (await state()).right).toBe('1') // fades ease in over 120ms

      await page.locator('.tt-kanban-board').evaluate((b) => { b.scrollLeft = b.scrollWidth })
      await expect.poll(async () => (await state()).right).toBe('0')
      await expect.poll(async () => (await state()).left).toBe('1')
    })

    test('chips stay inside their card', async ({ page }) => {
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.tt-kanban-card')]
          .filter((card) => {
            const c = card.getBoundingClientRect()
            return [...card.querySelectorAll<HTMLElement>('.tt-kanban-card-meta > *')].some((chip) => {
              const r = chip.getBoundingClientRect()
              return r.right > c.right + 1 || r.bottom > c.bottom + 1
            })
          })
          .length
      )
      expect(overflowing).toBe(0)
    })

    test('the wheel scrolls a tall column itself, and pans the board anywhere else', async ({ page }) => {
      const bodies = page.locator('.tt-kanban-col-body')
      const tall = (await bodies.nth(0).boundingBox())!
      const board = page.locator('.tt-kanban-board')

      await page.mouse.move(tall.x + tall.width / 2, tall.y + 40)
      await page.mouse.wheel(0, 300)
      await expect.poll(() => bodies.nth(0).evaluate((b) => b.scrollTop)).toBeGreaterThan(0)
      expect(await board.evaluate((b) => b.scrollLeft)).toBe(0)

      const empty = (await bodies.nth(1).boundingBox())! // WIP: no cards, nothing to scroll vertically
      await page.mouse.move(empty.x + empty.width / 2, empty.y + 10)
      await page.mouse.wheel(0, 300)
      await expect.poll(() => board.evaluate((b) => b.scrollLeft)).toBeGreaterThan(0)
    })
  })
}
