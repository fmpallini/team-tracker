// e2e/leak.spec.ts — runtime leak detection, the one thing static reading of
// the source cannot do.
//
// The rest of the suite asserts on behavior. This file asserts on *resource
// growth*: it drives a long, realistic editing session and watches whether DOM
// nodes, JS event listeners and the JS heap accumulate across iterations that
// each end exactly where they started. A renderer that forgets to unsubscribe, a
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
function perCycleGrowth(samples: Counters[], key: keyof Counters): number {
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

// Overlay teardown (a modal's CSS transition, a detached node's cleanup
// microtask) can still be in flight the instant a cycle's last `await`
// resolves. Measuring then catches a transient half-torn-down state — not
// growth, just bad timing — which is what turned this test flaky: samples
// jumping between two stable node/listener counts instead of drifting.
// Two animation frames give the browser room to actually finish.
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
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
  // The previous cycle's quiesce() deliberately leaves the search dropdown
  // open with a "leak" query and focus inside the search input (see its doc
  // comment — that's the stable state it samples). Two problems for the next
  // cycle if left alone: hotkeyAllowed() refuses global hotkeys (Alt+1 below)
  // while a field is focused, and search-ui.ts's focus listener intentionally
  // *reopens* the dropdown on refocus as long as the query is non-empty
  // ("resuming focus on a query left over from before... should refresh
  // matches immediately") — so merely closing the dropdown (e.g. Escape)
  // isn't reliable: anything later in the cycle that refocuses the search
  // input (quiesce()'s own `fill('')` included, since it focuses before it
  // clears) reopens it right back over the pane bar. Clearing the value here
  // removes the only thing that reopen depends on: an empty query can never
  // repopulate results, however many times the input gets refocused. Blurring
  // afterward (rather than Escape, whose close-then-blur behavior depends on
  // whether the dropdown's already-async debounced close beat it there) is
  // what makes Alt+1 below actually fire — hotkeyAllowed() refuses global
  // hotkeys while any field still has focus.
  const searchInput = page.locator('.tt-search-input-box input')
  await searchInput.fill('')
  await searchInput.blur()

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
  await switchModule(page, /Tasks/i)
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
  for (const tab of ['Backup', 'Templates', 'Tags', 'Security', 'Data', 'About']) {
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

  // Tasks: the card modal hosts its own rich editor and date picker — the
  // one editor that lives outside the pane tree entirely.
  await switchModule(page, /Tasks/i)
  await page.locator('.tt-kanban-add-btn').first().click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Command palette, actually navigated rather than opened and dismissed.
  await page.keyboard.press('Control+k')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
}

/**
 * The surfaces the two cycles above never touch: the pane history stack, the
 * due panel, the backlinks popover, and the save + backup controllers. Every
 * step is undone (or nets to the same doc state) by the end, so N iterations
 * must cost the same as one.
 *
 * Assumes setup has left a milestone titled "Beacon" that the daily note
 * @-refs, so a `.tt-backlinks-chip` is always on its row.
 */
async function controllerCycle(page: Page, i: number): Promise<void> {
  const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')

  // Build history entries, then walk the stack both ways. A history stack
  // that grows without bound, or a nav listener re-armed per step, shows here.
  await switchModule(page, /Daily/i)
  await switchModule(page, /Risks/i)
  await switchModule(page, /Milestones/i)
  await pane0.locator('.tt-pane-back-btn').click()
  await pane0.locator('.tt-pane-back-btn').click()
  await pane0.locator('.tt-pane-fwd-btn').click()
  await pane0.locator('.tt-pane-fwd-btn').click()

  // Due panel: a document.body-appended modal no navigation reaches.
  await page.locator('.tt-due-btn').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Backlinks popover: a module-level singleton with two capturing document
  // listeners while open, appended to document.body — main.ts's teardown
  // territory, exercised here in the steady state instead.
  await switchModule(page, /Milestones/i)
  await pane0.locator('.tt-backlinks-chip').first().click()
  await expect(page.locator('.tt-backlinks-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-backlinks-panel')).toHaveCount(0)

  // Dirty the doc, then force a real save. With backup enabled in setup this
  // is one full save-controller round plus one backup-controller mirror per
  // cycle. Appending (no clear) keeps the @Beacon chip intact; the few extra
  // chars per cycle are one text node, far below the heap bound.
  await switchModule(page, /Daily/i)
  const editor = pane0.locator('.editor').first()
  await editor.click()
  await editor.type(`s${i} `, { delay: 0 })
  await page.keyboard.press('Control+s')
  await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()

  await expect(page.locator('.tt-pane-menu')).toHaveCount(0)
  await settle(page)
}

test.describe('resource growth over a long session', () => {
  // Long, serial, and CDP-bound: give it room and keep it off the parallel path.
  test.describe.configure({ mode: 'serial', timeout: 300_000 })

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
    const MEASURED = 30
    const samples: Counters[] = []

    for (let i = 0; i < WARMUP + MEASURED; i++) {
      await churnCycle(page, i)
      if (i >= WARMUP) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')
    const perCycleHeapMB = perCycleGrowth(samples, 'heapMB')

    console.log(
      `[leak] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/cycle)`
    )
    console.log('[leak] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // A real leak grows every cycle without bound. These allow a few
    // nodes/listeners of drift per cycle for bounded caches and V8 noise,
    // while still failing loudly on "one module's worth per navigation"
    // (hundreds of nodes, dozens of listeners).
    expect(perCycleNodes, 'DOM nodes retained per cycle').toBeLessThan(25)
    expect(perCycleListeners, 'JS event listeners retained per cycle').toBeLessThan(5)
    // Heap slope catches a pure-JS leak (a closure, a Map/array that grows
    // per cycle) that adds no DOM node and no listener, so the two counts
    // above stay flat while memory still climbs. Loose enough for GC
    // jitter across the run, tight enough that a retained per-cycle
    // structure of any real size trips it.
    expect(perCycleHeapMB, 'JS heap retained per cycle (MB)').toBeLessThan(1.0)
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
    const MEASURED = 20
    const samples: Counters[] = []
    for (let i = 0; i < WARMUP + MEASURED; i++) {
      await overlayCycle(page)
      await settle(page)
      if (i >= WARMUP) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')
    const perCycleHeapMB = perCycleGrowth(samples, 'heapMB')

    console.log(
      `[leak/overlays] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/cycle)`
    )
    console.log('[leak/overlays] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // An overlay that fails to unmount leaves its whole subtree plus its
    // document-level listeners behind — tens of nodes and several listeners
    // per cycle, well clear of these bounds.
    expect(perCycleNodes, 'DOM nodes retained per overlay cycle').toBeLessThan(25)
    expect(perCycleListeners, 'JS event listeners retained per overlay cycle').toBeLessThan(5)
    // A modal whose JS state (its button closures, a captured buckets array,
    // an un-removed transition listener) outlives its DOM shows up here even
    // when the node/listener counts settle.
    expect(perCycleHeapMB, 'JS heap retained per overlay cycle (MB)').toBeLessThan(1.0)
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
    for (let i = 0; i < 24; i++) {
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
    const perCycleHeapMB = perCycleGrowth(samples, 'heapMB')

    console.log(
      `[leak/reopen] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/cycle)`
    )
    console.log('[leak/reopen] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // A whole retained document is hundreds of nodes and tens of listeners,
    // so these bounds are wide enough to ignore noise and narrow enough to
    // catch that.
    expect(perCycleNodes, 'DOM nodes retained per close/reopen').toBeLessThan(40)
    expect(perCycleListeners, 'JS event listeners retained per close/reopen').toBeLessThan(6)
    // The most expensive leak shape in the app: a pinned prior document keeps
    // its whole doc object graph, store, pane manager and search index
    // reachable — megabytes, even if teardown released enough of the DOM and
    // listeners to stay under the counts above. Heap slope is the check that
    // actually covers that.
    expect(perCycleHeapMB, 'JS heap retained per close/reopen (MB)').toBeLessThan(1.5)
  })

  test('closing the file while a context menu is open does not strand the popover or its listeners', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'leak-probe-password')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Runtime.enable')

    await addTeam(page, 'Alpha')
    await switchModule(page, /Risks/i)
    await page.locator('.tt-risk-add-btn').click()

    // context-menu.ts (and backlinks-panel.ts, same shape) is a module-level
    // popover singleton, not owned by any pane/module the pane tree's own
    // disposal (modules/lifecycle.ts's disposeContainer) tears down — it
    // lives in document.body, a sibling of #app. Closing a file only clears
    // #app, so an open one would otherwise float on top of the start screen
    // forever, its two document-level listeners pinning the closed
    // document's store/pm via item.onClick closures until the next
    // showContextMenu() call anywhere in the app — see main.ts's
    // teardownApp, which now closes it explicitly.
    const samples: Counters[] = []
    for (let i = 0; i < 16; i++) {
      await page.locator('.tt-risk-row').first().click({ button: 'right' })
      await expect(page.locator('.tt-context-menu')).toBeVisible()

      // The close-file *button* itself is an outside click, which would
      // close the menu via its own normal bindOutsideDismiss mousedown
      // handler before teardownApp ever runs — masking exactly the bug this
      // test exists to catch. The keyboard shortcut fires no mousedown, so
      // the menu is still genuinely open at the moment of teardown.
      await page.keyboard.press('Control+Alt+l')
      await expect(page.locator('.tt-start-screen')).toBeVisible()
      await expect(page.locator('.tt-context-menu')).toHaveCount(0)

      await page.getByRole('button', { name: /Reopen last/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('input[name="tt-password"]').fill('leak-probe-password')
      await dialog.getByRole('button', { name: 'OK' }).click()
      await expect(page.locator('.tt-shell')).toBeVisible()
      await switchModule(page, /Risks/i)
      // Same class of problem quiesce() (above) exists to remove for the
      // other tests, one layer down: switchModule()'s own click resolves the
      // instant the DOM mutation happens, with no guarantee any
      // animation-frame-scheduled follow-up work it triggered has run yet.
      // Sampling immediately after made this test's own state bimodal —
      // whichever side of that boundary measure()'s CDP round trip happened
      // to land on read as a node/listener jump to perCycleGrowth's median
      // comparison, on a machine slow/loaded enough for the gap to matter,
      // even though nothing was actually growing cycle over cycle. Confirming
      // the pane menu is gone and the risk row is (still, deterministically)
      // mounted, then flushing two animation frames, removes the variable
      // instead of averaging over it.
      await expect(page.locator('.tt-pane-menu')).toHaveCount(0)
      await expect(page.locator('.tt-risk-row')).toHaveCount(1)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

      if (i >= 2) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')
    const perCycleHeapMB = perCycleGrowth(samples, 'heapMB')

    console.log(
      `[leak/context-menu-stranding] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/cycle)`
    )
    console.log('[leak/context-menu-stranding] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    expect(perCycleNodes, 'DOM nodes retained per cycle').toBeLessThan(40)
    expect(perCycleListeners, 'JS event listeners retained per cycle').toBeLessThan(6)
    // A stranded menu pins the closed document's store/pm through its
    // item.onClick closures — heap, not DOM, is where that mass sits.
    expect(perCycleHeapMB, 'JS heap retained per cycle (MB)').toBeLessThan(1.5)
  })

  test('history stepping, the due panel, backlinks and the save/backup controllers do not accumulate', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'leak-probe-password')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Runtime.enable')

    // Turn daily backup on: the shimmed save picker hands back a real OPFS
    // handle, so every Ctrl+S in the cycle below also drives
    // backup-controller's mirror write, not just save-controller.
    await page.locator('.tt-btn-settings').click()
    const prefs = page.getByRole('dialog')
    await prefs.locator('.tt-prefs-tab-btn', { hasText: 'Backup' }).first().click()
    const backupCheckbox = page.locator('.tt-prefs-backup-checkbox')
    await expect(backupCheckbox).toBeEnabled()
    await backupCheckbox.check()
    // pickAndStoreBackupTarget()'s picker->idbSet->store.update chain is all
    // local (OPFS + IndexedDB), no network — a bounded settle, not a flake
    // source. The prefs tab doesn't re-render on it so there's no DOM signal.
    await page.waitForTimeout(500)
    await prefs.getByRole('button', { name: 'OK' }).click()
    await expect(prefs).toHaveCount(0)

    await addTeam(page, 'Alpha')

    // A milestone with a known title, referenced once from the daily note, so
    // a backlinks chip is present on its row for every cycle to open/close.
    await switchModule(page, /Milestones/i)
    await page.locator('.tt-milestone-add-btn').click()
    const title = page.locator('.tt-pane[data-pane-idx="0"] .tt-milestone-title-input').first()
    await title.fill('Beacon')
    await title.blur()

    await switchModule(page, /Daily/i)
    const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
    await editor.click()
    await page.keyboard.type('@Beacon')
    await expect(page.locator('.tt-atref-dropdown')).toBeVisible()
    await page.keyboard.press('Enter')
    await editor.blur()

    await switchModule(page, /Milestones/i)
    await expect(page.locator('.tt-pane[data-pane-idx="0"] .tt-backlinks-chip')).toHaveCount(1)

    const WARMUP = 3
    const MEASURED = 20
    const samples: Counters[] = []
    for (let i = 0; i < WARMUP + MEASURED; i++) {
      await controllerCycle(page, i)
      if (i >= WARMUP) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')
    const perCycleHeapMB = perCycleGrowth(samples, 'heapMB')

    console.log(
      `[leak/controllers] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/cycle)`
    )
    console.log('[leak/controllers] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // Each cycle steps the pane history stack back and forward, opens and
    // closes the due panel and the backlinks popover, and forces a real
    // save + backup mirror. An unbounded history stack, a re-armed nav
    // listener, a due-panel/backlinks singleton that isn't released, or a
    // save/backup round that retains its previous payload all read as slope.
    expect(perCycleNodes, 'DOM nodes retained per controller cycle').toBeLessThan(25)
    expect(perCycleListeners, 'JS event listeners retained per controller cycle').toBeLessThan(5)
    expect(perCycleHeapMB, 'JS heap retained per controller cycle (MB)').toBeLessThan(1.0)
  })

  test('sustained editing — many debounced commits accumulate no nodes, listeners or heap', async ({ page }) => {
    await installOpfsPickerShim(page)
    await blockUpdateCheck(page)
    await page.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(page, 'leak-probe-password')

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('Runtime.enable')

    await addTeam(page, 'Alpha')
    await switchModule(page, /Daily/i)
    const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
    await editor.click()
    await editor.type('probe ', { delay: 0 })

    // Each batch fires a burst of `input` events on the editor and lets the
    // debounced store commit — and every subscriber it wakes (sidebar,
    // calendar, save controller) — settle once. The editor text is left
    // unchanged, so anything that grows batch over batch is retention on the
    // per-keystroke commit path itself, not document content: a listener
    // re-added per input, a closure pinned per commit, an unbounded
    // rev-keyed cache.
    const BATCH = 80
    const WARMUP = 4
    const MEASURED = 20
    const samples: Counters[] = []
    for (let b = 0; b < WARMUP + MEASURED; b++) {
      await page.evaluate(async (n) => {
        const ed = document.querySelector('.tt-pane[data-pane-idx="0"] .editor') as HTMLElement
        for (let k = 0; k < n; k++) ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 400))
        await new Promise((r) => requestAnimationFrame(() => r(null)))
      }, BATCH)
      if (b >= WARMUP) samples.push(await measure(cdp))
    }

    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const perCycleNodes = perCycleGrowth(samples, 'nodes')
    const perCycleListeners = perCycleGrowth(samples, 'listeners')
    const perCycleHeapMB = perCycleGrowth(samples, 'heapMB')

    console.log(
      `[leak/edit-storm] nodes ${first.nodes} -> ${last.nodes} (${perCycleNodes.toFixed(1)}/batch) | ` +
      `listeners ${first.listeners} -> ${last.listeners} (${perCycleListeners.toFixed(1)}/batch) | ` +
      `heap ${first.heapMB.toFixed(1)}MB -> ${last.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/batch)`
    )
    console.log('[leak/edit-storm] samples:', samples.map((s) => `${s.nodes}/${s.listeners}`).join(' '))

    // ~1600 commits across the measured batches. Tighter bounds than the
    // navigation cycles: nothing here mounts a module or an overlay, so a
    // clean commit path should hold these near flat.
    expect(perCycleNodes, 'DOM nodes retained per edit batch').toBeLessThan(15)
    expect(perCycleListeners, 'JS event listeners retained per edit batch').toBeLessThan(3)
    expect(perCycleHeapMB, 'JS heap retained per edit batch (MB)').toBeLessThan(0.75)
  })

  test('repeated cross-tab write-lock handoffs release their locks, channels and banner listeners', async ({ page: pageA, context }) => {
    // Two pages in one context = two real tabs on one file: same
    // navigator.locks namespace, same BroadcastChannel, same IndexedDB.
    // Context-level shims so pageB (opened below) inherits them.
    await installOpfsPickerShim(context)
    await blockUpdateCheck(context)

    const PASSWORD = 'leak-tab-lock-password'
    await pageA.goto(`${E2E_BASE_URL}/app.html`)
    await createEncryptedDoc(pageA, PASSWORD)
    await expect(pageA.locator('.tt-readonly-banner')).toHaveCount(0)

    const pageB = await context.newPage()
    await pageB.goto(`${E2E_BASE_URL}/app.html`)
    await pageB.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = pageB.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(pageB.locator('.tt-shell')).toBeVisible()
    // Starting state every cycle returns to: A holds the lock, B is read-only.
    await expect(pageB.locator('.tt-readonly-banner')).toBeVisible()
    await expect(pageA.locator('.tt-readonly-banner')).toHaveCount(0)

    const cdpA = await context.newCDPSession(pageA)
    const cdpB = await context.newCDPSession(pageB)
    for (const c of [cdpA, cdpB]) {
      await c.send('HeapProfiler.enable')
      await c.send('Runtime.enable')
    }

    // One handoff round: B takes control from A (real BroadcastChannel
    // 'takeover' -> A flushes + releases its Web Lock -> B's queued
    // locks.request() is granted), then A takes it straight back. Every
    // requestLock(true) mints a fresh lock request and a fresh releaseLock
    // closure; the BroadcastChannel and the banner element are made once per
    // open and must be reused, not re-created. A leaked lock grant (never
    // resolved), a re-bound bc.onmessage, or a banner listener re-added per
    // enterReadOnly() all show as slope on one page or the other.
    async function handoff(): Promise<void> {
      await pageB.locator('.tt-readonly-banner .tt-readonly-takeover-btn').click()
      await expect(pageA.locator('.tt-readonly-banner')).toBeVisible()
      await expect(pageB.locator('.tt-readonly-banner')).toHaveCount(0)

      await pageA.locator('.tt-readonly-banner .tt-readonly-takeover-btn').click()
      await expect(pageB.locator('.tt-readonly-banner')).toBeVisible()
      await expect(pageA.locator('.tt-readonly-banner')).toHaveCount(0)
    }

    const WARMUP = 3
    const MEASURED = 15
    const a: Counters[] = []
    const b: Counters[] = []
    for (let i = 0; i < WARMUP + MEASURED; i++) {
      await handoff()
      if (i >= WARMUP) {
        a.push(await measure(cdpA))
        b.push(await measure(cdpB))
      }
    }

    for (const [tag, s] of [['A', a], ['B', b]] as const) {
      const perCycleNodes = perCycleGrowth(s, 'nodes')
      const perCycleListeners = perCycleGrowth(s, 'listeners')
      const perCycleHeapMB = perCycleGrowth(s, 'heapMB')
      console.log(
        `[leak/tab-lock ${tag}] nodes ${s[0]!.nodes} -> ${s[s.length - 1]!.nodes} (${perCycleNodes.toFixed(1)}/cycle) | ` +
        `listeners ${s[0]!.listeners} -> ${s[s.length - 1]!.listeners} (${perCycleListeners.toFixed(1)}/cycle) | ` +
        `heap ${s[0]!.heapMB.toFixed(1)}MB -> ${s[s.length - 1]!.heapMB.toFixed(1)}MB (${perCycleHeapMB.toFixed(2)}/cycle)`
      )
      console.log(`[leak/tab-lock ${tag}] samples:`, s.map((x) => `${x.nodes}/${x.listeners}`).join(' '))
      expect(perCycleNodes, `${tag}: DOM nodes retained per handoff`).toBeLessThan(15)
      expect(perCycleListeners, `${tag}: JS event listeners retained per handoff`).toBeLessThan(3)
      expect(perCycleHeapMB, `${tag}: JS heap retained per handoff (MB)`).toBeLessThan(0.75)
    }

    await pageB.close()
  })
})
