// e2e/leak.spec.ts — runtime leak detection, the one thing static reading of
// the source cannot do.
//
// The rest of the suite asserts on behavior. This file asserts on *resource
// growth*: it drives a long, realistic editing session and watches whether DOM
// nodes and JS event listeners accumulate across iterations that each end
// exactly where they started. A renderer that forgets to unsubscribe, a
// dropdown that outlives its module, a listener re-armed per mutation (the
// class of bug fixed in risks.ts/milestones.ts) all show up here as a slope
// that doesn't flatten, even when every functional test still passes.
//
// Measurement comes from CDP rather than the page: `Memory.getDOMCounters`
// reports the renderer's real node/listener totals including nodes detached
// from the document but still retained by JS — which is precisely what a leak
// looks like and what `document.querySelectorAll('*').length` cannot see.
// `HeapProfiler.collectGarbage` forces a real GC first so what's left is
// genuinely reachable, not merely uncollected.
//
// Thresholds are deliberately loose. The goal is catching unbounded growth
// (leak: +N per cycle, forever), not policing small constant deltas — caches
// that fill once, a lazily-built dropdown, V8's own bookkeeping all add a
// bounded amount that never repeats. Growth is therefore measured across the
// *second half* of the run, after one-time costs have settled.
import { test, expect, type Page, type CDPSession } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

interface Counters { nodes: number; listeners: number; heapMB: number }

/**
 * Per-cycle growth, measured as median-of-first-half vs median-of-second-half
 * rather than last-minus-first.
 *
 * The counts oscillate within a bounded band: a transient overlay (pane module
 * menu, a dropdown) can be up or down at the moment a sample is taken, worth
 * tens of nodes either way. Comparing single endpoints turns that band into
 * phantom slope — the same clean run reads 0.9/cycle or 7.1/cycle purely on
 * where the last sample happened to land. Medians ignore the oscillation and
 * still track a genuine monotonic climb, which is the only thing being tested.
 */
function perCycleGrowth(samples: Counters[], key: 'nodes' | 'listeners'): number {
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
  }
  const half = Math.floor(samples.length / 2)
  const firstHalf = samples.slice(0, half).map((s) => s[key])
  const secondHalf = samples.slice(samples.length - half).map((s) => s[key])
  // The two medians sit `samples.length - half` cycles apart on average.
  return (median(secondHalf) - median(firstHalf)) / (samples.length - half)
}

async function measure(cdp: CDPSession): Promise<Counters> {
  // Two GCs: the first can resurrect objects into a later generation, the
  // second collects what that first pass made unreachable.
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const dom = (await cdp.send('Memory.getDOMCounters')) as unknown as {
    documents: number; nodes: number; jsEventListeners: number
  }
  const heap = (await cdp.send('Runtime.getHeapUsage')) as unknown as { usedSize: number }
  return { nodes: dom.nodes, listeners: dom.jsEventListeners, heapMB: heap.usedSize / 1024 / 1024 }
}

async function addTeam(page: Page, name: string): Promise<void> {
  await page.locator('.tt-team-add-btn').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Opens pane 0's module menu and picks the entry with the given label. */
async function switchModule(page: Page, label: string | RegExp): Promise<void> {
  const pane = page.locator('.tt-pane[data-pane-idx="0"]')
  await pane.locator('.tt-pane-modules-btn').click()
  await pane.locator('.tt-pane-menu-item', { hasText: label }).first().click()
}

/**
 * One full round trip through the app's mount/unmount surface. Every step is
 * undone by the end, so N iterations must cost the same as 1 — anything that
 * scales with N is being retained.
 */
async function churnCycle(page: Page, i: number): Promise<void> {
  // Pin the team first so the note below always lands in the same one. Search
  // is scoped to the active team, and quiesce() counts hits — without this the
  // cycle would type into whichever team the previous cycle happened to leave
  // active, and the count would depend on history.
  await page.keyboard.press('Alt+1')

  // Type into a rich editor: mounts the editor + @ref autocomplete + template
  // picker bundle, and dirties the store.
  await switchModule(page, /Daily/i)
  const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
  await editor.click()
  await editor.fill('')
  await editor.type(`leak probe ${i} `, { delay: 0 })

  // Modules with their own subscriptions, DnD wiring and expandable rows.
  await switchModule(page, /Action items/i)
  await switchModule(page, /Milestones/i)
  await switchModule(page, /Risks/i)
  await switchModule(page, /Members/i)

  // Split on/off: mounts and disposes a whole second pane each way.
  await page.locator('.tt-pane[data-pane-idx="0"] .tt-pane-split-btn').click()
  await page.locator('.tt-pane[data-pane-idx="0"] .tt-pane-split-btn').click()

  // Team switch: restores a different layout and remounts both panes.
  await page.keyboard.press('Alt+2')
  await page.keyboard.press('Alt+1')

  // Command palette + search: document-level listeners, dropdown overlays.
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Escape')

  await quiesce(page)
}

/**
 * Leaves the UI in one fixed, fully-rendered state before a sample is taken.
 *
 * Without this the counts are bimodal rather than noisy: a cycle can end with
 * the search results list rendered (~68 extra nodes) or not, depending on
 * whether the debounced search had fired yet. Sampling across two discrete
 * states makes any summary statistic — endpoints or medians alike — report
 * slope that isn't there. Remove the variable instead of averaging over it.
 *
 * Quiescing to a *populated* list rather than an empty one is deliberate:
 * search-ui.ts's runSearch() closes the dropdown on an empty query without
 * re-rendering, so the previous rows stay in the DOM (bounded — replaced, never
 * accumulated). "Zero rows" is therefore unreachable; "always exactly these
 * rows" is, and is equally deterministic.
 */
async function quiesce(page: Page): Promise<void> {
  const input = page.locator('.tt-search-input-box input')
  await input.fill('')
  await input.fill('leak')
  // Exactly one hit: the daily note this cycle just wrote in the active team,
  // which is the only text in the document containing "leak".
  await expect(page.locator('.tt-search-row')).toHaveCount(1)
  // The pane module menu must be shut, or its subtree lands in the sample too.
  await expect(page.locator('.tt-pane-menu')).toHaveCount(0)
}

/**
 * Every overlay surface the navigation cycle never reaches: modals, popups,
 * pickers, context menus, and the expandable follow-up editors.
 *
 * These are the likeliest place for a leak to hide — each one appends to
 * document.body (not into a pane), and several register capturing
 * document-level listeners while open, so nothing in the pane manager's
 * teardown covers them. Opening and closing each one N times must cost the
 * same as once.
 */
async function overlayCycle(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')

  // Preferences: the largest modal in the app, and the one with tabs that each
  // build their own DOM (including the password strength meter).
  await page.locator('.tt-btn-settings').click()
  await expect(dialog).toBeVisible()
  for (const tab of ['Advanced', 'Templates', 'Tags', 'Security', 'Data', 'About']) {
    await dialog.locator('.tt-prefs-tab-btn', { hasText: tab }).first().click()
  }
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toHaveCount(0)

  // Help modal.
  await page.locator('.tt-btn-help').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Team edit modal — carries an emoji picker bound to its input.
  await page.locator('.tt-team-item').first().hover()
  await page.locator('.tt-team-edit-btn').first().click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Not covered here: the due-dates panel. Its trigger is hidden unless the
  // document actually has overdue/due-soon items, and seeding those would stop
  // this cycle netting to zero — which is the property the whole measurement
  // rests on. It stays a known gap rather than a distorted cycle.

  // In-editor dropdowns: the @ref autocomplete and the '/' template picker
  // both append to document.body and hold a capturing document listener while
  // open — exactly what modules/lifecycle.ts's disposal exists for.
  await switchModule(page, /Daily/i)
  const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
  await editor.click()
  await editor.fill('')
  await page.keyboard.type('@')
  await page.keyboard.press('Escape')
  await page.keyboard.type('/')
  await page.keyboard.press('Escape')
  await editor.fill('')

  // Risks: add a row, expand its follow-up (mounts a whole rich-editor bundle
  // via ExpandableRowsController), collapse it, open the row context menu,
  // then delete the row so the cycle nets to zero.
  await switchModule(page, /Risks/i)
  await page.locator('.tt-risk-add-btn').click()
  await page.locator('.tt-risk-expand-btn').first().click()
  await expect(page.locator('.tt-risk-followup-row .editor')).toHaveCount(1)
  await page.locator('.tt-risk-expand-btn').first().click()
  await page.locator('.tt-risk-row').first().click({ button: 'right' })
  await page.keyboard.press('Escape')
  await page.locator('.tt-risk-delete-btn').first().click()
  await expect(page.locator('.tt-risk-row')).toHaveCount(0)

  // Milestones: same shape, plus its own date picker.
  await switchModule(page, /Milestones/i)
  await page.locator('.tt-milestone-add-btn').click()
  await page.locator('.tt-milestone-expand-btn').first().click()
  await expect(page.locator('.tt-milestone-followup-row .editor')).toHaveCount(1)
  await page.locator('.tt-milestone-expand-btn').first().click()
  await page.locator('.tt-milestone-delete-btn').first().click()
  await expect(page.locator('.tt-milestone-row')).toHaveCount(0)

  // Action items: the card modal hosts its own rich editor and date picker —
  // the one editor that lives outside the pane tree entirely.
  await switchModule(page, /Action items/i)
  await page.locator('.tt-kanban-add-btn').first().click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Command palette, actually navigated rather than opened and dismissed.
  await page.keyboard.press('Control+k')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
}

test.describe('resource growth over a long session', () => {
  // Long, serial, and CDP-bound: give it room and keep it off the parallel path.
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test('repeated edit/navigate cycles do not accumulate DOM nodes or listeners', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'leak-probe-password')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Runtime.enable')

    await addTeam(page, 'Alpha')
    await addTeam(page, 'Beta')

    // Warm-up: first cycles build one-time structures (module DOM, caches,
    // compiled code) that never repeat. Measuring from cycle 0 would read
    // those as growth.
    const WARMUP = 3
    const MEASURED = 12
    const samples: Counters[] = []

    for (let i = 0; i < WARMUP + MEASURED; i++) {
      await churnCycle(page, i)
      if (i >= WARMUP) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')

    console.log(
      `[leak] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB`
    )
    console.log('[leak] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // A real leak grows every cycle without bound. These allow a few
    // nodes/listeners of drift per cycle for bounded caches and V8 noise,
    // while still failing loudly on "one module's worth per navigation"
    // (hundreds of nodes, dozens of listeners).
    expect(perCycleNodes, 'DOM nodes retained per cycle').toBeLessThan(25)
    expect(perCycleListeners, 'JS event listeners retained per cycle').toBeLessThan(5)
  })

  test('modals, popups and expandable rows release their DOM and listeners', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'leak-probe-password')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Runtime.enable')

    await addTeam(page, 'Alpha')

    const WARMUP = 2
    const MEASURED = 8
    const samples: Counters[] = []
    for (let i = 0; i < WARMUP + MEASURED; i++) {
      await overlayCycle(page)
      if (i >= WARMUP) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')

    console.log(
      `[leak/overlays] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB`
    )
    console.log('[leak/overlays] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // An overlay that fails to unmount leaves its whole subtree plus its
    // document-level listeners behind — tens of nodes and several listeners
    // per cycle, well clear of these bounds.
    expect(perCycleNodes, 'DOM nodes retained per overlay cycle').toBeLessThan(25)
    expect(perCycleListeners, 'JS event listeners retained per overlay cycle').toBeLessThan(5)
  })

  test('close-file → reopen cycles release the previous document', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'leak-probe-password')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Runtime.enable')

    await addTeam(page, 'Alpha')

    // This is the cycle main.ts's dispose()/teardownApp() exists for: each
    // close-file must release that document's store subscriptions, its
    // document-level hotkey/visibilitychange/beforeunload listeners, its pane
    // manager and its whole shell DOM. A miss here pins an entire prior
    // document per cycle — the most expensive leak shape in the app.
    const samples: Counters[] = []
    for (let i = 0; i < 8; i++) {
      await page.locator('.tt-pane[data-pane-idx="0"] .editor').first().click()
      await page.keyboard.type(`cycle ${i}`)

      await page.locator('.tt-btn-close-file').click()
      await expect(page.locator('.tt-start-screen')).toBeVisible()

      await page.getByRole('button', { name: /Reopen last/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('input[name="tt-password"]').fill('leak-probe-password')
      await dialog.getByRole('button', { name: 'OK' }).click()
      await expect(page.locator('.tt-shell')).toBeVisible()

      if (i >= 2) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')

    console.log(
      `[leak/reopen] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB`
    )
    console.log('[leak/reopen] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // A whole retained document is hundreds of nodes and tens of listeners,
    // so these bounds are wide enough to ignore noise and narrow enough to
    // catch that.
    expect(perCycleNodes, 'DOM nodes retained per close/reopen').toBeLessThan(40)
    expect(perCycleListeners, 'JS event listeners retained per close/reopen').toBeLessThan(6)
  })
})
