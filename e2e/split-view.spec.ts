// e2e/split-view.spec.ts — split view is a primary usage pattern (edit a
// daily note on the left, keep a board in view on the right), and it is also
// where the scoped-render work pays off: an edit in one pane must keep the
// *other* pane's module mounted, not tear it down and rebuild it on every
// debounced keystroke.
//
// These assert on structure, not time: a DOM node captured before the edit
// must still be the same node afterwards, and a MutationObserver on the
// other pane's root must record no wholesale child removals. A regression to
// "full renderAll() in the other pane" would fail all three at once. One
// timing test at the end guards that the other pane adds no per-keystroke
// work that scales with its item count.
//
// The document is written straight into OPFS in the app's password-less
// `.tmv` format and opened through the real File System Access path, the same
// approach perf.spec.ts uses. nav is pre-seeded split so the app comes up
// with both panes already populated — no clicking to arrange the layout.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim, writeOpfsFile, setNextOpenName } from './opfs-shim'
import { blockUpdateCheck } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc, ModuleRef } from '../src/core/types'

const ITEMS = 40
const TEAM_ID = 'team-0'
const DAILY_DATE = '2026-06-15'

/**
 * One team, `ITEMS` of each board item, one member, a month of daily notes,
 * and nav pre-set to split view with `left` in pane 0 and `right` in pane 1.
 * Large enough that a full rebuild of the right pane would be visible work,
 * small enough to open fast.
 */
function buildSplitDoc(left: ModuleRef, right: ModuleRef): Doc {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam(TEAM_ID, 'Team 0', '🚀', 'en-US')
  team.members.push({ id: 't0-p0', name: 'Dana Reed', role: 'Engineer', parentId: null, order: 0, notes: 'Initial notes.' })
  for (let i = 0; i < ITEMS; i++) {
    team.actionItems.push({
      id: `t0-a${i}`, summary: `Action item ${i}`, status: 'todo',
      dueDate: null, assignee: '', order: i, notes: `Body ${i} `.repeat(3), color: 'ledger',
    })
    team.milestones.push({ id: `t0-m${i}`, date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, title: `Milestone ${i}`, done: false, followup: '' })
    team.risks.push({ id: `t0-r${i}`, title: `Risk ${i}`, chance: (i % 3) + 1, impact: (i % 3) + 1, plan: 'mitigate', followup: '', order: i, closed: false })
  }
  for (let d = 1; d <= 28; d++) {
    team.dailyNotes[`2026-06-${String(d).padStart(2, '0')}`] = `Daily note for June ${d}.`
  }
  delete team.dailyNotes[DAILY_DATE] // start the pane's own day empty, so its has-note tint can be observed turning on
  doc.teams.push(team)

  doc.nav.activeTeamId = TEAM_ID
  doc.nav.split = true
  doc.nav.focusedPane = 0
  doc.nav.teamSplit = { [TEAM_ID]: true }
  doc.nav.panes = [
    { history: [{ teamId: TEAM_ID, ref: left }], index: 0 },
    { history: [{ teamId: TEAM_ID, ref: right }], index: 0 },
  ]
  return doc
}

async function openDoc(page: Page, doc: Doc): Promise<void> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)

  const payload = `TMV-PLAIN\n${JSON.stringify(doc)}`
  const bytes = Array.from(new TextEncoder().encode(payload))
  await writeOpfsFile(page, 'split.tmv', bytes)
  await setNextOpenName(page, 'split.tmv')
  await page.getByRole('button', { name: /Open/ }).first().click()
  await expect(page.locator('.tt-shell')).toBeVisible()
  await expect(page.locator('.tt-pane[data-pane-idx="1"]')).toBeVisible()
}

/**
 * Types `text` into pane 0's editor as one block and lets the debounced
 * commit (300ms) plus every synchronous subscriber it wakes run. Runs
 * `reps` times; when `reps > 1` the text gets a running suffix so each pass
 * is a real change.
 */
async function typeInPane0(page: Page, text: string, reps = 1): Promise<void> {
  await page.evaluate(async ({ text, reps }) => {
    const ed = document.querySelector('.tt-pane[data-pane-idx="0"] .editor') as HTMLElement
    ed.focus()
    for (let i = 0; i < reps; i++) {
      ed.innerHTML = `<div>${text}${reps > 1 ? ` ${i}` : ''}</div>`
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 340))
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }, { text, reps })
}

test.describe('split view — an edit in one pane leaves the other pane mounted', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 })

  test('typing in a daily note does not rebuild the kanban board in the other pane', async ({ page }) => {
    await openDoc(page, buildSplitDoc({ kind: 'daily', date: DAILY_DATE }, { kind: 'actions' }))
    const p1 = page.locator('.tt-pane[data-pane-idx="1"]')
    await expect(p1.locator('.tt-kanban-card').first()).toBeVisible()

    const before = await page.evaluate(() => {
      const board = document.querySelector('.tt-pane[data-pane-idx="1"] .tt-kanban-board')!
      const firstCard = board.querySelector('.tt-kanban-card')!
      firstCard.setAttribute('data-e2e-marker', '1')
      ;(window as unknown as { __clears: number }).__clears = 0
      const obs = new MutationObserver((recs) => {
        for (const r of recs) if (r.type === 'childList' && r.removedNodes.length > 0) (window as unknown as { __clears: number }).__clears++
      })
      obs.observe(board, { childList: true, subtree: true })
      ;(window as unknown as { __obs: MutationObserver }).__obs = obs
      return board.querySelectorAll('.tt-kanban-card').length
    })

    await typeInPane0(page, 'planning notes, nothing linked here', 8)

    const after = await page.evaluate(() => {
      const w = window as unknown as { __clears: number; __obs: MutationObserver }
      w.__obs.disconnect()
      const board = document.querySelector('.tt-pane[data-pane-idx="1"] .tt-kanban-board')!
      return {
        clears: w.__clears,
        markerSurvived: !!board.querySelector('.tt-kanban-card[data-e2e-marker="1"]'),
        cardCount: board.querySelectorAll('.tt-kanban-card').length,
      }
    })

    expect(after.markerSurvived, 'the pre-edit card node is still in the board').toBe(true)
    expect(after.cardCount, 'card count unchanged').toBe(before)
    expect(after.clears, 'no wholesale child removals in the other pane').toBe(0)
    // Sanity: the edit actually landed.
    expect(await page.evaluate(() => document.querySelector('.tt-pane[data-pane-idx="0"] .editor')!.textContent)).toContain('planning notes')
  })

  test('an @mention typed in a daily note adds the backlink chip to the milestone row in the other pane, in place', async ({ page }) => {
    await openDoc(page, buildSplitDoc({ kind: 'daily', date: DAILY_DATE }, { kind: 'milestones' }))
    const p1 = page.locator('.tt-pane[data-pane-idx="1"]')
    const targetRow = p1.locator('.tt-milestone-row[data-milestone-id="t0-m3"]')
    await expect(targetRow).toBeVisible()
    await expect(targetRow.locator('.tt-backlinks-chip')).toHaveCount(0)

    await page.evaluate(() => {
      const row = document.querySelector('.tt-pane[data-pane-idx="1"] .tt-milestone-row[data-milestone-id="t0-m3"]')!
      row.setAttribute('data-e2e-marker', '1')
    })

    await typeInPane0(page, 'follow up on @[Milestone 3](milestone:t0-m3) next week')

    await expect(targetRow.locator('.tt-backlinks-chip')).toHaveText('↩ 1')
    // Same row node — patched in place, not rebuilt.
    expect(
      await page.evaluate(() => !!document.querySelector(
        '.tt-pane[data-pane-idx="1"] .tt-milestone-row[data-milestone-id="t0-m3"][data-e2e-marker="1"]'
      ))
    ).toBe(true)
    // A different milestone's row is untouched and chip-less.
    await expect(p1.locator('.tt-milestone-row[data-milestone-id="t0-m4"] .tt-backlinks-chip')).toHaveCount(0)
  })

  test('a daily-note keystroke keeps the calendar mounted and refreshes the has-note tint in place', async ({ page }) => {
    await openDoc(page, buildSplitDoc({ kind: 'daily', date: DAILY_DATE }, { kind: 'risks' }))
    const p0 = page.locator('.tt-pane[data-pane-idx="0"]')
    await expect(p0.locator('.tt-calendar').first()).toBeVisible()

    const cell = p0.locator(`.tt-calendar-day[data-date="${DAILY_DATE}"]`)
    await expect(cell).not.toHaveClass(/tt-calendar-day-has-note/)

    await page.evaluate(() => {
      document.querySelector('.tt-pane[data-pane-idx="0"] .tt-calendar')!.setAttribute('data-e2e-marker', '1')
    })

    await typeInPane0(page, 'something worth noting today')

    // Calendar container was not torn down...
    expect(
      await page.evaluate(() => !!document.querySelector('.tt-pane[data-pane-idx="0"] .tt-calendar[data-e2e-marker="1"]'))
    ).toBe(true)
    // ...but the tint for the edited day is now on.
    await expect(cell).toHaveClass(/tt-calendar-day-has-note/)
  })

  test('editing a person’s notes does not rebuild the org tree in the other pane', async ({ page }) => {
    await openDoc(page, buildSplitDoc({ kind: 'person', personId: 't0-p0', group: 'members' }, { kind: 'members' }))
    const p1 = page.locator('.tt-pane[data-pane-idx="1"]')
    const node = p1.locator('.tt-people-tree').getByText('Dana Reed')
    await expect(node).toBeVisible()

    await page.evaluate(() => {
      const tree = document.querySelector('.tt-pane[data-pane-idx="1"] .tt-people-tree')!
      tree.setAttribute('data-e2e-marker', '1')
      ;(window as unknown as { __clears: number }).__clears = 0
      const obs = new MutationObserver((recs) => {
        for (const r of recs) if (r.type === 'childList' && r.removedNodes.length > 0) (window as unknown as { __clears: number }).__clears++
      })
      obs.observe(tree, { childList: true, subtree: true })
      ;(window as unknown as { __obs: MutationObserver }).__obs = obs
    })

    await typeInPane0(page, 'updated notes about Dana', 6)

    const res = await page.evaluate(() => {
      const w = window as unknown as { __clears: number; __obs: MutationObserver }
      w.__obs.disconnect()
      return {
        clears: w.__clears,
        markerSurvived: !!document.querySelector('.tt-pane[data-pane-idx="1"] .tt-people-tree[data-e2e-marker="1"]'),
      }
    })
    expect(res.markerSurvived).toBe(true)
    expect(res.clears, 'org tree not rebuilt on a person-notes keystroke').toBe(0)
  })

  test('a burst of keystrokes commits fast with a full board in the other pane', async ({ page }) => {
    await openDoc(page, buildSplitDoc({ kind: 'daily', date: DAILY_DATE }, { kind: 'risks' }))
    await expect(page.locator('.tt-pane[data-pane-idx="1"] .tt-risk-row').first()).toBeVisible()

    const perKeystroke = await page.evaluate(async () => {
      const ed = document.querySelector('.tt-pane[data-pane-idx="0"] .editor') as HTMLElement
      ed.focus()
      const samples: number[] = []
      for (let i = 0; i < 15; i++) {
        ed.innerHTML = `<div>steady editing pass ${i}</div>`
        const t0 = performance.now()
        ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 340))
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        samples.push(performance.now() - t0 - 340)
      }
      samples.sort((a, b) => a - b)
      return samples[Math.floor(samples.length / 2)]!
    })

    console.log(`[split] keystroke->committed with a ${ITEMS}-row risks pane alongside (median): ${perKeystroke.toFixed(1)}ms`)
    // Same ceiling as perf.spec.ts's single-pane budget: the second pane must
    // not add per-keystroke work that scales with its row count. A regression
    // to full renderAll() of the risks list (+ quadrant SVG) per debounce
    // would land well above this.
    expect(perKeystroke, 'keystroke commit latency in split view').toBeLessThan(150)
  })

  test('clicking an @mention chip opens its target in the other pane (openRefsInSecondaryPane) and flash-highlights it', async ({ page }) => {
    const doc = buildSplitDoc({ kind: 'daily', date: DAILY_DATE }, { kind: 'milestones' })
    doc.prefs.openRefsInSecondaryPane = true
    doc.teams[0]!.dailyNotes[DAILY_DATE] = 'kickoff tied to @[Milestone 7](milestone:t0-m7)'
    await openDoc(page, doc)

    const p0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const p1 = page.locator('.tt-pane[data-pane-idx="1"]')

    await p0.locator('.editor a.ref[data-ref="milestone:t0-m7"]').click()

    // navigateToLoc routes to the *other* pane (pane 0 keeps the daily note),
    // then flashes the resolved row with tt-search-target-flash next frame.
    await expect(p0.locator('.editor')).toBeVisible() // source pane untouched
    await expect(p1.locator('.tt-milestone-row[data-milestone-id="t0-m7"]')).toBeVisible()
    await expect(p1.locator('.tt-milestone-row[data-milestone-id="t0-m7"].tt-search-target-flash'))
      .toHaveCount(1, { timeout: 3000 })
  })
})
