// scripts/generate-demo-video-short.mjs — short highlight cut of the feature
// tour (see generate-demo-video.mjs for the full version, and
// demo-video-lib.mjs for shared plumbing/why). File/team/person/task creation
// is done with Playwright's own instant .click()/.fill() (no cursor glide, no
// captions) since it's just setup, not something worth spending the runtime
// budget narrating — the natural cursor + captions kick in once there's
// something to actually show off.
import { expect } from '@playwright/test'
import {
  runDemo, caption, hideCaption, pause, click, blurAway, moveMouseTo,
  switchPaneModule, addChildPerson, focusedRow,
  PASSWORD,
} from './demo-video-lib.mjs'

const PORT = 4321 // distinct from generate-demo-video.mjs's 4320 and playwright.config.ts's 4319, so all three can run side by side
const OUT_FILE = 'feature-tour-short.webm'

// Each team gets its own one-line daily note so switching between them later
// visibly proves the "separate space per team" claim instead of just asserting it.
const TEAMS = [
  { name: 'Platform Engineering', emoji: '🚀', note: 'Kicked off the Q3 platform migration today.' },
  { name: 'Design', emoji: '🎨', note: 'Reviewing new dashboard mockups this week.' },
  { name: 'Data & Analytics', emoji: '📊', note: 'ETL pipeline migration tracked here.' },
  { name: 'Marketing', emoji: '📣', note: 'Q3 launch campaign planning underway.' },
]

async function fastCreateTeam(page, name, emoji, first) {
  if (first) {
    await page.getByRole('button', { name: /Create first team/ }).click()
  } else {
    await page.locator('.tt-team-add-btn').click()
  }
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="tt-team-name"]').fill(name)
  await dialog.locator('input[name="tt-team-emoji"]').fill(emoji)
  await dialog.locator('input[name="tt-team-name"]').click() // closes emoji-picker popup
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden()
}

/**
 * Instant, uncaptioned: the encrypted file, all 4 teams (each with its own
 * daily note), team 1's person, and team 1's one action item — the person and
 * the action item are what the @-reference demos below point at.
 */
async function fastSetup(page) {
  await page.getByRole('button', { name: /Create new/ }).click()
  const createDialog = page.getByRole('dialog')
  await createDialog.locator('input[name="tt-password"]').fill(PASSWORD)
  await createDialog.locator('input[name="tt-password-confirm"]').fill(PASSWORD)
  await createDialog.getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.tt-shell')).toBeVisible()
  const toast = page.locator('.tt-toast')
  if (await toast.count() > 0) await toast.first().click()

  for (const [i, t] of TEAMS.entries()) {
    await fastCreateTeam(page, t.name, t.emoji, i === 0)
    await page.locator('.tt-pane[data-pane-idx="0"] .editor').first().fill(t.note)
  }

  // Creating a team switches to it — back to team 1 (still index 0's daily
  // note visible, per the loop above) for its person + action item.
  await page.keyboard.press('Alt+1')
  await expect(page.locator('.tt-pane[data-pane-idx="0"]')).toBeVisible()

  const pane1 = page.locator('.tt-pane[data-pane-idx="1"]')
  await pane1.locator('.tt-people-add-btn').first().click()
  const personDialog = page.getByRole('dialog')
  await personDialog.locator('input[name="tt-person-name"]').fill('Miguel Fernandez')
  await personDialog.locator('input[name="tt-person-role"]').fill('Senior Backend Engineer')
  await personDialog.getByRole('button', { name: 'OK' }).click()
  await expect(personDialog).toBeHidden()

  const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
  await pane0.locator('.tt-pane-modules-btn').click()
  await pane0.locator('.tt-pane-menu-item', { hasText: /Tasks/i }).first().click()
  await pane0.locator('.tt-kanban-col', { hasText: 'To Do' }).locator('.tt-kanban-add-btn').click()
  const cardDialog = page.getByRole('dialog')
  await cardDialog.locator('.tt-kanban-form input.tt-input').first().fill('Cut over auth service to new cluster')
  await cardDialog.locator('.tt-date-picker-input').fill('08/20/2026')
  await cardDialog.locator('.tt-kanban-form input.tt-input').first().click() // closes date popover
  await cardDialog.locator('.tt-kanban-form-row input.tt-input:not(.tt-date-picker-input)').fill('Miguel Fernandez')
  await cardDialog.getByRole('button', { name: 'Save' }).click()
  await expect(cardDialog).toBeHidden()

  await pane0.locator('.tt-pane-modules-btn').click()
  await pane0.locator('.tt-pane-menu-item', { hasText: /Daily/i }).first().click()
}

async function script(page) {
  const t0 = Date.now()
  console.log('Fast setup (file + 4 teams + person + task, no narration)...')
  await fastSetup(page)
  // Printed so the caller can ffmpeg-trim the raw recording to start right
  // after setup: even though setup itself is uncaptioned/instant, Playwright
  // still records every real frame of it, and clicks/dialogs flashing by
  // with zero narration reads as noise, not "fast" — better cut outright
  // than sped through.
  console.log(`SETUP_END_S=${((Date.now() - t0) / 1000).toFixed(2)}`)

  await caption(page, 'Each team is a fully separate space', 400)
  for (const key of ['Alt+2', 'Alt+3', 'Alt+4', 'Alt+1']) {
    await page.keyboard.press(key)
    await pause(page, 600)
  }
  await hideCaption(page)

  await caption(page, 'Org chart — people, roles, reporting lines', 1400)
  await addChildPerson(page, 1, 'Miguel Fernandez', 'Mei Chen', 'Platform Engineer')
  await hideCaption(page)

  // Explicit pane-0 focus first: the org-chart step above left pane 1
  // focused, and Alt+ArrowUp's single/split toggle collapses to whichever
  // pane is currently focused.
  await page.keyboard.press('Alt+ArrowLeft')
  await pause(page, 200)
  // Single-pane first so the reference click's auto-split into dual pane, below, actually reads as a change.
  await page.keyboard.press('Alt+ArrowUp')
  await pause(page, 350)

  await caption(page, 'Type @ to reference anyone', 1500)
  const editor = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
  await click(page, editor)
  await page.keyboard.press('Control+End')
  await editor.pressSequentially('\nTalk to @Miguel', { delay: 24 })
  const atItem = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: 'Miguel' }).first()
  await expect(atItem).toBeVisible({ timeout: 5000 })
  await pause(page, 250)
  await click(page, atItem)
  await hideCaption(page)

  await caption(page, 'Ctrl+click opens it in the second pane', 1600)
  const chip = editor.locator('a.ref', { hasText: 'Miguel' }).first()
  await chip.scrollIntoViewIfNeeded()
  const box = await chip.boundingBox()
  await moveMouseTo(page, box.x + box.width / 2, box.y + box.height / 2)
  await pause(page, 200)
  await page.keyboard.down('Control')
  await page.mouse.down()
  await pause(page, 70)
  await page.mouse.up()
  await page.keyboard.up('Control')
  const personPane = page.locator('.tt-person-notes')
  await expect(personPane).toBeVisible({ timeout: 5000 })
  await hideCaption(page)

  await caption(page, 'One click inserts a template', 1600)
  const personEditor = personPane.locator('.editor').first()
  await click(page, personEditor)
  await click(page, personPane.locator('.tt-editor-btn[title="Insert template (/)"]'))
  const tplItem = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: '1:1' }).first()
  await expect(tplItem).toBeVisible({ timeout: 5000 })
  await pause(page, 250)
  await click(page, tplItem)
  await pause(page, 500)
  await hideCaption(page)

  // Back to pane 0 — still on the daily note holding the "@Miguel" line from earlier, for the action-item reference below.
  await page.keyboard.press('Alt+ArrowLeft')
  await pause(page, 300)

  await caption(page, 'References work for action items too', 1600)
  const editor2 = page.locator('.tt-pane[data-pane-idx="0"] .editor').first()
  await click(page, editor2) // just for focus — the click's own caret placement is unreliable next to the chip below, overridden right after
  // The block already ends in a contenteditable=false ref chip (the Miguel
  // mention above) + a trailing NBSP. Both Control+End and a plain click
  // resolve their caret to *inside* that non-editable chip's text (Chrome
  // snapping to the visually nearest text), where keystrokes are silently
  // swallowed. Position the caret programmatically instead, exactly like
  // src/ui/atref.ts's own chip-insertion does: collapsed at the end of the
  // last block's contents, i.e. right after the NBSP, not inside the chip.
  await page.evaluate(() => {
    const editorEl = document.querySelector('.tt-pane[data-pane-idx="0"] .editor')
    const lastBlock = editorEl?.lastElementChild
    if (!lastBlock) return
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(lastBlock)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
  })
  await editor2.pressSequentially('\nSee @Cut over', { delay: 24 })
  const atItem2 = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: 'Cut over' }).first()
  await expect(atItem2).toBeVisible({ timeout: 5000 })
  await pause(page, 250)
  await click(page, atItem2)
  await pause(page, 400)
  // Plain click (no Ctrl this time) — same-pane navigation, contrasting with the Ctrl+click dual-pane demo above.
  const chip2 = editor2.locator('a.ref', { hasText: 'Cut over' }).first()
  await click(page, chip2)
  await expect(page.locator('.tt-pane[data-pane-idx="0"] .tt-kanban-board')).toBeVisible({ timeout: 5000 })
  await pause(page, 600)
  await hideCaption(page)

  await caption(page, 'Risks scored by chance x impact', 1400)
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
      await click(page, row.locator('.tt-risk-title-input'))
      await row.locator('.tt-risk-title-input').fill(r.title)
      await row.locator('.tt-risk-chance-select').selectOption(r.chance)
      await row.locator('.tt-risk-impact-select').selectOption(r.impact)
    }
    await blurAway(page)
    await pause(page, 700)
  }
  await hideCaption(page)

  await caption(page, 'Settings — 9 palettes, light or dark', 1400)
  await click(page, page.locator('.tt-btn-settings'))
  const settingsDialog = page.getByRole('dialog')
  await expect(settingsDialog).toBeVisible()
  await click(page, settingsDialog.locator('input[name="tt-prefs-theme"][value="dark"]'))
  for (const palette of ['synthwave', 'ember', 'verdant']) {
    await click(page, settingsDialog.locator(`input[name="tt-prefs-palette"][value="${palette}"]`))
    await pause(page, 450)
  }
  await click(page, settingsDialog.locator('input[name="tt-prefs-theme"][value="light"]'))
  await click(page, settingsDialog.locator('input[name="tt-prefs-palette"][value="ledger"]'))
  await pause(page, 300)
  await hideCaption(page)
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toBeHidden()

  console.log('Done, finalizing video...')
}

runDemo({ outFile: OUT_FILE, port: PORT, script }).catch((err) => {
  console.error(err)
  process.exit(1)
})
