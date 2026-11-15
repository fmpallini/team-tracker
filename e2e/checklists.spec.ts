// e2e/checklists.spec.ts — nested checklists driven the way people really use
// them, in a real Chromium: built by typing (Enter, Tab, Shift+Tab), checked
// by clicking the box and by Ctrl+Enter, undone, edited in the awkward places
// (Enter or Backspace on an empty sub-item, Enter at the end of a parent,
// select-all + delete), pasted from other apps, and reopened. jsdom cannot
// run Chromium's own Enter/Backspace/cut, which is where the structure goes
// wrong, so these legs only exist here (test/editor.test.ts has the rest).
//
// The rule every test leans on (src/ui/editor.ts, "Nested checklists"): a
// check or uncheck carries the item's whole subtree, a done item never holds
// open work below it, and checking the last open sub-task checks its parent.
// `expectSettled` asserts the second after every gesture.

import { test, expect, type Page } from '@playwright/test'
import { openEditor, clearEditor, pasteInto, lockClose, reopenLast } from './helpers'

const PASSWORD = 'e2e-checklists-password'
const MARK: Record<string, string> = { open: '[ ] ', done: '[x] ', carried: '[>] ' }

/**
 * The first editor's list items, one line each: two spaces per level (the
 * number of lists around the item, so a sub-list Chromium leaves beside its
 * item instead of inside it still counts as nested), the box, the item's own
 * text without its sub-items.
 */
async function outline(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    const ed = document.querySelector('.editor') as HTMLElement
    return Array.from(ed.querySelectorAll('li')).map((li) => {
      let depth = -1
      for (let n: Element | null = li; n && n !== ed; n = n.parentElement) if (n.tagName === 'UL' || n.tagName === 'OL') depth++
      const own = li.cloneNode(true) as HTMLElement
      own.querySelectorAll('ul, ol').forEach((l) => l.remove())
      return { depth, task: li.parentElement?.tagName === 'UL' ? li.getAttribute('data-task') : null, text: (own.textContent ?? '').replace(/ /g, ' ') }
    })
  })
  return raw.map((i) => `${'  '.repeat(i.depth)}${i.task ? MARK[i.task] : '- '}${i.text}`)
}

/** No done item holds an open task anywhere below it. */
async function expectSettled(page: Page): Promise<void> {
  const offenders = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.editor ul > li[data-task="done"]'))
      .filter((li) => li.querySelector('ul > li[data-task="open"]'))
      .map((li) => li.textContent))
  expect(offenders).toEqual([])
}

/** Types an outline: each entry is [depth, text]; the first line starts the checklist. */
async function typeTree(page: Page, lines: readonly (readonly [number, string])[]): Promise<void> {
  await clearEditor(page)
  let depth = 0
  for (const [i, [d, text]] of lines.entries()) {
    if (i === 0) await page.keyboard.type(`- [] ${text}`)
    else {
      await page.keyboard.press('Enter')
      for (; depth < d; depth++) await page.keyboard.press('Tab')
      for (; depth > d; depth--) await page.keyboard.press('Shift+Tab')
      await page.keyboard.type(text)
    }
    depth = d
  }
}

/** Clicks the box of the item whose own text is `text` (the box sits in its left padding, first line). */
async function clickBox(page: Page, text: string): Promise<void> {
  const li = page.locator('.editor').first().locator('li', { has: page.locator(`xpath=self::li[normalize-space(text()[1])="${text}"]`) })
  await li.click({ position: { x: 8, y: 10 } })
}

/** Puts the caret at the start or end of the item whose own first text is `text`. */
async function caretAt(page: Page, text: string, where: 'start' | 'end'): Promise<void> {
  await page.evaluate(([text, where]) => {
    const li = Array.from(document.querySelectorAll('.editor li')).find((l) => l.firstChild?.textContent?.trim() === text)!
    const node = li.firstChild!
    const r = document.createRange()
    r.setStart(node, where === 'start' ? 0 : node.textContent!.length)
    r.collapse(true)
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r)
  }, [text, where] as const)
}

const LAUNCH = [[0, 'Launch'], [1, 'Deck'], [2, 'Slides'], [2, 'Speaker notes'], [1, 'Budget'], [0, 'Retro']] as const

test.describe('nested checklists in a real browser', () => {
  test.beforeEach(async ({ page }) => { await openEditor(page, PASSWORD) })

  test('a tree typed with Enter, Tab and Shift+Tab is all open tasks at the right depths', async ({ page }) => {
    await typeTree(page, LAUNCH)
    expect(await outline(page)).toEqual([
      '[ ] Launch', '  [ ] Deck', '    [ ] Slides', '    [ ] Speaker notes', '  [ ] Budget', '[ ] Retro',
    ])
  })

  test('clicking a parent box checks the whole subtree; Ctrl+Z takes it back in one step; Ctrl+Y redoes it', async ({ page }) => {
    await typeTree(page, LAUNCH)
    await clickBox(page, 'Launch')
    expect(await outline(page)).toEqual([
      '[x] Launch', '  [x] Deck', '    [x] Slides', '    [x] Speaker notes', '  [x] Budget', '[ ] Retro',
    ])
    await page.keyboard.press('Control+z')
    expect(await outline(page)).toEqual([
      '[ ] Launch', '  [ ] Deck', '    [ ] Slides', '    [ ] Speaker notes', '  [ ] Budget', '[ ] Retro',
    ])
    await page.keyboard.press('Control+y')
    expect((await outline(page)).slice(0, 5).every((l) => l.includes('[x]'))).toBe(true)
  })

  test('unchecking a deep child reopens its parents only; unchecking the root unchecks everything', async ({ page }) => {
    await typeTree(page, LAUNCH)
    await clickBox(page, 'Launch')
    await clickBox(page, 'Slides')
    expect(await outline(page)).toEqual([
      '[ ] Launch', '  [ ] Deck', '    [ ] Slides', '    [x] Speaker notes', '  [x] Budget', '[ ] Retro',
    ])
    await expectSettled(page)
    // Checking the last open sub-task checks the parents it completes.
    await clickBox(page, 'Slides')
    expect(await outline(page)).toEqual([
      '[x] Launch', '  [x] Deck', '    [x] Slides', '    [x] Speaker notes', '  [x] Budget', '[ ] Retro',
    ])
    await clickBox(page, 'Launch')
    expect((await outline(page)).slice(0, 5).every((l) => l.includes('[ ]'))).toBe(true)
  })

  test('Ctrl+Enter with the caret on a parent cascades; Shift+Arrow over parent and child toggles once', async ({ page }) => {
    await typeTree(page, LAUNCH)
    await caretAt(page, 'Deck', 'end')
    await page.keyboard.press('Control+Enter')
    expect((await outline(page)).slice(1, 4)).toEqual(['  [x] Deck', '    [x] Slides', '    [x] Speaker notes'])
    await caretAt(page, 'Launch', 'start')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Control+Enter')
    // A mixed selection checks everything it covers, once.
    expect((await outline(page)).slice(0, 5).every((l) => l.includes('[x]'))).toBe(true)
    await page.keyboard.press('Control+Enter')
    expect((await outline(page)).slice(0, 5).every((l) => l.includes('[ ]'))).toBe(true)
  })

  test('adding work under a done item reopens it: Enter at a done child, Tab under a done item, "[] " typed', async ({ page }) => {
    await typeTree(page, LAUNCH)
    await clickBox(page, 'Launch')
    await caretAt(page, 'Budget', 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Contingency')
    expect(await outline(page)).toContain('  [ ] Contingency')
    expect((await outline(page))[0]).toBe('[ ] Launch')
    await expectSettled(page)

    await typeTree(page, [[0, 'Done thing']])
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('follow-up')
    await page.keyboard.press('Tab')
    expect(await outline(page)).toEqual(['[ ] Done thing', '  [ ] follow-up'])

    await clearEditor(page)
    await page.keyboard.type('- [] Parent')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Backspace') // the new item's box goes: a plain note is no open work…
    await page.keyboard.press('Tab')
    await page.keyboard.type('note')
    expect(await outline(page)).toEqual(['[x] Parent', '  - note'])
    await page.keyboard.press('Control+Enter') // …until it is made a task
    expect(await outline(page)).toEqual(['[ ] Parent', '  [ ] note'])
  })

  test('Enter on an empty sub-item steps out a level keeping its box; again on the top level leaves the list', async ({ page }) => {
    await typeTree(page, [[0, 'a'], [1, 'b']])
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('c')
    expect(await outline(page)).toEqual(['[ ] a', '  [ ] b', '[ ] c'])
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    expect(await outline(page)).toEqual(['[ ] a', '  [ ] b', '[ ] c'])
    await expect(page.locator('.editor').first().locator('> div', { hasText: 'after' })).toHaveCount(1)
  })

  test('Enter at the end of a parent starts its first sub-item, so the children keep their parent', async ({ page }) => {
    await typeTree(page, LAUNCH)
    await caretAt(page, 'Deck', 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Outline')
    expect(await outline(page)).toEqual([
      '[ ] Launch', '  [ ] Deck', '    [ ] Outline', '    [ ] Slides', '    [ ] Speaker notes', '  [ ] Budget', '[ ] Retro',
    ])
    await clickBox(page, 'Deck')
    expect((await outline(page)).slice(1, 5).every((l) => l.includes('[x]'))).toBe(true)
  })

  test('Backspace at the start of a sub-task removes its box, not its line', async ({ page }) => {
    await typeTree(page, [[0, 'Parent'], [1, 'Child']])
    await caretAt(page, 'Child', 'start')
    await page.keyboard.press('Backspace')
    expect(await outline(page)).toEqual(['[ ] Parent', '  - Child'])
    await page.keyboard.press('Control+z')
    expect(await outline(page)).toEqual(['[ ] Parent', '  [ ] Child'])
  })

  test('select-all + delete on a done list: what is typed next is not struck through', async ({ page }) => {
    await typeTree(page, [[0, 'a'], [1, 'b']])
    await clickBox(page, 'a')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.type('fresh')
    await expect(page.locator('.editor').first().locator('li[data-task="done"]')).toHaveCount(0)
  })

  test('cut and paste of a checked subtree keeps every state', async ({ page }) => {
    await typeTree(page, [[0, 'a'], [1, 'b'], [1, 'c']])
    await clickBox(page, 'b')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('Control+v')
    const lines = await outline(page)
    expect(lines.filter((l) => l.trim() !== '[ ]')).toEqual(['[ ] a', '  [x] b', '  [ ] c'])
    await expectSettled(page)
  })

  test('a checklist pasted from GitHub (checkbox inputs) and Google Docs (ARIA) keeps its states', async ({ page }) => {
    await clearEditor(page)
    await pasteInto(page, {
      'text/html': '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked> Ship<ul><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Notes</li></ul></li></ul>',
      'text/plain': '- [x] Ship\n  - [ ] Notes',
    })
    expect(await outline(page)).toEqual(['[x] Ship', '  [ ] Notes'])

    await clearEditor(page)
    await pasteInto(page, {
      'text/html': '<ul><li role="checkbox" aria-checked="true"><p>Booked</p></li><li role="checkbox" aria-checked="false"><p>Packed</p></li></ul>',
      'text/plain': 'Booked\nPacked',
    })
    expect(await outline(page)).toEqual(['[x] Booked', '[ ] Packed'])
  })

  test('a nested tree with mixed states survives close and reopen', async ({ page }) => {
    await typeTree(page, LAUNCH)
    await clickBox(page, 'Deck')
    await clickBox(page, 'Speaker notes')
    const before = await outline(page)
    expect(before).toEqual([
      '[ ] Launch', '  [ ] Deck', '    [x] Slides', '    [ ] Speaker notes', '  [ ] Budget', '[ ] Retro',
    ])
    await page.waitForTimeout(350)
    await lockClose(page)
    await reopenLast(page, PASSWORD)
    expect(await outline(page)).toEqual(before)
  })
})
