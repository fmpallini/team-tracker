// scripts/generate-screenshots.mjs — re-renders docs/screenshots/*.png by
// driving the real dist/app.html UI (Playwright, not test runner) through a
// realistic multi-team doc. Run by hand before a README screenshot refresh
// (`npm run build && node scripts/generate-screenshots.mjs`) — it is NOT
// part of `npm run test:e2e` / CI (playwright.config.ts's testDir only picks
// up e2e/*.spec.ts, this file lives in scripts/ and is never matched).
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { forceFallbackMode } from '../e2e/opfs-shim.ts'
import { blockUpdateCheck } from '../e2e/helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_URL = 'file://' + path.resolve(HERE, '../dist/app.html')
const SHOT_DIR = path.resolve(HERE, '../docs/screenshots')

// Which theme/palette each README screenshot should show — edit this table
// to change what a future run produces without touching the flow below.
// `palette: null` means "leave the default (ledger) untouched".
const SCREENSHOTS = [
  { file: 'daily-notes-and-org.png', theme: 'light', palette: null, view: 'daily-and-org' },
  { file: 'action-items-kanban.png', theme: 'dark', palette: 'ember', view: 'kanban' },
  { file: 'milestones.png', theme: 'light', palette: 'blueprint', view: 'milestones' },
  { file: 'risks.png', theme: 'dark', palette: 'synthwave', view: 'risks' },
  { file: 'command-palette.png', theme: 'dark', palette: 'cosmic', view: 'command-palette' },
  { file: 'global-search.png', theme: 'light', palette: 'verdant', view: 'global-search' },
]

async function createTeam(page, name, emoji, first) {
  if (first) {
    await page.getByRole('button', { name: /Create first team/ }).click()
  } else {
    await page.locator('.tt-team-add-btn').click()
  }
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.locator('input[name="tt-team-emoji"]').fill(emoji)
  // Focusing the emoji field opens a picker popup (src/ui/emoji-picker.ts)
  // that intercepts pointer events until dismissed — a real click outside it
  // (but not Escape, which would also close the whole dialog) closes it.
  await dialog.locator('input[name="tt-team-name"]').click()
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

async function switchPaneModule(page, paneIdx, label) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await pane.locator('.tt-pane-modules-btn').click()
  await pane.locator('.tt-pane-menu-item', { hasText: label }).first().click()
}

async function addPerson(page, paneIdx, name, role, addBtnSelector) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await pane.locator(addBtnSelector).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-person-name"]').fill(name)
  await dialog.locator('input[name="tt-person-role"]').fill(role)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

async function addChildPerson(page, paneIdx, parentName, childName, role) {
  const pane = page.locator(`.tt-pane[data-pane-idx="${paneIdx}"]`)
  await pane.locator('.tt-org-box', { hasText: parentName }).locator('.tt-people-add-child-btn').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-person-name"]').fill(childName)
  await dialog.locator('input[name="tt-person-role"]').fill(role)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

async function typeIntoEditor(editor, text) {
  await editor.click()
  await editor.pressSequentially(text, { delay: 1 })
}

async function setThemePalette(page, theme, palette) {
  await page.locator('.tt-btn-settings').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator(`input[name="tt-prefs-theme"][value="${theme}"]`).check({ force: true })
  if (palette) {
    await dialog.locator(`input[name="tt-prefs-palette"][value="${palette}"]`).check({ force: true })
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(200)
}

/**
 * Expands the first (highest-exposure) risk row and fills in a mitigation
 * plan. "Expanded" is ephemeral UI state (not persisted in the doc), so this
 * must run immediately before the risks screenshot is taken — any team
 * switch or pane-module change remounts the Risks module fresh and drops it.
 */
async function expandFirstRiskWithMitigation(page) {
  const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
  await blurAway(page) // no stray focus left over to race the click below
  const firstRow = pane0.locator('.tt-risk-row').first()
  await firstRow.locator('.tt-risk-expand-btn').click()
  await typeIntoEditor(
    pane0.locator('.tt-risk-followup-row .editor').first(),
    'Run the migration during the lowest-traffic window (Sat 02:00 UTC); keep rollback snapshots hot for 48h; ' +
    'on-call rotation fully staffed for the whole cutover.'
  )
  await blurAway(page)
}

async function shoot(page, file) {
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(SHOT_DIR, file) })
  console.log(`  wrote ${file}`)
}

async function blurAway(page) {
  await page.locator('body').click({ position: { x: 5, y: 5 } })
}

/**
 * Milestones/risks sort their list by date/manual-order — not insertion
 * order — so after clicking "+ Milestone"/"+ Risk" the new row is not
 * reliably `.first()` or `.last()`. Both modules auto-focus the new row's
 * title input (see focusMilestoneId/focusRiskId in their renderers), so find
 * it via the real DOM focus state and resolve back up to its row's stable id
 * attribute, then return a locator scoped to that specific row.
 */
async function focusedRow(page, rowSelector, idAttr) {
  await page.waitForFunction(
    (sel) => document.activeElement?.closest(sel) != null,
    rowSelector
  )
  const id = await page.evaluate(
    ({ sel, attr }) => document.activeElement.closest(sel).getAttribute(attr),
    { sel: rowSelector, attr: idAttr }
  )
  return page.locator(`${rowSelector}[${idAttr}="${id}"]`)
}

async function buildContent(page) {
  // --- Team 1: Platform Engineering ------------------------------------------
  await createTeam(page, 'Platform Engineering', '🚀', true)
  await expect(page.locator('.tt-shell')).toBeVisible()
  // First-ever team open lands split: pane0 = Daily notes, pane1 = Members.

  // Members: three-level org tree — Miguel (root) -> Mei & Aisha (children),
  // each with their own report, so the org chart screenshot shows real depth.
  await addPerson(page, 1, 'Miguel Fernandez', 'Senior Backend Engineer', '.tt-people-add-btn')
  await addChildPerson(page, 1, 'Miguel Fernandez', 'Mei Chen', 'Platform Engineer')
  await addChildPerson(page, 1, 'Mei Chen', 'Diego Silva', 'Associate Platform Engineer')
  await addChildPerson(page, 1, 'Miguel Fernandez', 'Aisha Patel', 'Site Reliability Lead')
  await addChildPerson(page, 1, 'Aisha Patel', 'Tom Becker', 'Site Reliability Engineer')

  // Stakeholders: Priya (temporarily switch pane1, then switch back to Members)
  await switchPaneModule(page, 1, /Stakeholders/i)
  await addPerson(page, 1, 'Priya Anand', 'Engineering Manager', '.tt-people-add-btn')
  await switchPaneModule(page, 1, /Members/i)

  // Daily note on pane0
  await typeIntoEditor(
    page.locator('.tt-pane[data-pane-idx="0"] .editor').first(),
    'Kicked off the Q3 platform migration today. Walked Priya and Miguel through the new cluster topology; ' +
    'Mei is pairing with SRE on the rollout plan. Next check-in Thursday.'
  )
  await blurAway(page)

  // --- Tasks (kanban) on pane0 -------------------------------------------------
  await switchPaneModule(page, 0, /Tasks/i)
  {
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const cards = [
      { column: 'To Do', title: 'Cut over auth service to new K8s cluster', date: '08/20/2026', assignee: 'Miguel Fernandez', chip: 0 },
      { column: 'To Do', title: 'Write postmortem template for cutover retro', date: '08/25/2026', assignee: 'Aisha Patel', chip: 3 },
      { column: 'WIP', title: 'Draft rollback runbook for cutover weekend', date: '08/18/2026', assignee: 'Mei Chen', chip: 2 },
      { column: 'WIP', title: 'Provision staging cluster for dry-run', date: '08/16/2026', assignee: 'Diego Silva', chip: 4 },
    ]
    for (const c of cards) {
      await pane0.locator('.tt-kanban-col', { hasText: c.column }).locator('.tt-kanban-add-btn').click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('.tt-kanban-form input.tt-input').first().fill(c.title)
      // .fill() (not click + type-digits): the date field's mask logic
      // (src/ui/date-picker.ts's onInput) reads digitsOnly() from the *whole*
      // current field value, so typing digits at whatever cursor position a
      // plain click leaves behind can interleave with any pre-existing text
      // instead of replacing it. .fill() replaces the value outright, which
      // the mask logic then parses cleanly regardless of what was there before.
      await dialog.locator('.tt-date-picker-input').fill(c.date)
      await dialog.locator('.tt-kanban-form input.tt-input').first().click()
      await dialog.locator('.tt-kanban-form-row input.tt-input:not(.tt-date-picker-input)').fill(c.assignee)
      await dialog.locator('.tt-kanban-color-chip').nth(c.chip).click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()
    }
  }

  // --- Milestones on pane0 ------------------------------------------------------
  await switchPaneModule(page, 0, /Milestones/i)
  {
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const milestones = [
      { title: 'Kickoff & discovery complete', date: '06/01/2026', done: true },
      { title: 'Alpha cluster cutover', date: '05/01/2026', done: false }, // overdue
      { title: 'Beta rollout to all services', date: '09/15/2026', done: false },
      { title: 'GA / legacy cluster decommission', date: '10/30/2026', done: false },
    ]
    for (const m of milestones) {
      await pane0.locator('.tt-milestone-add-btn').click()
      const row = await focusedRow(page, '.tt-milestone-row', 'data-milestone-id')
      // Date first, while the row is still pristine: milestones/risks commit
      // each field live (unlike the kanban modal's local-state-until-Save),
      // so a still-focused *and dirtied* field blurring mid-click can trigger
      // a commit-triggered rerender that swaps the click's target out from
      // under it (mousedown lands on the pre-rerender node, mouseup on its
      // replacement, and no 'click' event fires for either — verified via a
      // page.evaluate event trace while debugging this script). The date
      // input's own auto-commit-on-valid-value doesn't need a trailing blur,
      // so setting it before the title is untouched (nothing dirty to race).
      // .fill() (not click + type-digits): a new milestone row's date field
      // is pre-populated with today's date, not empty — typing raw digits at
      // whatever cursor position a plain click leaves interleaves with that
      // existing text instead of replacing it. .fill() replaces outright.
      await row.locator('.tt-milestone-date-input .tt-date-picker-input').fill(m.date)
      await row.locator('.tt-milestone-title-input').click() // closes the date popover, focuses title
      await row.locator('.tt-milestone-title-input').fill(m.title)
      await blurAway(page) // commit the title safely before the next (possibly coordinate-based) click
      if (m.done) await row.locator('.tt-milestone-done-checkbox').click()
    }
  }

  // --- Risks on pane0 ------------------------------------------------------------
  await switchPaneModule(page, 0, /Risks/i)
  {
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const risks = [
      { title: 'Cloud provider outage during migration window', chance: '3', impact: '3' },
      { title: 'Key engineer unavailable for cutover (Miguel on leave)', chance: '1', impact: '2' },
      { title: 'Budget overrun on new cluster licensing', chance: '2', impact: '2' },
    ]
    for (const r of risks) {
      await pane0.locator('.tt-risk-add-btn').click()
      const row = await focusedRow(page, '.tt-risk-row', 'data-risk-id')
      await row.locator('.tt-risk-title-input').fill(r.title)
      await row.locator('.tt-risk-chance-select').selectOption(r.chance)
      await row.locator('.tt-risk-impact-select').selectOption(r.impact)
    }
    await blurAway(page)
    // Deliberately not expanded here: "expanded" is ephemeral UI state kept
    // in the module's own closure, not in the doc — team switches and pane
    // module changes (both of which happen several more times before the
    // risks screenshot is actually taken) remount the module fresh and lose
    // it. expandFirstRiskWithMitigation() runs later, right before that
    // screenshot, instead.
  }

  // --- Team 2: Design ----------------------------------------------------------
  await createTeam(page, 'Design', '🎨', false)
  await addPerson(page, 1, 'Elena Cruz', 'Product Designer', '.tt-people-add-btn')
  await typeIntoEditor(
    page.locator('.tt-pane[data-pane-idx="0"] .editor').first(),
    'Reviewed the Q3 platform migration timeline with Platform Engineering — no blocking UI dependencies, ' +
    'just need updated status-page mockups before the cutover.'
  )
  await blurAway(page)

  // --- Team 3: Data & Analytics --------------------------------------------------
  await createTeam(page, 'Data & Analytics', '📊', false)
  await addPerson(page, 1, 'Sam Okafor', 'Data Analyst', '.tt-people-add-btn')
  await typeIntoEditor(
    page.locator('.tt-pane[data-pane-idx="0"] .editor').first(),
    'Flagged a dependency on the platform migration: our nightly ETL jobs read from the cluster being replaced, ' +
    'so we need the new endpoints before cutover weekend.'
  )
  await blurAway(page)

  // Switch back to team 1 for the remaining screenshots.
  await page.locator('.tt-team-item').first().click()
  await expect(page.locator('.tt-pane[data-pane-idx="0"]')).toBeVisible()
}

async function main() {
  const browser = await chromium.launch()
  // App locale follows navigator.language (src/main.ts detectBrowserLocale) —
  // pin it to en-US like playwright.config.ts does for the test runner, so
  // button/dialog copy is deterministic regardless of the host OS locale.
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, acceptDownloads: true, locale: 'en-US' })
  await forceFallbackMode(context)
  await blockUpdateCheck(context)
  const page = await context.newPage()

  try {
    await page.goto(APP_URL)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /Create new/ }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.locator('input[name="tt-password"]').fill('screenshot-pw')
    await createDialog.locator('input[name="tt-password-confirm"]').fill('screenshot-pw')
    await createDialog.getByRole('button', { name: 'OK' }).click()
    await downloadPromise
    await expect(page.locator('.tt-shell')).toBeVisible()

    // Dismiss the post-create toast once — it won't reappear.
    const toast = page.locator('.tt-toast')
    if (await toast.count() > 0) await toast.first().click()

    console.log('Building doc content (3 teams, org tree, daily notes, tasks, milestones, risks)...')
    await buildContent(page)

    console.log('Rendering screenshots...')
    for (const shot of SCREENSHOTS) {
      // Theme/palette first: command-palette and global-search open overlays
      // that cover the settings button, so prefs must be set before they open.
      await setThemePalette(page, shot.theme, shot.palette)

      switch (shot.view) {
        case 'daily-and-org':
          await switchPaneModule(page, 0, /Daily/i)
          await switchPaneModule(page, 1, /Members/i)
          break
        case 'kanban':
          await switchPaneModule(page, 0, /Tasks/i)
          if (await page.locator('.tt-pane[data-pane-idx="1"]').isVisible()) {
            await page.locator('.tt-pane-split-btn').first().click() // unsplit for a full-width board
          }
          break
        case 'milestones':
          await switchPaneModule(page, 0, /Milestones/i)
          break
        case 'risks':
          await switchPaneModule(page, 0, /Risks/i)
          await expandFirstRiskWithMitigation(page)
          break
        case 'command-palette':
          // Leave the query empty — filterModuleItems() (src/ui/palette.ts)
          // returns every fast-switch item unfiltered when the query is
          // blank, so the screenshot shows the full list instead of one match.
          await page.keyboard.press('Control+k')
          await expect(page.locator('.tt-palette-overlay')).toBeVisible()
          break
        case 'global-search':
          await page.locator('.tt-search-input').click()
          await page.locator('.tt-search-input').fill('migration')
          // The results dropdown (and the "all teams" checkbox inside it)
          // only appears after the 300ms input debounce (src/ui/search-ui.ts)
          // runs the search — wait for it to open before interacting inside it.
          await expect(page.locator('.tt-search-dropdown')).toHaveClass(/open/, { timeout: 5000 })
          await page.locator('.tt-search-all-teams input[type="checkbox"]').check({ force: true })
          await page.waitForTimeout(400)
          await expect(page.locator('.tt-search-dropdown')).toHaveClass(/open/)
          break
        default:
          throw new Error(`Unknown view: ${shot.view}`)
      }

      await shoot(page, shot.file)

      if (shot.view === 'command-palette') await page.keyboard.press('Escape')
    }

    console.log('Done.')
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
