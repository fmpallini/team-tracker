// scripts/generate-demo-video.mjs — records the full feature-tour video of
// the real dist/app.html UI (Playwright, not the test runner). Run by hand
// (`npm run build && node scripts/generate-demo-video.mjs`) — not part of
// `npm run test:e2e` / CI, lives in scripts/ so playwright.config.ts's testDir
// (./e2e) never picks it up. Shared plumbing (overlay/cursor/captions, mouse
// + typing helpers, server/browser/video harness) lives in
// scripts/demo-video-lib.mjs — see its header for the why. For a ~60s highlight
// cut, see scripts/generate-demo-video-short.mjs.
import { expect } from '@playwright/test'
import {
  runDemo, caption, hideCaption, pause, click, type, blurAway, focusedRow, moveMouseTo,
  createTeam, switchPaneModule, addPerson, addChildPerson, typeIntoEditor,
  PASSWORD,
} from './demo-video-lib.mjs'

const PORT = 4320 // distinct from playwright.config.ts's E2E_PORT (4319) so this can run alongside `npm run test:e2e`
const OUT_FILE = 'feature-tour.webm'

async function buildContent(page) {
  await createTeam(page, 'Platform Engineering', '🚀', true)
  await expect(page.locator('.tt-shell')).toBeVisible()

  await caption(page, 'Org chart — people, roles, reporting lines')
  await hideCaption(page)
  await addPerson(page, 1, 'Miguel Fernandez', 'Senior Backend Engineer')
  await addChildPerson(page, 1, 'Miguel Fernandez', 'Mei Chen', 'Platform Engineer')
  await addChildPerson(page, 1, 'Miguel Fernandez', 'Aisha Patel', 'Site Reliability Lead')
  await pause(page, 500)

  await caption(page, 'Daily notes, written like a journal')
  await hideCaption(page)
  await typeIntoEditor(
    page,
    page.locator('.tt-pane[data-pane-idx="0"] .editor').first(),
    'Kicked off the Q3 platform migration today. Walked the team through the new cluster topology.'
  )
  await blurAway(page)
  await pause(page, 500)

  await caption(page, 'Action items on a kanban board')
  await hideCaption(page)
  await switchPaneModule(page, 0, /Tasks/i)
  {
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const cards = [
      { column: 'To Do', title: 'Cut over auth service to new K8s cluster', date: '08/20/2026', assignee: 'Miguel Fernandez', chip: 0 },
      { column: 'WIP', title: 'Draft rollback runbook for cutover weekend', date: '08/18/2026', assignee: 'Mei Chen', chip: 2 },
    ]
    for (const c of cards) {
      await click(page, pane0.locator('.tt-kanban-col', { hasText: c.column }).locator('.tt-kanban-add-btn'))
      const dialog = page.getByRole('dialog')
      await type(page, dialog.locator('.tt-kanban-form input.tt-input').first(), c.title)
      // .fill() (not typed keystrokes): the date field's mask logic reads the
      // whole current value on every input, so real keystrokes at a
      // click-placed cursor can interleave with existing text. click() alone
      // still gives the cursor overlay something to travel to first.
      await click(page, dialog.locator('.tt-date-picker-input'))
      await dialog.locator('.tt-date-picker-input').fill(c.date)
      await click(page, dialog.locator('.tt-kanban-form input.tt-input').first()) // closes date popover
      await type(page, dialog.locator('.tt-kanban-form-row input.tt-input:not(.tt-date-picker-input)'), c.assignee)
      await click(page, dialog.locator('.tt-kanban-color-chip').nth(c.chip))
      await click(page, dialog.getByRole('button', { name: 'Save' }))
      await expect(dialog).toBeHidden()
      await pause(page, 300)
    }
  }
  await pause(page, 500)

  await caption(page, 'Milestones with due dates')
  await hideCaption(page)
  await switchPaneModule(page, 0, /Milestones/i)
  {
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const milestones = [
      { title: 'Alpha cluster cutover', date: '05/01/2026', done: false },
      { title: 'Beta rollout to all services', date: '09/15/2026', done: false },
    ]
    for (const m of milestones) {
      await click(page, pane0.locator('.tt-milestone-add-btn'))
      const row = await focusedRow(page, '.tt-milestone-row', 'data-milestone-id')
      await click(page, row.locator('.tt-milestone-date-input .tt-date-picker-input'))
      await row.locator('.tt-milestone-date-input .tt-date-picker-input').fill(m.date)
      await click(page, row.locator('.tt-milestone-title-input'))
      await type(page, row.locator('.tt-milestone-title-input'), m.title)
      await blurAway(page)
      await pause(page, 300)
    }
  }
  await pause(page, 500)

  await caption(page, 'Risks scored by chance x impact')
  await hideCaption(page)
  await switchPaneModule(page, 0, /Risks/i)
  {
    const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const risks = [
      { title: 'Cloud provider outage during migration window', chance: '3', impact: '3' },
      { title: 'Key engineer unavailable for cutover', chance: '1', impact: '2' },
    ]
    for (const r of risks) {
      await click(page, pane0.locator('.tt-risk-add-btn'))
      const row = await focusedRow(page, '.tt-risk-row', 'data-risk-id')
      await type(page, row.locator('.tt-risk-title-input'), r.title)
      await click(page, row.locator('.tt-risk-chance-select'))
      await row.locator('.tt-risk-chance-select').selectOption(r.chance)
      await click(page, row.locator('.tt-risk-impact-select'))
      await row.locator('.tt-risk-impact-select').selectOption(r.impact)
      await pause(page, 250)
    }
    await blurAway(page)
    await pause(page, 400)
    // Expand the highest-exposure risk to show the chance/impact quadrant + mitigation follow-up.
    const firstRow = pane0.locator('.tt-risk-row').first()
    await click(page, firstRow.locator('.tt-risk-expand-btn'))
    await typeIntoEditor(
      page,
      pane0.locator('.tt-risk-followup-row .editor').first(),
      'Run the migration during the lowest-traffic window; keep rollback snapshots hot for 48h.'
    )
    await blurAway(page)
  }
  await pause(page, 900)
}

async function showReferencesAndTemplates(page) {
  await switchPaneModule(page, 0, /Daily/i)
  // Single-pane first so the reference click's auto-split into dual pane, below, actually reads as a change.
  await page.keyboard.press('Alt+ArrowUp')
  await pause(page, 500)

  await caption(page, 'Type @ to reference a person, team, or item')
  const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
  await click(page, editor)
  await page.keyboard.press('Control+End')
  await editor.pressSequentially('\nFollow-up: talk to @Miguel', { delay: 26 })
  const atItem = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: 'Miguel' }).first()
  await expect(atItem).toBeVisible({ timeout: 5000 })
  await pause(page, 350)
  await click(page, atItem)
  await pause(page, 500)
  await hideCaption(page)

  await caption(page, 'Ctrl+click a reference to open it in the second pane')
  const chip = editor.locator('a.ref', { hasText: 'Miguel' }).first()
  await chip.scrollIntoViewIfNeeded()
  const box = await chip.boundingBox()
  await moveMouseTo(page, box.x + box.width / 2, box.y + box.height / 2)
  await pause(page, 250)
  await page.keyboard.down('Control')
  await page.mouse.down()
  await pause(page, 80)
  await page.mouse.up()
  await page.keyboard.up('Control')
  await pause(page, 700)
  await hideCaption(page)

  const personPane = page.locator('.tt-person-notes')
  await expect(personPane).toBeVisible({ timeout: 5000 })
  await pause(page, 400)

  await caption(page, 'Templates speed up repeat note formats')
  const personEditor = personPane.locator('.editor').first()
  await click(page, personEditor)
  await click(page, personPane.locator('.tt-editor-btn[title="Insert template (/)"]'))
  const tplItem = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: '1:1' }).first()
  await expect(tplItem).toBeVisible({ timeout: 5000 })
  await pause(page, 350)
  await click(page, tplItem)
  await pause(page, 900)
  await hideCaption(page)

  // Back to pane 0 (its module history) for showPaneLayout, below.
  await page.keyboard.press('Alt+ArrowLeft')
  await pause(page, 300)
}

async function showPaneLayout(page) {
  await caption(page, 'Split panes, each with its own back/forward history (Alt+Shift+←/→)')
  // History: step through a couple of the module switches buildContent() just made.
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await pause(page, 650)
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await pause(page, 650)
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await pause(page, 650)
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await pause(page, 500)
  await hideCaption(page)

  await caption(page, 'Alt+↑ toggles single/split view')
  await page.keyboard.press('Alt+ArrowUp')
  await pause(page, 800)
  await page.keyboard.press('Alt+ArrowUp')
  await pause(page, 500)
  await hideCaption(page)
}

async function showSecondTeamAndSwitch(page) {
  await caption(page, 'Every team gets its own space')
  await hideCaption(page)
  await createTeam(page, 'Design', '🎨', false)
  await addPerson(page, 1, 'Elena Cruz', 'Product Designer')
  await typeIntoEditor(
    page,
    page.locator('.tt-pane[data-pane-idx="0"] .editor').first(),
    'Reviewed the Q3 platform migration timeline — no blocking UI dependencies.'
  )
  await blurAway(page)
  await pause(page, 600)

  await caption(page, 'Alt+1..9 jumps straight to any team')
  await page.keyboard.press('Alt+1')
  await expect(page.locator('.tt-pane[data-pane-idx="0"]')).toBeVisible()
  await pause(page, 600)
  await page.keyboard.press('Alt+2')
  await pause(page, 600)
  await page.keyboard.press('Alt+1')
  await pause(page, 600)
  await hideCaption(page)
}

async function showSearch(page) {
  await caption(page, 'Search finds it across every team')
  await type(page, page.locator('.tt-search-input'), 'migration', 38)
  await expect(page.locator('.tt-search-dropdown')).toHaveClass(/open/, { timeout: 5000 })
  await click(page, page.locator('.tt-search-all-teams input[type="checkbox"]'))
  await pause(page, 1200)
  await page.keyboard.press('Escape')
  await pause(page, 400)
  await hideCaption(page)
}

async function showCommandPalette(page) {
  await caption(page, 'Ctrl+K opens the command palette')
  await page.keyboard.press('Control+k')
  await expect(page.locator('.tt-palette-overlay')).toBeVisible()
  await page.keyboard.type('risk', { delay: 55 })
  await pause(page, 1000)
  await page.keyboard.press('Escape')
  await pause(page, 400)
  await hideCaption(page)
}

async function showThemes(page) {
  await caption(page, 'Pick a theme — 9 palettes, light or dark')
  await click(page, page.locator('.tt-btn-settings'))
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await click(page, dialog.locator('input[name="tt-prefs-theme"][value="dark"]'))
  const tour = ['signal', 'cosmic', 'synthwave', 'ember', 'forest', 'verdant']
  for (const palette of tour) {
    await click(page, dialog.locator(`input[name="tt-prefs-palette"][value="${palette}"]`))
    await pause(page, 550)
  }
  // Back to the default (ledger, light) before the rest of the tour.
  await click(page, dialog.locator('input[name="tt-prefs-theme"][value="light"]'))
  await click(page, dialog.locator('input[name="tt-prefs-palette"][value="ledger"]'))
  await pause(page, 400)
  await hideCaption(page)
  return dialog
}

async function showSecurityAndBackup(page, dialog) {
  await caption(page, 'Change your password anytime')
  await click(page, page.getByRole('button', { name: 'Security' }))
  await pause(page, 350)
  await type(page, dialog.locator('input[name="tt-prefs-current-password"]'), PASSWORD)
  await type(page, dialog.locator('input[name="tt-prefs-new-password"]'), 'demo-password-456')
  await type(page, dialog.locator('input[name="tt-prefs-new-password-confirm"]'), 'demo-password-456')
  await click(page, page.getByRole('button', { name: 'Change password' }))
  await expect(page.getByText('Password changed successfully')).toBeVisible()
  await pause(page, 800)
  await hideCaption(page)

  await caption(page, 'Daily backups mirror to a second file automatically')
  await click(page, page.getByRole('button', { name: 'Backup' }))
  await pause(page, 400)
  const backupCheckbox = dialog.locator('.tt-prefs-backup-checkbox')
  if (await backupCheckbox.isEnabled()) {
    await click(page, backupCheckbox)
    await pause(page, 900)
  }
  await hideCaption(page)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await pause(page, 500)
}

async function script(page) {
  console.log('Creating encrypted file...')
  await caption(page, 'Everything lives in one encrypted file you control')
  await click(page, page.getByRole('button', { name: /Create new/ }))
  const createDialog = page.getByRole('dialog')
  await type(page, createDialog.locator('input[name="tt-password"]'), PASSWORD, 50)
  await type(page, createDialog.locator('input[name="tt-password-confirm"]'), PASSWORD, 50)
  await click(page, createDialog.getByRole('button', { name: 'OK' }))
  await expect(page.locator('.tt-shell')).toBeVisible()
  await hideCaption(page)
  const toast = page.locator('.tt-toast')
  if (await toast.count() > 0) await click(page, toast.first())
  await pause(page, 500)

  console.log('Building content (org tree, daily notes, tasks, milestones, risks)...')
  await buildContent(page)

  console.log('Showing @ references and templates...')
  await showReferencesAndTemplates(page)

  console.log('Showing pane split + history navigation...')
  await showPaneLayout(page)

  console.log('Showing a second team + team switching...')
  await showSecondTeamAndSwitch(page)

  console.log('Showing global search...')
  await showSearch(page)

  console.log('Showing command palette...')
  await showCommandPalette(page)

  console.log('Showing theme/palette tour...')
  const dialog = await showThemes(page)

  console.log('Showing password change + daily backup...')
  await showSecurityAndBackup(page, dialog)

  console.log('Done, finalizing video...')
}

runDemo({ outFile: OUT_FILE, port: PORT, script }).catch((err) => {
  console.error(err)
  process.exit(1)
})
