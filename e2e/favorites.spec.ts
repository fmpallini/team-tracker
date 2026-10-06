// e2e/favorites.spec.ts — favorites end to end, plus the large-font and
// header-collision guards the unit tests can't give (jsdom has no layout).
import { test, expect, type Page } from '@playwright/test'
import { createEmptyTeam } from '../src/core/document'
import { buildDoc, openDoc, TEAM_ID } from './layout-fixtures'

const paneTitle = (page: Page, idx: 0 | 1 = 0): ReturnType<Page['locator']> =>
  page.locator('.tt-pane-title-text').nth(idx)

test('star a pane, switch team, jump back via the hotkey, then via the header button', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'general' })
  doc.teams.push(createEmptyTeam('team-1', 'Second team', '🧪', 'en-US'))
  await openDoc(page, doc)

  await page.locator('.tt-pane-fav-btn').first().click()
  await expect(page.locator('.tt-pane-fav-btn').first()).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Alt+2') // switch to the second team
  await expect(paneTitle(page)).not.toContainText('General notes')

  await page.keyboard.press('Control+Alt+F')
  await expect(page.locator('.tt-favorites-panel')).toBeVisible()
  await expect(page.locator('.tt-favorites-item')).toHaveCount(1)
  await page.keyboard.press('1')
  await expect(page.locator('.tt-favorites-panel')).toHaveCount(0)
  await expect(paneTitle(page)).toContainText('General notes')

  await page.keyboard.press('Alt+2')
  await page.locator('.tt-btn-favorites').click()
  await expect(page.locator('.tt-favorites-panel')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(paneTitle(page)).toContainText('General notes')

  await page.keyboard.press('Control+Alt+F')
  await expect(page.locator('.tt-favorites-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-favorites-panel')).toHaveCount(0)
})

for (const size of ['XS', 'XL'] as const) {
  test(`favorites panel rows stay on one line and inside the viewport (${size}, 30+ long entries)`, async ({ page }) => {
    const doc = buildDoc(size, { kind: 'general' }, { stakeholderRoots: 4 })
    for (let i = 0; i < 4; i++) {
      doc.favorites.push({ teamId: TEAM_ID, ref: { kind: 'person', personId: `s${i}`, group: 'stakeholders' } })
    }
    for (const kind of ['general', 'stakeholders', 'members', 'actions', 'milestones', 'risks'] as const) {
      doc.favorites.push({ teamId: TEAM_ID, ref: { kind } })
    }
    for (let i = 0; i < 24; i++) {
      doc.favorites.push({ teamId: TEAM_ID, ref: { kind: 'daily', date: `2026-09-${String(1 + i).padStart(2, '0')}` } })
    }
    await openDoc(page, doc)
    await page.keyboard.press('Control+Alt+F')
    await expect(page.locator('.tt-favorites-panel')).toBeVisible()
    expect(await page.locator('.tt-favorites-item').count()).toBe(34)

    const r = await page.evaluate(() => {
      const panel = document.querySelector('.tt-favorites-panel')!.getBoundingClientRect()
      const list = document.querySelector('.tt-favorites-list')!
      const labels = [...document.querySelectorAll<HTMLElement>('.tt-favorites-label')]
      const rowHeights = [...document.querySelectorAll<HTMLElement>('.tt-favorites-item')].map((e) => Math.round(e.getBoundingClientRect().height))
      return {
        tall: labels.filter((e) => e.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(e).fontSize)).length,
        inViewport: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight,
        listScrolls: list.scrollHeight > list.clientHeight,
        distinctRowHeights: new Set(rowHeights).size,
      }
    })
    expect(r.tall).toBe(0)
    expect(r.inViewport).toBe(true)
    expect(r.listScrolls).toBe(true)
    expect(r.distinctRowHeights).toBe(1)

    // Rows past 9 have no badge but still work from the keyboard.
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.tt-favorites-panel')).toHaveCount(0)
  })
}

for (const size of ['M', 'XL'] as const) {
  test(`header ★ never overlaps the search box or the save pill across window widths (${size})`, async ({ page }) => {
    await openDoc(page, buildDoc(size, { kind: 'general' }), { width: 1440, height: 900 })
    for (const width of [640, 760, 820, 900, 1000, 1100, 1200, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const r = await page.evaluate(() => {
        const rect = (sel: string): DOMRect | null => {
          const e = document.querySelector<HTMLElement>(sel)
          return e && e.offsetParent !== null ? e.getBoundingClientRect() : null
        }
        const hit = (a: DOMRect | null, b: DOMRect | null): boolean =>
          !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom && b.top < a.bottom
        const star = rect('.tt-btn-favorites')
        return {
          starVisible: star !== null,
          overSearch: hit(star, rect('.tt-search-input')),
          overPill: hit(star, rect('.tt-save-pill-wrap')),
          overNeighbour: hit(star, rect('.tt-btn-fullscreen')),
          pageOverflowsX: document.documentElement.scrollWidth > innerWidth,
        }
      })
      expect(r, `width ${width}`).toMatchObject({ overSearch: false, overPill: false, overNeighbour: false, pageOverflowsX: false })
    }
  })
}
