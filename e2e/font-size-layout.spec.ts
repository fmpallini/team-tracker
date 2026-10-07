// e2e/font-size-layout.spec.ts — regression guards for layout that only breaks
// at the larger text sizes (prefs.fontSize → html[data-size]). jsdom has no
// layout engine, so none of these can be unit tests: each asserts on real
// measured geometry in Chromium.
//
// Every case runs at XL (the size that exposed them) and the module-menu and
// kanban cases also at XS, so a fix that merely trades one end for the other
// still fails.
import { test, expect, type Page } from '@playwright/test'
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
  // At rest the search is just its icon; the field it expands to on focus is what has to stay usable.
  await page.locator('.tt-search-input').click()
  await expect.poll(() => page.locator('.tt-search-input').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(150)
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

/** Every pair of header controls that overlap (or spill outside the header) right now, as measured in Chromium. */
async function headerClashes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const header = document.querySelector('.tt-header')!.getBoundingClientRect()
    const sel = '.tt-btn, .tt-app-name, .tt-search-input, .tt-save-pill, .tt-header-team-indicator, .tt-header-due-summary'
    const items = [...document.querySelectorAll<HTMLElement>(`.tt-header ${sel.split(', ').join(', .tt-header ')}`)]
      .map((e) => {
        // the team slot clips its content (overflow:hidden): only what it still shows can collide
        const clip = e.closest('.tt-header-center')?.getBoundingClientRect()
        const r = e.getBoundingClientRect()
        const left = clip ? Math.max(r.left, clip.left) : r.left
        const right = clip ? Math.min(r.right, clip.right) : r.right
        return { name: e.className.toString().split(' ').slice(0, 2).join('.'), r: { left, right, top: r.top, bottom: r.bottom, width: right - left, height: r.height } }
      })
      .filter((i) => i.r.width > 0 && i.r.height > 0)
    const bad: string[] = []
    for (const i of items) if (i.r.right > header.right + 1 || i.r.left < header.left - 1) bad.push(`${i.name} outside the header`)
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const x = items[a]!.r, y = items[b]!.r
        if (x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1) bad.push(`${items[a]!.name} overlaps ${items[b]!.name}`)
      }
    }
    return bad
  })
}

// The header's clusters are sized in rem, the window is not: responsive.ts has to
// drop the optional chrome (search, team indicator, save pill…) before they collide,
// and at XL the old fixed 820px threshold let the promo button land on the search box.
for (const size of ['M', 'XL'] as const) {
  for (const collapsed of [false, true]) {
    test(`header never overlaps itself at ${size}, sidebar ${collapsed ? 'collapsed' : 'open'}, at any window width`, async ({ page }) => {
      await openDoc(page, buildDoc(size, { kind: 'general' }, { sidebarCollapsed: collapsed, locale: 'pt-BR' }), { width: 1500, height: 700 })
      // a nav change dirties the doc so the save pill is at its widest
      await page.keyboard.press('F2')
      await page.keyboard.press('F1')
      for (let w = 1500; w >= 380; w -= 20) {
        await page.setViewportSize({ width: w, height: 700 })
        await page.waitForTimeout(60)
        const clashes = await headerClashes(page)
        expect(clashes, `window ${w}px`).toEqual([])
      }
    })
  }
}

for (const [size, width] of [['M', 700], ['XL', 900], ['XL', 400]] as const) {
  test(`compact header (${size}, ${width}px) keeps exactly the save pill, lock and settings`, async ({ page }) => {
    await openDoc(page, buildDoc(size, { kind: 'general' }, { locale: 'pt-BR' }), { width, height: 700 })
    await page.keyboard.press('F2')
    await page.keyboard.press('F1')
    await expect(page.locator('.tt-header.tt-header-compact')).toBeVisible()
    const visible = await page.evaluate(() =>
      ['.tt-save-pill', '.tt-btn-close-file', '.tt-btn-settings', '.tt-btn-promo', '.tt-btn-help', '.tt-btn-fullscreen', '.tt-search-input', '.tt-app-name', '.tt-sidebar-toggle', '.tt-header-team-indicator']
        .filter((q) => { const e = document.querySelector(q); return e !== null && e.getBoundingClientRect().width > 0 })
    )
    expect(visible.sort()).toEqual(['.tt-btn-close-file', '.tt-btn-settings', '.tt-save-pill'])
    // all three on screen, the pill's text ellipsized rather than shoving a button off the edge
    const right = await page.evaluate(() => document.querySelector('.tt-btn-settings')!.getBoundingClientRect().right)
    expect(right).toBeLessThanOrEqual(width)
  })
}

// Installed PWA with window-controls overlay: the OS draws min/max/close over the
// header's right end, and styles.css pads the header by that width — so the row the
// clusters share is ~140px narrower than the window. responsive.ts used to compare
// the window width against its thresholds, which let search/promo/save collide for
// the 840–980px band. Chromium cannot be made to match display-mode:
// window-controls-overlay headless (see pwa-update.spec.ts), so this stands in the
// two things the real mode provides: the navigator.windowControlsOverlay API and the
// padding + --tt-wco-reserve that the media block sets from env(titlebar-area-width).
for (const collapsed of [false, true]) {
  test(`header never overlaps itself with a 140px window-controls overlay, sidebar ${collapsed ? 'collapsed' : 'open'}`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'windowControlsOverlay', {
        value: { visible: true, getTitlebarAreaRect: () => ({ width: window.innerWidth - 140 }) },
      })
    })
    await openDoc(page, buildDoc('M', { kind: 'general' }, { sidebarCollapsed: collapsed, locale: 'pt-BR' }), { width: 1500, height: 700 })
    await page.addStyleTag({ content: ':root{--tt-wco-reserve:140px}.tt-header{padding-inline-end:calc(.75rem + 140px)!important}' })
    await page.keyboard.press('F2')
    await page.keyboard.press('F1')
    for (let w = 1500; w >= 380; w -= 20) {
      await page.setViewportSize({ width: w, height: 700 })
      await page.waitForTimeout(60)
      expect(await headerClashes(page), `window ${w}px`).toEqual([])
    }
  })
}
