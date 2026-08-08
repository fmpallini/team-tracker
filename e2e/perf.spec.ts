// e2e/perf.spec.ts — latency budgets on a deliberately large document.
//
// The leak spec measures memory; this one measures *time*, which nothing else
// in the repo does. Perf claims elsewhere ("scoped renders make typing
// smoother") rest on doing provably less work, not on a measurement — this
// file is what turns that into evidence, and what would catch a regression
// that reintroduces O(document) work on a per-keystroke path.
//
// The document is synthesized rather than driven through the UI: creating
// thousands of items by clicking would dominate the runtime and measure
// Playwright, not the app. It is written straight into OPFS in the app's own
// password-less `.tmv` format (`TMV-PLAIN\n` + JSON — see core/crypto.ts's
// serializePlain), then opened through the same real File System Access path
// every other e2e spec uses. `createEmptyDocument`/`createEmptyTeam` are
// imported from src so the seed can never drift from the current schema.
//
// Budgets are ceilings for "obviously broken", not targets. They are set well
// above observed values so normal machine-to-machine variance and CI noise
// don't cause flakes, while still failing loudly if a per-keystroke path
// starts scaling with document size again.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

const TEAMS = 20
const ITEMS_PER_TEAM = 100
const NOTES_PER_TEAM = 60

/** A document far larger than a realistic one, so any per-keystroke work that scales with size shows up as time rather than as a hunch. */
function buildLargeDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  for (let t = 0; t < TEAMS; t++) {
    const team = createEmptyTeam(`team-${t}`, `Team ${t}`, '🚀', 'en-US')
    for (let i = 0; i < ITEMS_PER_TEAM; i++) {
      team.actionItems.push({
        id: `t${t}-a${i}`, summary: `Action item ${i} for team ${t}`, status: 'todo',
        dueDate: null, assignee: `Person ${i % 7}`, order: i, notes: `Notes body ${i} `.repeat(4), color: 'ledger',
      })
      team.milestones.push({ id: `t${t}-m${i}`, date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, title: `Milestone ${i}`, done: false, followup: `Follow-up ${i} `.repeat(3) })
      team.risks.push({ id: `t${t}-r${i}`, title: `Risk ${i}`, chance: (i % 3) + 1, impact: (i % 3) + 1, plan: 'mitigate', followup: `Mitigation ${i} `.repeat(3), order: i, closed: false })
    }
    for (let d = 0; d < NOTES_PER_TEAM; d++) {
      const date = `2026-06-${String((d % 28) + 1).padStart(2, '0')}`
      team.dailyNotes[date] = `Daily note for ${date} in team ${t}. ${'Some body text. '.repeat(20)}`
    }
    doc.teams.push(team)
  }
  doc.nav.activeTeamId = doc.teams[0]!.id
  return doc
}

async function openLargeDoc(page: Page): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)

  const payload = `TMV-PLAIN\n${JSON.stringify(buildLargeDoc())}`
  const bytes = Array.from(new TextEncoder().encode(payload))
  await writeOpfsFile(page, 'large.tmv', bytes)
  await setNextOpenName(page, 'large.tmv')

  // Password-less files are detected from the header, so this opens straight
  // through with no password prompt.
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
}

/** Median of `runs` timings of `fn`, in ms. Median, not mean: one GC pause or one scheduler hiccup shouldn't decide whether the suite passes. */
async function timeMedian(runs: number, fn: () => Promise<void>): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now()
    await fn()
    samples.push(Date.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]!
}

test.describe(`latency on a large document (${TEAMS} teams x ${ITEMS_PER_TEAM} items)`, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test('a keystroke in a daily note commits without scaling to document size', async ({ page }) => {
    await openLargeDoc(page)

    const pane = page.locator('.tt-pane[data-pane-idx="0"]')
    await pane.locator('.tt-pane-modules-btn').click()
    await pane.locator('.tt-pane-menu-item', { hasText: /Daily/i }).first().click()
    const editor = pane.locator('.editor').first()
    await editor.click()

    // Measured inside the page so the number is the app's own work — typing
    // one character and letting the debounced store commit (plus every
    // subscriber it wakes: sidebar, calendar, save controller) settle.
    // Playwright's own IPC round trip would otherwise dominate at this scale.
    const perKeystroke = await page.evaluate(async () => {
      const ed = document.querySelector('.tt-pane[data-pane-idx="0"] .editor') as HTMLElement
      const samples: number[] = []
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
        // Let the debounce fire and every synchronous subscriber run.
        await new Promise((r) => setTimeout(r, 350))
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        samples.push(performance.now() - t0 - 350)
      }
      samples.sort((a, b) => a - b)
      return samples[Math.floor(samples.length / 2)]!
    })

    console.log(`[perf] keystroke->committed (median, minus debounce): ${perKeystroke.toFixed(1)}ms`)
    // The debounced commit fans out to the sidebar, the calendar and the save
    // controller. Before scoping, the sidebar alone rebuilt every team row on
    // this path; a regression there would blow well past this.
    expect(perKeystroke, 'keystroke commit latency').toBeLessThan(150)
  })

  test('switching modules and teams stays responsive', async ({ page }) => {
    await openLargeDoc(page)
    const pane = page.locator('.tt-pane[data-pane-idx="0"]')

    async function toModule(label: RegExp): Promise<void> {
      await pane.locator('.tt-pane-modules-btn').click()
      await pane.locator('.tt-pane-menu-item', { hasText: label }).first().click()
    }

    // Each of these renders a full board/list of ITEMS_PER_TEAM rows.
    const moduleSwitch = await timeMedian(6, async () => {
      await toModule(/Action items/i)
      await expect(pane.locator('.tt-kanban-card').first()).toBeVisible()
      await toModule(/Risks/i)
      await expect(pane.locator('.tt-risk-row').first()).toBeVisible()
    })
    console.log(`[perf] module switch pair (actions+risks, median): ${moduleSwitch}ms`)

    const teamSwitch = await timeMedian(6, async () => {
      await page.keyboard.press('Alt+2')
      await page.keyboard.press('Alt+1')
    })
    console.log(`[perf] team switch pair (median): ${teamSwitch}ms`)

    expect(moduleSwitch, 'module switch latency').toBeLessThan(2000)
    expect(teamSwitch, 'team switch latency').toBeLessThan(1500)
  })

  test('a full cross-team scan stays responsive', async ({ page }) => {
    await openLargeDoc(page)

    // Two traps make a naive search benchmark measure almost nothing, and both
    // caught this test before it was fixed:
    //
    //  - The "all teams" box is off by default, so the query only ever scanned
    //    the active team.
    //  - core/search.ts returns early at RESULT_LIMIT (50), so any common word
    //    is answered from the first team or two and the rest are never touched.
    //
    // A term that matches *nothing* is therefore the honest worst case: it
    // forces every team's candidates to be prepared and scanned in full.
    const result = await page.evaluate(async () => {
      const input = document.querySelector('.tt-search-input-box input') as HTMLInputElement
      // Open the dropdown so the scope checkbox exists, then turn it on.
      input.dispatchEvent(new Event('focus', { bubbles: true }))
      input.value = 'seed'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      const checkbox = document.querySelector('.tt-search-dropdown input[type="checkbox"]') as HTMLInputElement | null
      if (!checkbox) return { error: 'scope checkbox not found' as const }
      if (!checkbox.checked) { checkbox.click() }

      async function query(q: string): Promise<{ ms: number; rows: number }> {
        input.value = q
        const t0 = performance.now()
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 300))
        return { ms: performance.now() - t0 - 300, rows: document.querySelectorAll('.tt-search-row').length }
      }

      // Two distinct no-match terms, so neither can be answered from a
      // repeated-query shortcut. Both run against an already-prepared index —
      // the 'seed' query above necessarily warmed it in order to open the
      // dropdown, so this measures steady-state scan cost, not first-build
      // cost. Separating those two would need a sub-millisecond resolution
      // this harness doesn't have at these sizes; the steady-state number is
      // the one a user actually experiences per keystroke anyway.
      const first = await query('zzzznomatchalpha')
      const second = await query('zzzznomatchbeta')
      return { checked: checkbox.checked, cold: first, warm: second }
    })

    expect('error' in result ? result.error : null, 'scope checkbox').toBeNull()
    if ('error' in result) return
    // Guard the guard: if this ever goes false or the scans start matching,
    // the numbers below stop meaning "full cross-team scan".
    expect(result.checked, 'search scoped to all teams').toBe(true)
    expect(result.cold.rows, 'no-match query returns nothing').toBe(0)

    console.log(
      `[perf] full cross-team scan (${TEAMS} teams, steady state): ` +
      `${result.cold.ms.toFixed(1)}ms / ${result.warm.ms.toFixed(1)}ms`
    )
    // Main-thread blocking while the whole document is scanned with the index
    // warm. A regression that dropped the cache and re-prepared every team's
    // text per keystroke would land far above this.
    expect(result.cold.ms, 'full cross-team scan').toBeLessThan(1500)
    expect(result.warm.ms, 'repeat full cross-team scan').toBeLessThan(1500)
  })
})
