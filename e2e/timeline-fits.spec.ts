// e2e/timeline-fits.spec.ts — a timeline that fits its card must not show a scrollbar. The card's own padding once pushed the drawing past the element's width, adding a horizontal scrollbar to a two-milestone timeline. jsdom has no layout engine, so this is measured in Chromium.
import { test, expect } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'
for (const size of ['XS', 'M', 'XL'] as const) {
  test(`a timeline that fits has no scrollbar, font size ${size}`, async ({ page }) => {
    const doc = buildDoc(size, { kind: 'milestones' }, { locale: 'pt-BR' })
    doc.teams[0]!.milestones = [
      { id: 'a', date: '2026-10-27', title: 'Caseiro', done: true, followup: '' },
      { id: 'b', date: '2026-10-29', title: 'Caseiro', done: true, followup: '' },
    ]
    await openDoc(page, doc, { width: 1200, height: 800 })
    await page.waitForTimeout(300)
    const m = await page.locator('.tt-milestone-timeline').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }))
    expect(m.sw).toBeLessThanOrEqual(m.cw)
    expect(m.sh).toBeLessThanOrEqual(m.ch)
  })
}

test('milestones sharing a date draw as one dot and never add a scrollbar, even on the last date', async ({ page }) => {
  const doc = buildDoc('M', { kind: 'milestones' }, { locale: 'pt-BR' })
  doc.teams[0]!.milestones = [
    { id: 'a', date: '2026-10-27', title: 'Caseiro', done: true, followup: '' },
    { id: 'b', date: '2026-10-29', title: 'Caseiro', done: true, followup: '' },
    { id: 'c', date: '2026-10-29', title: 'Fechamento', done: false, followup: '' },
  ]
  await openDoc(page, doc, { width: 1200, height: 800 })
  await page.waitForTimeout(300)
  await expect(page.locator('.tt-milestone-dot')).toHaveCount(2)
  const m = await page.locator('.tt-milestone-timeline').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }))
  expect(m.sw).toBeLessThanOrEqual(m.cw)
})
