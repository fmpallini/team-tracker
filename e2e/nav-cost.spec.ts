// e2e/nav-cost.spec.ts — what a nav-only mutation (pane focus click) costs on a
// large document, in a real browser.
//
// Nav mutations (store.updateNav) never change content, so they should neither
// rebuild the sidebar's team list nor throw away the search index's prepared
// candidates. This spec measures both from inside the page:
//
//  - DOM churn in the sidebar per pane-focus click (elements added), and
//  - the latency of a cross-team search issued right after a pane-focus click
//    versus the same search with no click in between (the cache-rebuild tax).
//
// Numbers are logged for before/after comparison; the assertions are ceilings
// for "obviously broken" (see perf.spec.ts for the budgeting philosophy).
import { test, expect } from '@playwright/test'
import { TEAMS, buildLargeDoc, openLargeDoc } from './large-doc'

test.describe(`nav-only mutations on ${TEAMS} teams`, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeEach(async ({ page }) => {
    const doc = buildLargeDoc()
    const id = doc.teams[0]!.id
    doc.nav.split = true
    doc.nav.focusedPane = 0
    doc.nav.teamSplit = { [id]: true }
    doc.nav.panes = [
      { history: [{ teamId: id, ref: { kind: 'daily', date: '2026-06-15' } }], index: 0 },
      { history: [{ teamId: id, ref: { kind: 'risks' } }], index: 0 },
    ]
    await openLargeDoc(page, doc)
    await expect(page.locator('.tt-pane[data-pane-idx="1"]')).toBeVisible()
  })

  test('a pane-focus click does not rebuild the sidebar team list', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const sidebar = document.querySelector('.tt-sidebar') as HTMLElement
      const countEls = (nl: NodeList): number => Array.from(nl).reduce((n, x) => n + (x instanceof Element ? 1 + x.querySelectorAll('*').length : 0), 0)
      let added = 0
      const mo = new MutationObserver((recs) => { for (const rec of recs) added += countEls(rec.addedNodes) })
      mo.observe(sidebar, { childList: true, subtree: true })

      const CLICKS = 20
      const samples: number[] = []
      for (let i = 0; i < CLICKS; i++) {
        const pane = document.querySelector(`.tt-pane[data-pane-idx="${i % 2 === 0 ? 1 : 0}"]`) as HTMLElement
        const t0 = performance.now()
        pane.click()
        added += 0
        for (const rec of mo.takeRecords()) added += countEls(rec.addedNodes)
        samples.push(performance.now() - t0)
      }
      mo.disconnect()
      samples.sort((a, b) => a - b)
      return { added, clicks: CLICKS, medianMs: samples[Math.floor(samples.length / 2)]! }
    })
    console.log(`[nav-cost] sidebar elements added over ${r.clicks} pane-focus clicks: ${r.added} (${(r.added / r.clicks).toFixed(0)}/click); click handler median ${r.medianMs.toFixed(2)}ms`)
    expect(r.added, 'sidebar rebuilt on pane focus').toBe(0)
  })

  test('a cross-team search right after a pane-focus click is as fast as one without', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const input = document.querySelector('.tt-search-input-box input') as HTMLInputElement
      input.dispatchEvent(new Event('focus', { bubbles: true }))
      input.value = 'seed'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      const checkbox = document.querySelector('.tt-search-dropdown input[type="checkbox"]') as HTMLInputElement | null
      if (!checkbox) return { error: 'scope checkbox not found' as const }
      if (!checkbox.checked) checkbox.click()

      let n = 0
      // Longest main-thread stall while a query settles: a setTimeout(0) chain
      // records the largest gap between ticks. Timing the debounce sleep itself
      // (as perf.spec.ts does) hides the search, which runs inside that sleep.
      async function query(): Promise<number> {
        // No-match terms sharing no prefix: every query is a full scan, never
        // answered by narrowing the previous one.
        input.value = `${String.fromCharCode(97 + (n++ % 26))}${n}zznomatch`
        let last = performance.now()
        let maxGap = 0
        let running = true
        const tick = (): void => {
          if (!running) return
          const now = performance.now()
          maxGap = Math.max(maxGap, now - last)
          last = now
          setTimeout(tick, 0)
        }
        setTimeout(tick, 0)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 400))
        running = false
        return maxGap
      }
      const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

      await query() // builds the index
      const plain: number[] = []
      for (let i = 0; i < 7; i++) plain.push(await query())

      const afterNav: number[] = []
      for (let i = 0; i < 7; i++) {
        const pane = document.querySelector(`.tt-pane[data-pane-idx="${i % 2 === 0 ? 1 : 0}"]`) as HTMLElement
        pane.click()
        input.dispatchEvent(new Event('focus', { bubbles: true })) // the click closed the dropdown; reopen like a user would
        afterNav.push(await query())
      }
      return { plain: median(plain), afterNav: median(afterNav) }
    })
    expect('error' in r ? r.error : null, 'scope checkbox').toBeNull()
    if ('error' in r) return
    console.log(`[nav-cost] cross-team search, longest main-thread stall (median of 7): ${r.plain.toFixed(1)}ms plain, ${r.afterNav.toFixed(1)}ms right after a pane-focus click`)
    expect(r.afterNav, 'search after pane focus').toBeLessThan(1500)
  })
})
