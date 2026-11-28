// scripts/generate-screenshots.mjs — re-renders docs/screenshots/*.png by
// driving the real built app (Playwright, not the test runner) through the
// README's sample workspace (sample-seed.mjs), the same file the feature tour
// records and the README's "sample file" link serves.
//
// Run by hand before a README screenshot refresh:
// `npm run build && node scripts/generate-screenshots.mjs`. It is NOT part of
// `npm run test:e2e` / CI (playwright.config.ts's testDir only picks up
// e2e/*.spec.ts; this file lives in scripts/ and is never matched).
//
// The app is served over localhost with the OPFS picker shim
// (demo-video-lib.mjs's withSeededApp), so it runs as it does for a Chrome
// user: the save indicator reads "Saved". Every date in the sample is relative
// to today, so "overdue by N days" stays small however late this is re-run.
import { expect } from '@playwright/test'
import path from 'node:path'
import { HERE, withSeededApp } from './demo-video-lib.mjs'
import { buildSampleBytes, SAMPLE_FILENAME } from './sample-seed.mjs'

const SHOT_DIR = path.resolve(HERE, '../docs/screenshots')
const PORT = 4322 // distinct from the tour's 4321 and playwright.config.ts's 4319, so all three can run side by side
const VIEWPORT = { width: 1500, height: 940 }

// Which theme/palette each README screenshot shows, in the order they are
// taken — edit this table to change what a future run produces without
// touching the flow below. `palette: null` leaves the current one (the
// sample's default, ledger, for the first shot).
const SCREENSHOTS = [
  { file: 'daily-notes-and-org.png', theme: 'light', palette: null, view: 'daily-and-org' },
  { file: 'rich-text-editor.png', theme: 'light', palette: 'signal', view: 'rich-text' },
  { file: 'action-items-kanban.png', theme: 'dark', palette: 'ember', view: 'kanban' },
  { file: 'milestones.png', theme: 'light', palette: 'signal', view: 'milestones' },
  { file: 'risks.png', theme: 'dark', palette: 'synthwave', view: 'risks' },
  { file: 'person-notes.png', theme: 'dark', palette: 'forest', view: 'person-notes' },
  { file: 'command-palette.png', theme: 'dark', palette: 'cosmic', view: 'command-palette' },
  { file: 'global-search.png', theme: 'light', palette: 'verdant', view: 'global-search' },
]

// What the fast-switch screenshot types into the box (see the 'command-palette' view).
const PALETTE_QUERY = 'e'

const pane = (page, idx) => page.locator(`.tt-pane[data-pane-idx="${idx}"]`)

async function switchPaneModule(page, paneIdx, label) {
  const p = pane(page, paneIdx)
  // A wide pane shows the module tabs (accessible name = the module's); a narrow one the dropdown.
  const tab = p.locator('button.tt-pane-tab:visible').and(p.getByLabel(label)).first()
  if (await tab.count()) {
    await tab.click()
    return
  }
  await p.locator('.tt-pane-modules-btn').click()
  await p.locator('.tt-pane-menu-item', { hasText: label }).first().click()
}

async function setThemePalette(page, theme, palette) {
  await page.locator('.tt-btn-settings').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator(`input[name="tt-prefs-theme"][value="${theme}"]`).check({ force: true })
  if (palette) await dialog.locator(`input[name="tt-prefs-palette"][value="${palette}"]`).check({ force: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}

async function blurAway(page) {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
}

async function unsplitIfSplit(page) {
  if (await pane(page, 1).isVisible()) await page.locator('.tt-pane-split-btn').first().click()
}

async function shoot(page, file) {
  // Let menus, toasts and the reorder motion settle.
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(SHOT_DIR, file) })
  console.log(`  wrote ${file}`)
}

async function showView(page, view) {
  switch (view) {
    case 'daily-and-org':
      // The sample opens this way: today's note beside the org chart, whose dots mark a due (brass) and an overdue (red) 1:1.
      await switchPaneModule(page, 0, /Daily/i)
      await switchPaneModule(page, 1, /Members/i)
      await blurAway(page)
      break
    case 'rich-text':
      // The team's General notes are seeded with a heading, a blockquote, a code block and a link.
      await switchPaneModule(page, 0, /General/i)
      await unsplitIfSplit(page)
      await blurAway(page)
      break
    case 'kanban':
      await switchPaneModule(page, 0, /Tasks/i)
      break
    case 'milestones':
      await switchPaneModule(page, 0, /Milestones/i)
      break
    case 'risks':
      await switchPaneModule(page, 0, /Risks/i)
      // Highest exposure first; expanding it shows its mitigation notes.
      await pane(page, 0).locator('.tt-risk-row').first().locator('.tt-risk-expand-btn').click()
      await blurAway(page)
      break
    case 'person-notes':
      // Mei is overdue for her 1:1 and her last one left open items: New 1:1 carries them into a fresh block.
      await page.keyboard.press('Control+Shift+k')
      await expect(page.locator('.tt-palette-overlay')).toBeVisible()
      await page.keyboard.type('Mei Chen', { delay: 20 })
      await page.waitForTimeout(300)
      await page.keyboard.press('Enter')
      await expect(page.locator('.tt-person-notes')).toBeVisible({ timeout: 5000 })
      await page.locator('.tt-person-header-one-on-one-btn').click()
      await page.keyboard.type('Energised by owning the load test.', { delay: 10 })
      break
    case 'command-palette':
      // The sample stars panes in three teams; a non-empty query is what reveals Other teams
      // (src/core/switcher.ts), and the row cap then shows each section's share with its "N of M" count.
      await switchPaneModule(page, 0, /Risks/i)
      await page.keyboard.press('Control+Shift+k')
      await expect(page.locator('.tt-palette-overlay')).toBeVisible()
      await page.keyboard.type(PALETTE_QUERY, { delay: 20 })
      break
    case 'global-search':
      await switchPaneModule(page, 0, /Daily/i)
      await page.locator('.tt-search-input').click()
      await page.locator('.tt-search-input').fill('migration')
      // The results dropdown (and its "all teams" checkbox) opens after the search input's debounce.
      await expect(page.locator('.tt-search-dropdown')).toHaveClass(/open/, { timeout: 5000 })
      await page.locator('.tt-search-all-teams input[type="checkbox"]').check({ force: true })
      await page.waitForTimeout(400)
      await expect(page.locator('.tt-search-dropdown')).toHaveClass(/open/)
      break
    default:
      throw new Error(`Unknown view: ${view}`)
  }
}

await withSeededApp({ port: PORT, viewport: VIEWPORT, seed: { filename: SAMPLE_FILENAME, bytes: buildSampleBytes() } }, async (page) => {
  await page.getByRole('button', { name: /Open file/ }).click()
  await expect(page.locator('.tt-shell')).toBeVisible({ timeout: 10000 })
  console.log('Rendering screenshots...')
  for (const shot of SCREENSHOTS) {
    // Theme/palette first: the fast switch and search overlays cover the settings button.
    await setThemePalette(page, shot.theme, shot.palette)
    await showView(page, shot.view)
    await shoot(page, shot.file)
    if (shot.view === 'command-palette') await page.keyboard.press('Escape')
  }
  console.log('Done.')
})
