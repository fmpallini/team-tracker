// e2e/scroll-and-overflow.spec.ts — wheel scrolling, truncation and overflow
// guards that need real layout (jsdom has none). Shares the awkward fixture in
// layout-fixtures.ts with font-size-layout.spec.ts.
import { test, expect } from '@playwright/test'
import { buildDoc, openDoc } from './layout-fixtures'

test('org chart: the plain wheel scrolls a wide chart sideways when it has no vertical scroll', async ({ page }) => {
  await openDoc(page, buildDoc('M', { kind: 'stakeholders' }, { stakeholderRoots: 14 }))
  const tree = page.locator('.tt-people-tree')
  await expect(tree.locator('.tt-org-box').first()).toBeVisible()
  const geo = await tree.evaluate((e) => ({ wide: e.scrollWidth > e.clientWidth, tall: e.scrollHeight > e.clientHeight }))
  expect(geo).toEqual({ wide: true, tall: false })
  // `safe center`: the leftmost box must be reachable, not pushed past the scroll origin
  expect(await tree.evaluate((e) => e.querySelector('.tt-org-box')!.getBoundingClientRect().left >= e.getBoundingClientRect().left)).toBe(true)

  await tree.hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => tree.evaluate((e) => e.scrollLeft)).toBeGreaterThan(100)
})

test('due panel: as wide as Preferences, one aligned row per item, full title on hover', async ({ page }) => {
  await openDoc(page, buildDoc('XL', { kind: 'general' }, { dueToday: true }))
  await page.locator('.tt-due-btn').click()
  const dialog = page.locator('.tt-modal-dialog')
  await expect(dialog.locator('.tt-due-row').first()).toBeVisible()
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
  const width = await dialog.evaluate((e) => e.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(40 * rem) // Preferences/help are min(42rem, 92vw)

  const rows = await dialog.locator('.tt-due-row').evaluateAll((els) =>
    els.map((e) => {
      const title = e.querySelector<HTMLElement>('.tt-due-row-title')!
      return { h: e.getBoundingClientRect().height, clipped: title.scrollWidth > title.clientWidth, tip: title.title, text: title.textContent }
    })
  )
  expect(rows.length).toBeGreaterThanOrEqual(5)
  expect(new Set(rows.map((r) => Math.round(r.h))).size).toBe(1) // every row the same height
  expect(rows.some((r) => r.clipped)).toBe(true) // the long summary is ellipsized…
  for (const r of rows) expect(r.tip).toBe(r.text) // …and every title carries its full text as a tooltip
})

test('milestone timeline: drawn at natural size, scrolls sideways under the wheel', async ({ page }) => {
  await openDoc(page, buildDoc('XL', { kind: 'milestones' }, { milestones: 'dense' }))
  const tl = page.locator('.tt-milestone-timeline')
  await expect(tl.locator('.tt-milestone-svg')).toBeVisible()
  const m = await tl.evaluate((e) => {
    const svg = e.querySelector('.tt-milestone-svg')!
    const label = e.querySelector('.tt-milestone-date-label')!
    return {
      scrolls: e.scrollWidth > e.clientWidth,
      drawn: svg.getBoundingClientRect().width,
      natural: Number(svg.getAttribute('width')),
      labelPx: label.getBoundingClientRect().height,
    }
  })
  expect(m.scrolls).toBe(true)
  expect(m.drawn).toBeCloseTo(m.natural, 0) // not scaled down to fit
  expect(m.labelPx).toBeGreaterThan(8) // text stays legible

  await tl.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => tl.evaluate((e) => e.scrollLeft)).toBeGreaterThan(200)
})

test('risk rows keep every control inside the row border, at XL in split view, at any window width', async ({ page }) => {
  // The one-line row needs ~52rem of pane; the old 50rem wrap breakpoint let a
  // pane between 50 and 52rem hang the delete button off the row's border.
  await openDoc(page, buildDoc('XL', { kind: 'risks' }, { splitRight: { kind: 'risks' } }))
  for (let w = 1300; w <= 2600; w += 50) {
    await page.setViewportSize({ width: w, height: 900 })
    await expect(page.locator('.tt-pane[data-pane-idx="1"]')).toBeVisible()
    const out = await page.evaluate(() => {
      const bad: string[] = []
      for (const row of document.querySelectorAll('.tt-risk-row')) {
        const rr = row.getBoundingClientRect()
        for (const c of row.querySelectorAll('*')) {
          const r = c.getBoundingClientRect()
          if (r.width > 0 && r.right > rr.right + 0.5) { bad.push(`${c.className} +${Math.round(r.right - rr.right)}`); break }
        }
      }
      return bad
    })
    expect(out, `window ${w}px`).toEqual([])
  }
})
