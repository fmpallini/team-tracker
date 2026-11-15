// e2e/one-on-one.spec.ts — the 1:1 flow end to end: a checklist item typed in a
// person's notes, New 1:1 (button and Alt+O) carrying it forward, one Ctrl+Z
// taking the block back out, and a stale "Last 1:1" turning up as a due item.
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { blockUpdateCheck, createEncryptedDoc, waitForWritable } from './helpers'

/** Today minus `days`, as the en-US date field reads it (MM/DD/YYYY, local time like the app's todayIso). */
function daysAgoUs(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`
}

/** Which heading the caret's list item sits under — "which section is the caret in". */
async function caretSection(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const node = getSelection()?.anchorNode
    const li = (node instanceof Element ? node : node?.parentElement)?.closest('li')
    let block: Element | null = li?.closest('ul, ol') ?? null
    while (block && !/^H[1-6]$/.test(block.tagName)) block = block.previousElementSibling
    return block?.textContent ?? null
  })
}

test('1:1 on a blank note: the arrow keys reach the empty "Agreed actions" box', async ({ page }) => {
  const pane = await openAnasNotes(page)
  const editor = pane.locator('.editor')
  await editor.click()
  await pane.locator('.tt-person-header-one-on-one-btn').click()
  expect(await caretSection(page)).toContain('How are they')
  // Each empty section item is one line; the last one is the template's open box.
  for (let i = 0; i < 12 && !(await caretSection(page))?.includes('Agreed actions'); i++) await page.keyboard.press('ArrowDown')
  expect(await caretSection(page)).toContain('Agreed actions')
  await page.keyboard.type('Send the plan')
  await expect(editor.locator('li[data-task="open"]')).toHaveText('Send the plan')
})

/** A fresh document with team T and member Ana, her notes open; returns the pane showing them. */
async function openAnasNotes(page: Page) {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, 'e2e-one-on-one-password')
  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'Save' }).click()
  await teamDialog.waitFor({ state: 'hidden' })
  await waitForWritable(page)
  const membersPane = page.locator('.tt-pane[data-pane-idx="1"]')
  await membersPane.getByRole('button', { name: '+ Person' }).click()
  const personDialog = page.getByRole('dialog')
  await personDialog.locator('input[name="tt-person-name"]').fill('Ana')
  await personDialog.getByRole('button', { name: 'Save' }).click()
  await personDialog.waitFor({ state: 'hidden' })
  await membersPane.locator('.tt-org-box', { hasText: 'Ana' }).dblclick()
  const pane = page.locator('.tt-pane', { has: page.locator('.tt-person-header') })
  await expect(pane).toHaveCount(1)
  return pane
}

test('1:1 flow: carry-over, undo, Alt+O, and an overdue 1:1 in the due surfaces', async ({ page }) => {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, 'e2e-one-on-one-password')

  // 1. A team with one member, then that member's notes.
  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'Save' }).click()
  await teamDialog.waitFor({ state: 'hidden' })
  await waitForWritable(page)

  // A new team opens split: general notes beside a module pane. Members go in the second one.
  const membersPane = page.locator('.tt-pane[data-pane-idx="1"]')
  await expect(membersPane.getByRole('button', { name: '+ Person' })).toBeVisible()
  await membersPane.getByRole('button', { name: '+ Person' }).click()
  const personDialog = page.getByRole('dialog')
  await personDialog.locator('input[name="tt-person-name"]').fill('Ana')
  await personDialog.getByRole('button', { name: 'Save' }).click()
  await personDialog.waitFor({ state: 'hidden' })
  await membersPane.locator('.tt-org-box', { hasText: 'Ana' }).dblclick()
  // Opening someone's notes shows them in whichever pane the app chose.
  const pane = page.locator('.tt-pane', { has: page.locator('.tt-person-header') })
  await expect(pane).toHaveCount(1)

  // 2. An open checklist item.
  const editor = pane.locator('.editor')
  await editor.click()
  await page.keyboard.type('- [] Ship plan')
  await expect(editor.locator('li[data-task="open"]')).toHaveText('Ship plan')

  // 3. New 1:1: the original is marked carried, the new block carries a copy, and the caret waits in "How are they".
  await pane.locator('.tt-person-header-one-on-one-btn').click()
  await expect(editor.locator('li[data-task="carried"]')).toHaveText('Ship plan')
  const carriedHeading = editor.locator('h3', { hasText: 'Carried over' })
  await expect(carriedHeading).toHaveCount(1)
  // (The template's own "Agreed actions" box is open and empty, hence the text filter.)
  await expect(editor.locator('li[data-task="open"]', { hasText: 'Ship plan' })).toHaveCount(1)
  expect(await caretSection(page)).toContain('How are they')
  // The new block is at the bottom: nothing follows its last section's list.
  expect(await editor.evaluate((ed) => ed.lastElementChild?.tagName)).toBe('UL')

  // 4. One Ctrl+Z takes the whole block out, and the original is open again.
  await page.keyboard.press('Control+z')
  await expect(carriedHeading).toHaveCount(0)
  await expect(editor.locator('li[data-task="carried"]')).toHaveCount(0)
  await expect(editor.locator('li[data-task="open"]')).toHaveText('Ship plan')

  // 5. Alt+O does it again from the keyboard.
  await page.keyboard.press('Alt+o')
  await expect(carriedHeading).toHaveCount(1)
  await expect(editor.locator('li[data-task="carried"]')).toHaveText('Ship plan')

  // 6. A Last 1:1 20 days ago makes the 1:1 overdue: a red dot on the Members module and the org box.
  await pane.locator('.tt-person-cadence').click()
  const editDialog = page.getByRole('dialog')
  await editDialog.locator('.tt-date-picker-input').fill(daysAgoUs(20))
  await editDialog.getByRole('button', { name: 'Save' }).click()
  await editDialog.waitFor({ state: 'hidden' })
  await expect(pane.locator('.tt-person-cadence')).toHaveClass(/overdue/)
  // The split pane is narrow, so its selector is the dropdown: the closed button
  // carries no dot, the Members row inside it does.
  await expect(pane.locator('.tt-pane-modules-btn .tt-due-dot')).toHaveCount(0)
  await pane.locator('.tt-pane-modules-btn').click()
  const membersRow = pane.locator('.tt-pane-menu-item', { has: page.locator('.tt-kind-members') })
  await expect(membersRow.locator('.tt-due-dot:not(.soon)')).toBeVisible()
  await page.keyboard.press('Escape')
  // The notes replaced the org chart in the pane; "Show in org chart" brings it back.
  await pane.locator('.tt-person-header-goto-org-btn').click()
  await expect(page.locator('.tt-org-box', { hasText: 'Ana' }).locator('.tt-org-due')).toBeVisible()

  // 7. The due panel lists it.
  await page.locator('.tt-due-btn').click()
  await expect(page.locator('.tt-due-row-title', { hasText: '1:1 · Ana' })).toBeVisible()
})
