// e2e/keyboard.spec.ts — keyboard-only flows through the real app. Unit tests
// cover the routing; what only a real browser can show lives here: where focus
// and the caret actually end up after Chrome has finished its own focus work,
// and that an editor survives a pane switch with its undo stack intact.
import { test, expect, type Page } from '@playwright/test'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { openDoc } from './layout-fixtures'
import type { Doc, ModuleRef } from '../src/core/types'

const TEAM = 'team-0'
const today = new Date().toLocaleDateString('en-CA')
const DAILY: ModuleRef = { kind: 'daily', date: today }

function buildDoc(ref: ModuleRef, split?: ModuleRef): Doc {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam(TEAM, 'Alpha', 'A', 'en-US')
  team.actionColumns = [{ id: 'c1', name: 'Doing', order: 0 }]
  for (let i = 0; i < 6; i++) {
    team.actionItems.push({ id: `a${i}`, summary: `Task ${i}`, status: 'todo', dueDate: null, assignee: '', order: i, notes: '', color: null })
    team.risks.push({ id: `r${i}`, title: `Risk ${i}`, chance: 1, impact: 2, plan: 'mitigate', followup: '', order: i, closed: false })
    team.milestones.push({ id: `m${i}`, date: `2030-01-0${i + 1}`, title: `Milestone ${i}`, done: false, followup: '' })
  }
  team.members.push(
    { id: 'p0', name: 'Ana', role: 'Lead', parentId: null, order: 0, notes: '' },
    { id: 'p1', name: 'Bruno', role: 'Dev', parentId: 'p0', order: 0, notes: '' },
    { id: 'p2', name: 'Carla', role: 'Dev', parentId: 'p0', order: 1, notes: '' },
  )
  team.dailyNotes[today] = 'First line\n\nSecond line'
  doc.teams.push(team, createEmptyTeam('team-1', 'Beta', 'B', 'en-US'))
  doc.nav.activeTeamId = TEAM
  doc.nav.focusedPane = 0
  doc.nav.split = split !== undefined
  doc.nav.teamSplit = split ? { [TEAM]: true } : {}
  doc.nav.panes = [
    { history: [{ teamId: TEAM, ref }], index: 0 },
    split ? { history: [{ teamId: TEAM, ref: split }], index: 0 } : { history: [], index: -1 },
  ]
  return doc
}

const focused = (page: Page): Promise<string | null> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement
  return a.dataset.itemId ?? a.className
})

const caretText = (page: Page): Promise<string> => page.evaluate(() => {
  const s = getSelection()!
  return `${s.anchorNode?.textContent}:${s.anchorOffset}`
})

test('a pane switch leaves the editor alone: caret, undo and the other pane\'s open rows all survive', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY, { kind: 'risks' }))
  const editor = page.locator('.editor').first()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' typed')
  await page.waitForTimeout(400)
  const caret = await caretText(page)

  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => focused(page)).toBe('r0')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-risk-row-expanded')).toHaveCount(1)

  await page.keyboard.press('Alt+ArrowLeft')
  await expect(editor).toBeFocused()
  expect(await caretText(page)).toBe(caret)
  await page.keyboard.press('Control+z')
  await expect(editor).not.toContainText('typed')

  await page.keyboard.press('Alt+ArrowRight')
  await expect(page.locator('.tt-risk-row-expanded')).toHaveCount(1)
})

test('Escape leaves a note for its tab, and Enter goes back to the same caret', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY))
  const editor = page.locator('.editor').first()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('!')
  const caret = await caretText(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-pane-tab.active').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  expect(await caretText(page)).toBe(caret)
})

test('a task travels the board by keyboard, with focus on it the whole way', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'actions' }))
  await expect.poll(() => focused(page)).toBe('a0')
  await page.keyboard.press('Control+ArrowRight')
  await expect(page.locator('.tt-kanban-card.status-c1')).toHaveCount(1)
  await page.keyboard.press('Control+ArrowRight')
  await expect(page.locator('.tt-kanban-card.status-done')).toHaveCount(1)
  await expect.poll(() => focused(page)).toBe('a0')

  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => focused(page)).not.toBe('a0')
  await page.keyboard.press('Control+ArrowDown')
  const moved = await focused(page)
  await expect(page.locator('.tt-kanban-card.status-todo').nth(1)).toHaveAttribute('data-item-id', moved!)
})

test('a commit keeps your row: the next arrow carries on from it', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'risks' }))
  await expect.poll(() => focused(page)).toBe('r0')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => focused(page)).toBe('r2')
  await page.keyboard.press('Tab')
  await page.keyboard.type(' edited')
  await page.keyboard.press('Enter')
  await expect.poll(() => focused(page)).toBe('r2')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => focused(page)).toBe('r3')
})

test('tabbing out of an edited title keeps going through the row', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'risks' }))
  await expect.poll(() => focused(page)).toBe('r0')
  await page.keyboard.press('Tab')
  await page.keyboard.type(' edited')
  await page.keyboard.press('Tab')
  await expect(page.locator('.tt-risk-row').first().locator('.tt-risk-chance-select')).toBeFocused()
})

test('tabbing out of a typed date reaches the title, even as the row re-sorts', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'milestones' }))
  await expect.poll(() => focused(page)).toBe('m0')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('12252031')
  await page.keyboard.press('Tab')
  await expect(page.locator('.tt-milestone-row[data-item-id="m0"] .tt-milestone-title-input')).toBeFocused()
})

test('ticking a milestone keeps the row', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'milestones' }))
  await expect.poll(() => focused(page)).toBe('m0')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Space')
  await expect(page.locator('.tt-milestone-done-row')).toHaveCount(1)
  await expect.poll(() => focused(page)).toBe('m1')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => focused(page)).toBe('m2')
})

test('delete lands on the neighbour and Ctrl+Z brings the item back', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'actions' }))
  await expect.poll(() => focused(page)).toBe('a0')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-kanban-card')).toHaveCount(5)
  await expect.poll(() => focused(page)).toBe('a2')
  await page.keyboard.press('Control+z')
  await expect(page.locator('.tt-kanban-card')).toHaveCount(6)
  await expect.poll(() => focused(page)).toBe('a2')
})

test('Ctrl+Z with nothing to undo never reaches the browser', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'actions' }))
  await expect.poll(() => focused(page)).toBe('a0')
  await page.evaluate(() => {
    window.addEventListener('keydown', (e) => { (window as unknown as { swallowed: boolean }).swallowed = e.defaultPrevented })
  })
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => (window as unknown as { swallowed: boolean }).swallowed)).toBe(true)
})

test('closing a dialog opened from a note gives the caret back', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY))
  const editor = page.locator('.editor').first()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('!')
  const caret = await caretText(page)
  await page.locator('.tt-editor-btn-readonly-safe').last().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor).toBeFocused()
  expect(await caretText(page)).toBe(caret)
})

test('closing a dialog returns to the button that opened it', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY))
  const settings = page.locator('.tt-btn-settings')
  await settings.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeFocused()
})

test('coming back to a module lands on the item you left; a person opens in their notes', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'actions' }))
  await expect.poll(() => focused(page)).toBe('a0')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => focused(page)).toBe('a2')
  await page.keyboard.press('F8')
  await expect.poll(() => focused(page)).toBe('r0')
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect.poll(() => focused(page)).toBe('a2')

  await page.keyboard.press('F5')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => focused(page)).toBe('p2')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-person-notes .editor')).toBeFocused()
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect.poll(() => focused(page)).toBe('p2')
})

test('the fast switch runs commands: > Add risk opens Risks with a new row', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY))
  await page.keyboard.press('Control+Shift+KeyK')
  await page.keyboard.type('>add risk')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-risk-title-input:focus')).toHaveCount(1)
  await page.keyboard.type('From the palette')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-risk-row')).toHaveCount(8)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-risk-row')).toHaveCount(7)
})

test('Alt+N adds, and Tab leaves a long list in one press', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'actions' }))
  await expect.poll(() => focused(page)).toBe('a0')
  await page.keyboard.press('Tab')
  await expect.poll(() => focused(page)).not.toMatch(/^ad$/)
  await page.keyboard.press('Alt+n')
  await page.keyboard.type('Quick one')
  await page.keyboard.press('Control+Enter')
  await page.keyboard.type('Quick two')
  await page.keyboard.press('Escape')
  await expect(page.locator('.tt-kanban-card')).toHaveCount(8)
})

test('a date moves by keyboard, and its calendar can be walked', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'milestones' }))
  await expect.poll(() => focused(page)).toBe('m0')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const date = page.locator('.tt-milestone-row[data-item-id="m0"] .tt-date-picker-input')
  await expect(date).toBeFocused()
  await expect(page.locator('.tt-date-picker-popover')).toHaveCount(0)
  await page.keyboard.press('ArrowUp')
  await expect(date).toHaveValue('01/02/2030')
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-date-picker-popover')).toHaveCount(0)
  await expect(date).toBeFocused()
  await expect(date).toHaveValue('01/03/2030')
})

test('Delete, Home and End work a list from the row', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'risks' }))
  await expect.poll(() => focused(page)).toBe('r0')
  await page.keyboard.press('End')
  await expect.poll(() => focused(page)).toBe('r5')
  await page.keyboard.press('Delete')
  await expect(page.locator('.tt-risk-row')).toHaveCount(5)
  await expect.poll(() => focused(page)).toBe('r4')
  await page.keyboard.press('Home')
  await expect.poll(() => focused(page)).toBe('r0')
})

test('Ctrl+Enter opens a fast-switch row in the other pane', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY))
  await page.keyboard.press('Control+Shift+KeyK')
  await page.keyboard.type('risks')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('[data-pane-idx="1"] .tt-risk-row').first()).toBeVisible()
  await expect(page.locator('[data-pane-idx="0"] .editor')).toBeVisible()
})

test('search hands focus back on the way out', async ({ page }) => {
  await openDoc(page, buildDoc({ kind: 'actions' }))
  await expect.poll(() => focused(page)).toBe('a0')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('/')
  await expect(page.locator('.tt-search-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect.poll(() => focused(page)).toBe('a1')
})

test('the team list works from the keyboard, and F-keys leave modified chords alone', async ({ page }) => {
  await openDoc(page, buildDoc(DAILY))
  await page.locator('.tt-team-item.active').focus()
  await page.keyboard.press('Control+ArrowDown')
  await expect(page.locator('.tt-team-item').nth(1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tt-team-item').nth(0)).toHaveClass(/active/)

  const title = await page.locator('.tt-pane-tab.active').first().innerText()
  await page.keyboard.press('Alt+F4')
  expect(await page.locator('.tt-pane-tab.active').first().innerText()).toBe(title)
})
