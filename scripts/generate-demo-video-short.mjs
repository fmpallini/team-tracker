// scripts/generate-demo-video-short.mjs — ~70s highlight cut of the feature
// tour (see generate-demo-video.mjs for the full version, and
// demo-video-lib.mjs for shared plumbing/why).
//
// Unlike the old version, this records NO setup: demo-seed.mjs builds a dense
// dummy document (4 teams, the first one fully loaded with an org tree, a
// board with custom columns, milestones and a populated risk quadrant), and
// runDemo() drops it straight into OPFS. The tour opens that file and every
// second of the recording is a real feature being shown.
import path from 'node:path'
import { expect } from '@playwright/test'
import {
  runDemo, caption, hideCaption, pause, click, moveMouseTo,
  switchPaneModule, openSeededFile, OUT_DIR,
} from './demo-video-lib.mjs'
import { buildSeedBytes, SEED_FILENAME } from './demo-seed.mjs'

const PORT = 4321 // distinct from generate-demo-video.mjs's 4320 and playwright.config.ts's 4319, so all three can run side by side
const OUT_FILE = 'feature-tour-short.webm'
const GIF_FILE = 'feature-tour-short.gif'
const MUSIC_FILE = path.join(OUT_DIR, 'music', 'tech-tech-music-nastelbom.mp3')

const PANE0_EDITOR = '.tt-pane[data-pane-idx="0"] .editor'

async function showOrgChart(page) {
  await caption(page, 'Org chart — drag to re-org, double-click for notes', 1600)
  const pane1 = page.locator('.tt-pane[data-pane-idx="1"]')
  const nadia = pane1.locator('.tt-org-box', { hasText: 'Nadia Rahman' })
  const mei = pane1.locator('.tt-org-box', { hasText: 'Mei Chen' })
  const nb = await nadia.boundingBox()
  const mb = await mei.boundingBox()
  const start = { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 }
  const end = { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 }
  // Reparent Nadia under Mei. Native HTML5 drag-and-drop, driven manually so
  // the cursor glides slowly across the tree (Playwright's dragTo teleports).
  // The app keys the move off its own `draggedId` closure set on dragstart,
  // so dispatching the drag events on the two boxes — with a real cursor
  // glide + dragover pulses for the drop-target highlight — is enough.
  await moveMouseTo(page, start.x, start.y)
  await pause(page, 300)
  await nadia.dispatchEvent('dragstart')
  await pause(page, 200)
  const SEGMENTS = 4
  for (let i = 1; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    await moveMouseTo(page, start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t, { steps: 5, totalMs: 190 })
    if (t >= 0.5) await mei.dispatchEvent('dragover', { clientX: end.x, clientY: end.y })
  }
  await pause(page, 320) // brief hover-hold over the target
  await mei.dispatchEvent('drop', { clientX: end.x, clientY: end.y })
  await nadia.dispatchEvent('dragend')
  // The synthetic drop rebuilds the tree before dragend can reach the (now
  // detached) source, so the "move to top level" band can stay stuck — clear
  // it directly, the way a real dragend would.
  await pane1.locator('.tt-people-root-drop').evaluate((el) => el.classList.remove('active', 'drag-over')).catch(() => {})
  await pane1.locator('.tt-people-tree').evaluate((el) => el.classList.remove('tt-people-dragging')).catch(() => {})
  await pause(page, 500)

  // Mei has real seeded notes — open her page with a *visible* double-click:
  // settle the pointer on her box, hold, then two deliberate clicks (the
  // arrow cursor's ripple fires on each) so the gesture reads before her
  // notes replace the org chart.
  const meiBox = await mei.boundingBox()
  await moveMouseTo(page, meiBox.x + meiBox.width / 2, meiBox.y + meiBox.height / 2)
  await pause(page, 450)
  await page.mouse.down(); await pause(page, 60); await page.mouse.up()
  await pause(page, 110)
  await page.mouse.down(); await pause(page, 60); await page.mouse.up()
  await expect(pane1.locator('.tt-person-notes')).toBeVisible({ timeout: 5000 })
  await pause(page, 900)
  await hideCaption(page)
}

async function showRichNotes(page) {
  await caption(page, 'Rich notes — shortcut combos and markdown', 1400)
  const editor = page.locator(PANE0_EDITOR).first()
  await click(page, editor)
  await page.keyboard.press('Control+End')
  // Blockquote via the typed `> ` gesture, then a fenced code block, then a
  // bare [text](url) that auto-converts to a live link on the closing paren.
  await editor.pressSequentially('\n> Cutover window is Sat 02:00–04:00 UTC', { delay: 22 })
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await editor.pressSequentially('```', { delay: 40 })
  await page.keyboard.press('Enter')
  await editor.pressSequentially('kubectl apply -f cutover.yaml\nkubectl rollout status deploy/auth', { delay: 20 })
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter') // empty last line ends the code block
  await editor.pressSequentially('Runbook: [cutover steps](https://wiki.example.com/cutover)', { delay: 18 })
  await pause(page, 700)
  await hideCaption(page)
}

async function showChromeCollapse(page) {
  await caption(page, 'Clear the chrome — one wide pane', 1300)
  await click(page, page.locator('.tt-daily-calendar-toggle'))
  await pause(page, 450)
  await click(page, page.locator('.tt-sidebar-toggle'))
  await pause(page, 550)
  // Collapse to a single pane too. Focus the left pane first — Alt+↑ collapses
  // to whichever pane is currently focused, and the org-chart beat left pane 1
  // (now Mei's notes) focused.
  await page.keyboard.press('Alt+ArrowLeft')
  await pause(page, 200)
  await page.keyboard.press('Alt+ArrowUp')
  await pause(page, 900)
  await hideCaption(page)
}

async function showTeamSwitch(page) {
  await caption(page, 'Every team is its own space', 1200)
  await click(page, page.locator('.tt-sidebar-toggle')) // bring the team list back
  await pause(page, 400)
  for (const key of ['Alt+2', 'Alt+3', 'Alt+1']) {
    await page.keyboard.press(key)
    await pause(page, 750)
  }
  await hideCaption(page)
}

async function showAtReference(page) {
  await caption(page, 'Type @ to reference people or work', 1400)
  const editor = page.locator(PANE0_EDITOR).first()
  await click(page, editor)
  await page.keyboard.press('Control+End')
  await editor.pressSequentially('\nSync with @Miguel', { delay: 24 })
  const atItem = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: 'Miguel' }).first()
  await expect(atItem).toBeVisible({ timeout: 5000 })
  await pause(page, 250)
  await click(page, atItem)
  await hideCaption(page)

  await caption(page, 'Ctrl+click opens it in the second pane', 1500)
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
  await expect(page.locator('.tt-person-notes')).toBeVisible({ timeout: 5000 })
  await hideCaption(page)
}

async function showTemplate(page) {
  await caption(page, 'One key drops in a template', 1500)
  const personEditor = page.locator('.tt-person-notes .editor').first()
  await click(page, personEditor)
  await personEditor.pressSequentially('/', { delay: 40 })
  const tplItem = page.locator('.tt-atref-dropdown .tt-atref-item', { hasText: '1:1' }).first()
  await expect(tplItem).toBeVisible({ timeout: 5000 })
  await pause(page, 250)
  await click(page, tplItem)
  await pause(page, 600)
  await hideCaption(page)
  // Back to pane 0 for the board + risk beats.
  await page.keyboard.press('Alt+ArrowLeft')
  await pause(page, 300)
}

async function showCustomColumns(page) {
  await caption(page, 'Boards with columns you define', 1400)
  await switchPaneModule(page, 0, /Tasks/i)
  await pause(page, 500)
  const pane0 = page.locator('.tt-pane[data-pane-idx="0"]')
  await click(page, pane0.locator('.tt-kanban-add-column-btn'))
  // Every middle column carries a hidden rename input; only the just-added
  // column's is shown (and focused) for editing.
  const renameInput = pane0.locator('.tt-kanban-col-rename-input').filter({ visible: true })
  await expect(renameInput).toBeVisible({ timeout: 5000 })
  await renameInput.fill('')
  await renameInput.pressSequentially('Blocked', { delay: 55 })
  await page.keyboard.press('Enter')
  await pause(page, 400)
  const blockedCol = pane0.locator('.tt-kanban-col', { hasText: 'Blocked' })
  await click(page, blockedCol.locator('.tt-kanban-add-btn'))
  const cardDialog = page.getByRole('dialog')
  // The card modal has no Save button — cards persist live as you type — so
  // just fill the title and Close.
  await cardDialog.locator('.tt-kanban-form input.tt-input').first().fill('Escalate the vendor SLA gap')
  await pause(page, 500)
  await click(page, cardDialog.getByRole('button', { name: 'Close' }))
  await expect(cardDialog).toBeHidden()
  // Adding the column auto-scrolled the board to it — pull it back so the
  // fixed To Do / In Review columns are in frame alongside the new one.
  await pane0.locator('.tt-kanban-board').evaluate((el) => { el.scrollLeft = 0 }).catch(() => {})
  await pause(page, 700)
  await hideCaption(page)
}

async function showFastSwitch(page) {
  await caption(page, 'Jump anywhere — Ctrl+Shift+K', 1400)
  await page.keyboard.press('Control+Shift+k')
  await expect(page.locator('.tt-palette-overlay')).toBeVisible()
  await page.locator('.tt-palette-input').pressSequentially('outage', { delay: 55 })
  await pause(page, 700)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-pane[data-pane-idx="0"] .tt-risk-quadrant-chart')).toBeVisible({ timeout: 5000 })
  await pause(page, 500)
  await hideCaption(page)
}

async function showRiskDrag(page) {
  await caption(page, 'Risks — drag on the chart to re-score', 1500)
  const svg = page.locator('.tt-pane[data-pane-idx="0"] .tt-risk-quadrant-chart svg')
  const dot = svg.locator('g.tt-risk-quadrant-dot[data-quadrant-risk-id="rk3"]')
  const target = svg.locator('.tt-risk-quadrant-cell[data-chance="3"][data-impact="3"]')
  const from = await dot.boundingBox()
  const to = await target.boundingBox()
  await moveMouseTo(page, from.x + from.width / 2, from.y + from.height / 2)
  await pause(page, 250)
  await page.mouse.down()
  // Several stepped moves so travel clears the drag threshold and the live
  // cell highlight is visible tracking the dot, not a single teleport.
  await moveMouseTo(page, to.x + to.width / 2, to.y + to.height / 2, { steps: 24, totalMs: 900 })
  await pause(page, 300)
  await page.mouse.up()
  await pause(page, 900)
  await hideCaption(page)
}

async function showThemes(page) {
  await caption(page, 'Dark mode and 9 color palettes', 1400)
  await click(page, page.locator('.tt-btn-settings'))
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await click(page, dialog.locator('input[name="tt-prefs-theme"][value="dark"]'))
  await pause(page, 800)
  await click(page, dialog.locator('input[name="tt-prefs-palette"][value="synthwave"]'))
  await pause(page, 1000)
  await hideCaption(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await pause(page, 400)
}

async function script(page) {
  console.log('Opening the pre-seeded file...')
  await openSeededFile(page)

  await caption(page, 'One file you own — encrypted or plain text', 1600)
  await pause(page, 600)
  await hideCaption(page)

  await showOrgChart(page)
  await showRichNotes(page)
  await showChromeCollapse(page)
  await showTeamSwitch(page)
  await showAtReference(page)
  await showTemplate(page)
  await showCustomColumns(page)
  await showFastSwitch(page)
  await showRiskDrag(page)
  await showThemes(page)

  console.log('Done, finalizing video...')
}

runDemo({
  outFile: OUT_FILE,
  gifFile: GIF_FILE,
  music: MUSIC_FILE,
  port: PORT,
  script,
  seed: { filename: SEED_FILENAME, bytes: buildSeedBytes() },
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
