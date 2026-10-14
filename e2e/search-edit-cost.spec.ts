// e2e/search-edit-cost.spec.ts — what an edit costs the search index, in a real
// browser, on a large document.
//
// The search index keeps each team's prepared text across edits and re-derives
// only the fields that changed (core/search.ts). Two real interactions exercise
// that, and both used to throw a team's — or the whole document's — prepared
// text away:
//
//  - a keystroke in the daily-note editor: store.update scoped to the edited
//    team's notes, which also rebuilds that team's backlinks for the day chip;
//  - a Ctrl+wheel font-size change: store.update scoped to 'prefs' alone, with
//    no team named.
//
// Each is followed by a cross-team no-match search (a full scan, never answered
// by narrowing) whose synchronous cost is timed. Numbers are logged for before/after comparison; the
// assertions are ceilings for "obviously broken" (see perf.spec.ts for the
// budgeting philosophy). test/search-incremental.test.ts holds the
// deterministic version of the same claims.
import { test, expect, type Page } from '@playwright/test'
import { TEAMS, buildLargeDoc, openLargeDoc } from './large-doc'

const SAMPLES = 7

/** A main-thread stall meter: the longest gap between two setTimeout(0) ticks between start() and stop(). */
async function installStallMeter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __stall: { start(): void; stop(): number } }
    let running = false
    let last = 0
    let maxGap = 0
    const tick = (): void => {
      if (!running) return
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      setTimeout(tick, 0)
    }
    w.__stall = {
      start() { running = true; maxGap = 0; last = performance.now(); setTimeout(tick, 0) },
      stop() { running = false; return maxGap },
    }
  })
}

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

test.describe(`edit then search on ${TEAMS} teams`, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeEach(async ({ page }) => {
    const doc = buildLargeDoc()
    const id = doc.teams[0]!.id
    doc.nav.panes = [
      { history: [{ teamId: id, ref: { kind: 'daily', date: '2026-06-15' } }], index: 0 },
      { history: [], index: -1 },
    ]
    await openLargeDoc(page, doc)
    await installStallMeter(page)
    // Open the dropdown, widen the scope to every team, and build the index once.
    const ok = await page.evaluate(async () => {
      const input = document.querySelector('.tt-search-input-box input') as HTMLInputElement
      input.dispatchEvent(new Event('focus', { bubbles: true }))
      input.value = 'seed'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      const checkbox = document.querySelector('.tt-search-dropdown input[type="checkbox"]') as HTMLInputElement | null
      if (!checkbox) return false
      if (!checkbox.checked) checkbox.click()
      return true
    })
    expect(ok, 'scope checkbox').toBe(true)
  })

  /**
   * One cross-team full scan, timed directly. Setting the value and then
   * dispatching `focus` makes search-ui run the query synchronously (its
   * focus handler re-runs whatever is in the box), so the whole of
   * index.search() — including any rebuild an earlier edit left behind — lands
   * inside the measured call. Timing a debounced `input` instead would put it
   * in a timer, and starting a meter after the focus would miss it entirely.
   */
  async function scan(page: Page, n: number): Promise<number> {
    return page.evaluate(async (i) => {
      const input = document.querySelector('.tt-search-input-box input') as HTMLInputElement
      // Distinct first letters: no query is a prefix-extension of the last one.
      input.value = `${String.fromCharCode(97 + (i % 26))}${i}zznomatch`
      const t0 = performance.now()
      input.dispatchEvent(new Event('focus', { bubbles: true }))
      const ms = performance.now() - t0
      input.dispatchEvent(new Event('input', { bubbles: true })) // leaves a pending debounce; the repeat is a no-op scan
      await new Promise((r) => setTimeout(r, 350))
      return ms
    }, n)
  }

  test('a keystroke in a note does not make the next cross-team search rebuild the team', async ({ page }) => {
    const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
    await editor.click()
    let n = 0
    await scan(page, n++) // warm
    const plain: number[] = []
    for (let i = 0; i < SAMPLES; i++) plain.push(await scan(page, n++))

    const typing: number[] = []
    const afterEdit: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      await editor.click()
      await page.evaluate(() => (window as unknown as { __stall: { start(): void } }).__stall.start())
      await page.keyboard.type('x')
      await page.waitForTimeout(700) // past the editor's input debounce, so the scoped store.update has landed
      typing.push(await page.evaluate(() => (window as unknown as { __stall: { stop(): number } }).__stall.stop()))
      afterEdit.push(await scan(page, n++))
    }
    console.log(
      `[search-edit] search latency, median of ${SAMPLES}: scan ${median(plain).toFixed(1)}ms plain | ` +
      `scan right after a note edit ${median(afterEdit).toFixed(1)}ms | the edit itself (typing + debounce + backlinks) ${median(typing).toFixed(1)}ms`
    )
    expect(median(afterEdit), 'search after a note edit').toBeLessThan(1500)
  })

  test('a font-size change does not make the next cross-team search rebuild everything', async ({ page }) => {
    let n = 0
    await scan(page, n++) // warm
    const plain: number[] = []
    for (let i = 0; i < SAMPLES; i++) plain.push(await scan(page, n++))

    const afterPref: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      // Alternate direction so the size never clamps at either end and every wheel is a real change.
      await page.evaluate((dir) => {
        document.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: dir * 100, deltaMode: 0, bubbles: true, cancelable: true }))
      }, i % 2 === 0 ? -1 : 1)
      afterPref.push(await scan(page, n++))
    }
    console.log(
      `[search-edit] search latency, median of ${SAMPLES}: scan ${median(plain).toFixed(1)}ms plain | ` +
      `scan right after a font-size change ${median(afterPref).toFixed(1)}ms`
    )
    expect(median(afterPref), 'search after a font-size change').toBeLessThan(1500)
  })
})
