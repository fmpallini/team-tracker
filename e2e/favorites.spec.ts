// e2e/favorites.spec.ts — favorites end to end through the fast switch, plus
// the layout guards the unit tests can't give (jsdom has no layout).
import { test, expect, type Page } from '@playwright/test'
import { createEmptyTeam } from '../src/core/document'
import { buildDoc, openDoc, TEAM_ID } from './layout-fixtures'

const paneTitle = (page: Page, idx: 0 | 1 = 0): ReturnType<Page['locator']> =>
  page.locator('.tt-pane-title-text').nth(idx)

test('star a pane, switch team, jump back from the fast switch, then remove the favorite with ✕', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'general' })
  doc.teams.push(createEmptyTeam('team-1', 'Second team', '🧪', 'en-US'))
  await openDoc(page, doc)

  await page.locator('.tt-pane-fav-btn').first().click()
  await expect(page.locator('.tt-pane-fav-btn').first()).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Alt+2') // switch to the second team
  await expect(paneTitle(page)).not.toContainText('General notes')

  await page.keyboard.press('Control+Shift+K')
  await expect(page.locator('.tt-palette-heading').first()).toContainText(/favorites/i)
  await expect(page.locator('.tt-palette-group').first().locator('.tt-palette-item')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-palette-overlay')).toHaveCount(0)
  await expect(paneTitle(page)).toContainText('General notes')

  await page.keyboard.press('Control+Shift+K')
  await page.locator('.tt-palette-remove').click()
  await expect(page.locator('.tt-palette-remove')).toHaveCount(0)
  await expect(page.locator('.tt-palette-overlay')).toBeVisible() // ✕ does not close or navigate
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-pane-fav-btn').first()).toHaveAttribute('aria-pressed', 'false')
})

test('the fast switch reaches another team by typing, and switches to it', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'general' })
  const second = createEmptyTeam('team-1', 'Second team', '🧪', 'en-US')
  second.members.push({ id: 'zed', name: 'Zedekiah', role: '', parentId: null, order: 0, notes: '' })
  doc.teams.push(second)
  await openDoc(page, doc)

  await page.keyboard.press('Control+Shift+K')
  await expect(page.locator('.tt-palette-item').filter({ hasText: 'Zedekiah' })).toHaveCount(0) // hidden until you type
  await page.locator('.tt-palette-input').fill('zedek')
  const row = page.locator('.tt-palette-item').filter({ hasText: 'Zedekiah' })
  await expect(row.locator('.tt-palette-team')).toContainText('Second team')
  await page.keyboard.press('Enter')
  await expect(paneTitle(page)).toContainText('Zedekiah')
})

for (const size of ['XS', 'XL'] as const) {
  test(`fast switch with 34 favorites: at most 20 rows, one line each, inside the viewport (${size})`, async ({ page }) => {
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
    await page.keyboard.press('Control+Shift+K')
    await expect(page.locator('.tt-palette-dialog')).toBeVisible()

    const r = await page.evaluate(() => {
      const dialog = document.querySelector('.tt-palette-dialog')!.getBoundingClientRect()
      const rows = [...document.querySelectorAll<HTMLElement>('.tt-palette-item')]
      const labels = [...document.querySelectorAll<HTMLElement>('.tt-palette-label')]
      return {
        rows: rows.length,
        headings: document.querySelectorAll('.tt-palette-heading').length,
        tall: labels.filter((e) => e.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(e).fontSize)).length,
        inViewport: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
        distinctRowHeights: new Set(rows.map((e) => Math.round(e.getBoundingClientRect().height))).size,
      }
    })
    expect(r.rows).toBeLessThanOrEqual(20)
    expect(r.rows).toBeGreaterThanOrEqual(8)
    expect(r.headings).toBeGreaterThanOrEqual(2) // Favorites and the current team, each with a heading
    expect(r.tall).toBe(0)
    expect(r.inViewport).toBe(true)
    expect(r.distinctRowHeights).toBe(1) // rows with and without ✕ are the same height

    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.tt-palette-overlay')).toHaveCount(0)
  })
}
