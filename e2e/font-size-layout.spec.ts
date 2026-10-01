// e2e/font-size-layout.spec.ts — regression guards for layout that only breaks
// at the larger text sizes (prefs.fontSize → html[data-size]). jsdom has no
// layout engine, so none of these can be unit tests: each asserts on real
// measured geometry in Chromium.
//
// Every case runs at XL (the size that exposed them) and the module-menu and
// kanban cases also at XS, so a fix that merely trades one end for the other
// still fails.
import { test, expect } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

for (const size of ['XS', 'XL'] as const) {
  test.describe(`font size ${size}`, () => {
    test('module menu rows stay on one line, however short the trigger is', async ({ page }) => {
      // "General notes" is a short trigger: the menu hangs off a ~160px wrapper,
      // which used to cap its shrink-to-fit width and fold "Daily notes" in two.
      await openDoc(page, buildDoc(size, { kind: 'general' }))
      await page.locator('.tt-pane-modules-btn').first().click()
      const labels = page.locator('.tt-pane-menu-label')
      expect(await labels.count()).toBeGreaterThanOrEqual(7)
      const tall = await labels.evaluateAll((els) =>
        els
          .map((e) => ({ text: e.textContent, h: e.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(e).fontSize) }))
          .filter((r) => r.h >= 2 * r.fs)
      )
      expect(tall).toEqual([])
    })

    test('kanban cards keep their full height and the column scrolls instead', async ({ page }) => {
      await openDoc(page, buildDoc(size, { kind: 'actions' }))
      await expect(page.locator('.tt-kanban-card').first()).toBeVisible()
      const r = await page.evaluate(() => {
        const body = document.querySelector('.tt-kanban-col-body')!
        const cards = [...body.querySelectorAll<HTMLElement>('.tt-kanban-card')]
        return {
          scrolls: body.scrollHeight > body.clientHeight,
          squashed: cards.filter((c) => c.scrollHeight > c.clientHeight + 1).length,
          count: cards.length,
        }
      })
      expect(r.count).toBe(24)
      expect(r.scrolls).toBe(true) // 24 cards cannot fit; the column must be the thing that scrolls
      expect(r.squashed).toBe(0)
    })
  })
}

// pt-BR: its "Não salvo – último salvamento hh:mm" save pill is the widest, which is what squeezed the search box to an icon.
test('header search keeps a usable width with the sidebar collapsed and a long team name (XL)', async ({ page }) => {
  await openDoc(page, buildDoc('XL', { kind: 'general' }, { sidebarCollapsed: true, locale: 'pt-BR' }))
  await expect(page.locator('.tt-header-team-indicator.visible')).toBeVisible()
  // A nav change dirties the doc, and the pill grows to "Não salvo – último salvamento hh:mm" — the widest state.
  await page.keyboard.press('F2')
  await page.keyboard.press('F1')
  await expect(page.locator('.tt-save-pill-text')).toContainText('Não salvo')
  const width = await page.locator('.tt-search-input').evaluate((e) => e.getBoundingClientRect().width)
  expect(width).toBeGreaterThanOrEqual(150)
  // The long team name gives way (ellipsis) rather than spilling out of its header slot over the save pill.
  const fit = await page.evaluate(() => {
    const center = document.querySelector('.tt-header-center')!.getBoundingClientRect()
    const ind = document.querySelector('.tt-header-team-indicator')!.getBoundingClientRect()
    const label = document.querySelector('.tt-header-team-indicator-label')!
    return { overflow: ind.right - center.right, clipped: label.scrollWidth > label.clientWidth }
  })
  expect(fit.overflow).toBeLessThanOrEqual(1)
  expect(fit.clipped).toBe(true)
})

test('SVG labels on the milestone timeline and risk quadrant follow the size setting (XL = 1.2 × M)', async ({ page }) => {
  await openDoc(page, buildDoc('XL', { kind: 'milestones' }))
  const dateLabel = page.locator('.tt-milestone-date-label').first()
  await expect(dateLabel).toBeVisible()
  expect(parseFloat(await dateLabel.evaluate((e) => getComputedStyle(e).fontSize))).toBeCloseTo(9 * 1.2, 1)

  await page.keyboard.press('F7')
  const tick = page.locator('.tt-risk-quadrant-tick').first()
  await expect(tick).toBeVisible()
  expect(parseFloat(await tick.evaluate((e) => getComputedStyle(e).fontSize))).toBeCloseTo(9 * 1.2, 1)
})
