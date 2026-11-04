// e2e/editor-undo.spec.ts — acceptance suite of the editor's own undo/redo
// stack (src/ui/editor-undo.ts over src/ui/editor-snapshot.ts; design in
// docs/superpowers/specs/2026-11-03-editor-undo-snapshots-design.md, "Test
// plan (acceptance)"). jsdom has no real contenteditable, so step order,
// caret/scroll restore, several editors on one page, pictures and the cost on
// a long note can only be proven in Chromium.
//
// Step rules under test: a typing run closes on ~1 s idle, a change of kind
// (typing vs deleting), Enter (its own step) or a caret jump; every command,
// hand-made edit, paste and picker insert is one step; the browser's native
// history never acts.
import { test, expect, type Page, type Locator } from '@playwright/test'
import { openEditor, clearEditor, pasteInto } from './helpers'
import { buildDoc, openDoc, TEAM_ID } from './layout-fixtures'
import type { Doc, ModuleRef } from '../src/core/types'

const k = (page: Page) => page.keyboard
const html = (editor: Locator) => editor.evaluate((e) => e.innerHTML)
/** Each top-level block's text, NBSP read as a space. */
const blockTexts = (editor: Locator) =>
  editor.evaluate((e) => Array.from(e.children).map((c) => (c.textContent ?? '').replace(/ /g, ' ')))
/** The collapsed caret as {top-level block index, text offset inside it}. */
const caretPos = (editor: Locator) =>
  editor.evaluate((ed) => {
    const sel = getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    let top: Node | null = r.startContainer
    while (top && top.parentNode !== ed) top = top.parentNode
    if (!top) return null
    const probe = document.createRange()
    probe.setStart(top, 0)
    probe.setEnd(r.startContainer, r.startOffset)
    return { block: Array.prototype.indexOf.call(ed.children, top), offset: probe.toString().length, collapsed: r.collapsed }
  })
const IDLE = 1200 // past the stack's 1 s idle threshold: the next keystroke opens a new run

/** Collects console errors and page errors; assert on `errors` at the end. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

const DAY = '2026-06-15'
/** A fixture document (layout-fixtures.ts) with `notes` as the daily note of DAY. */
function docWith(ref: ModuleRef, opts: { splitRight?: ModuleRef; daily?: string } = {}): Doc {
  const doc = buildDoc('M', ref, opts.splitRight ? { splitRight: opts.splitRight } : {})
  if (opts.daily !== undefined) doc.teams.find((t) => t.id === TEAM_ID)!.dailyNotes[DAY] = opts.daily
  return doc
}

test.describe('editor undo — step order and typing runs', () => {
  test('Tab, type, Backspace: Ctrl+Z walks back Backspace, the typing, then the Tab — x never comes back after', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('- a')
    await k(page).press('Enter')
    await k(page).type('b')
    await k(page).press('Tab')
    await k(page).type('x')
    await k(page).press('Backspace')
    const nested = editor.locator('ul ul li')
    await expect(nested).toHaveText('b')

    await k(page).press('Control+z') // the Backspace (a delete run)
    await expect(nested).toHaveText('bx')
    await k(page).press('Control+z') // the typing run
    await expect(nested).toHaveText('b')
    await k(page).press('Control+z') // the Tab
    await expect(editor.locator('ul ul')).toHaveCount(0)
    await expect(editor.locator('li')).toHaveText(['a', 'b'])
    for (let i = 0; i < 4; i++) {
      await k(page).press('Control+z')
      await expect(editor).not.toContainText('x')
    }
  })

  test('type, pause, type: Ctrl+Z removes only the second run', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('one')
    await page.waitForTimeout(IDLE)
    await k(page).type('two')
    await expect(editor).toHaveText('onetwo')
    await k(page).press('Control+z')
    await expect(editor).toHaveText('one')
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual([''])
  })

  test('Enter is its own step: "ab" Enter "cd" undoes to "ab⏎", then "ab", then empty', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('ab')
    await k(page).press('Enter')
    await k(page).type('cd')
    await expect.poll(() => blockTexts(editor)).toEqual(['ab', 'cd'])
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual(['ab', ''])
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual(['ab'])
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual([''])
  })
})

test.describe('editor undo — the user keeps their place', () => {
  test('a trailing space survives: the caret comes back right after it', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('word ')
    await page.waitForTimeout(IDLE)
    await k(page).type('more')
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual(['word '])
    expect(await caretPos(editor)).toEqual({ block: 0, offset: 5, collapsed: true })
    // Typing goes on exactly there.
    await k(page).type('again')
    await expect.poll(() => blockTexts(editor)).toEqual(['word again'])
  })

  test('undo in a long note keeps scrollTop and the caret, and leaves unchanged blocks alone', async ({ page }) => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    await openDoc(page, docWith({ kind: 'daily', date: DAY }, { daily: lines }))
    const editor = page.locator('.editor').first()
    await expect(editor.locator('> div')).toHaveCount(300)
    // Scroll to the middle and click a line there: far from the top, the start of the note.
    await editor.evaluate((ed) => {
      ed.scrollTop = 4000
      const first = ed.firstElementChild as HTMLElement & { __mark?: number }
      const last = ed.lastElementChild as HTMLElement & { __mark?: number }
      first.__mark = 1
      last.__mark = 1
    })
    const target = editor.locator('> div').nth(150)
    await expect(target).toHaveText('line 150')
    await target.click()
    await k(page).press('End')
    await k(page).type(' edited')
    await expect(target).toHaveText('line 150 edited')
    await page.waitForTimeout(400)
    const before = await editor.evaluate((ed) => ed.scrollTop)
    expect(before).toBeGreaterThan(1000)
    await k(page).press('Control+z')
    await expect(target).toHaveText('line 150')
    const after = await editor.evaluate((ed) => ({
      scrollTop: ed.scrollTop,
      // Same nodes: the restore only swapped the block that changed.
      firstKept: (ed.firstElementChild as HTMLElement & { __mark?: number }).__mark === 1,
      lastKept: (ed.lastElementChild as HTMLElement & { __mark?: number }).__mark === 1,
    }))
    expect(after).toEqual({ scrollTop: before, firstKept: true, lastKept: true })
    const caret = await caretPos(editor)
    expect(caret).toEqual({ block: 150, offset: 'line 150'.length, collapsed: true })
  })

  test('with nothing to undo, Ctrl+Z / Ctrl+Y change nothing: content, caret, scroll', async ({ page }) => {
    const lines = Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n')
    await openDoc(page, docWith({ kind: 'daily', date: DAY }, { daily: lines }))
    const editor = page.locator('.editor').first()
    await editor.evaluate((ed) => { ed.scrollTop = 2000 })
    await editor.locator('> div').filter({ hasText: /^row 100$/ }).click()
    await k(page).press('End')
    const state = () => Promise.all([html(editor), caretPos(editor), editor.evaluate((ed) => ed.scrollTop)])
    const start = await state()
    for (const key of ['Control+z', 'Control+z', 'Control+z', 'Control+Shift+z', 'Control+y']) {
      await k(page).press(key)
    }
    // The Edit-menu path too.
    await page.evaluate(() => { document.execCommand('undo'); document.execCommand('redo') })
    await page.waitForTimeout(100)
    expect(await state()).toEqual(start)
  })
})

test.describe('editor undo — redo and the Edit-menu path', () => {
  // Chromium's Edit/context-menu Undo and Redo fire a cancelable beforeinput (historyUndo/historyRedo);
  // document.execCommand('undo') fires none and runs the browser's own history, which the editor then
  // takes back and replaces with its own step. Both reach the one stack, in one order with the keys.
  test('Ctrl+Y redoes; the Edit-menu path (execCommand undo, the menu beforeinput) goes through the same stack', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('one')
    await page.waitForTimeout(IDLE)
    await k(page).type(' two')
    await page.waitForTimeout(IDLE)
    await k(page).type(' three')
    await expect(editor).toHaveText('one two three')

    await k(page).press('Control+z')
    await expect(editor).toHaveText('one two')
    await k(page).press('Control+y')
    await expect(editor).toHaveText('one two three')

    const execUndo = () => page.evaluate(() => { document.execCommand('undo') })
    const menuRedo = () => editor.evaluate((ed) => {
      ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true }))
    })
    await execUndo()
    await expect(editor).toHaveText('one two')
    await execUndo()
    await expect(editor).toHaveText('one')
    // Mixed with the keys: one stack, in one order.
    await k(page).press('Control+y')
    await expect(editor).toHaveText('one two')
    await menuRedo()
    await expect(editor).toHaveText('one two three')
    await k(page).press('Control+z')
    await expect(editor).toHaveText('one two')
  })

  test('paste a bullet list, Tab-indent a pasted item, undo all the way and redo all the way', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    const empty = await html(editor)
    await pasteInto(page, { 'text/html': '<ul><li>one</li><li>two</li><li>three</li></ul>', 'text/plain': '- one\n- two\n- three' })
    await expect(editor.locator('li')).toHaveText(['one', 'two', 'three'])
    const pasted = await html(editor)
    await editor.locator('li', { hasText: 'two' }).click()
    await k(page).press('End')
    await k(page).press('Tab')
    await expect(editor.locator('ul ul li')).toHaveText('two')
    const indented = await html(editor)

    await k(page).press('Control+z')
    await expect.poll(() => html(editor)).toBe(pasted)
    await k(page).press('Control+z')
    await expect.poll(() => html(editor)).toBe(empty)
    await k(page).press('Control+Shift+z')
    await expect.poll(() => html(editor)).toBe(pasted)
    await k(page).press('Control+Shift+z')
    await expect.poll(() => html(editor)).toBe(indented)
  })
})

test.describe('editor undo — out-of-band DOM rewrites', () => {
  // A long block auto-collapses on load (over 8 lines). Once the user expands it and types inside, an undo
  // must not collapse it again: the caret would be hidden inside the collapsed part.
  test('an expanded long code block stays expanded after typing inside it and Ctrl+Z, caret visible', async ({ page }) => {
    const code = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    await openDoc(page, docWith({ kind: 'daily', date: DAY }, { daily: `intro\n\`\`\`\n${code}\n\`\`\`\nafter` }))
    const editor = page.locator('.editor').first()
    const pre = editor.locator('pre')
    await expect(pre).toHaveAttribute('data-collapsed', '')
    await pre.hover()
    await page.getByTitle('Expand block', { exact: true }).click()
    await expect(pre).not.toHaveAttribute('data-collapsed')
    const box = (await pre.boundingBox())!
    await pre.click({ position: { x: 40, y: box.height - 20 } })
    await k(page).press('End')
    await k(page).type('zz')
    await expect(pre).toContainText('zz')
    await page.waitForTimeout(400)

    await k(page).press('Control+z')
    await expect(pre).not.toContainText('zz')
    await expect(pre).not.toHaveAttribute('data-collapsed')
    const caret = await editor.evaluate((ed) => {
      const sel = getSelection()!
      const r = sel.getRangeAt(0)
      const rect = r.getClientRects()[0] ?? r.getBoundingClientRect()
      const preRect = ed.querySelector('pre')!.getBoundingClientRect()
      const edRect = ed.getBoundingClientRect()
      return {
        inPre: !!ed.querySelector('pre')!.contains(r.startContainer),
        insidePre: rect.height > 0 && rect.top >= preRect.top - 1 && rect.bottom <= preRect.bottom + 1,
        insideEditor: rect.top >= edRect.top - 1 && rect.bottom <= edRect.bottom + 1,
      }
    })
    expect(caret).toEqual({ inPre: true, insidePre: true, insideEditor: true })
  })

  test('a highlighted code block: the code and the text typed elsewhere come back in order', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('intro')
    await k(page).press('Enter')
    await k(page).type('```')
    await k(page).press('Enter')
    await expect(editor.locator('pre')).toHaveCount(1)
    await k(page).type('const x = 1')
    // Caret out of the block: the highlighter rewrites it into token spans.
    await k(page).press('Control+Home')
    await expect(editor.locator('pre .hl-kw')).toHaveCount(1)
    await k(page).press('End')
    await k(page).type(' more')
    const pre = editor.locator('pre')
    const first = editor.locator('> div').first()
    await expect(first).toHaveText('intro more')

    await k(page).press('Control+z')
    await expect(first).toHaveText('intro')
    await expect(pre).toHaveText('const x = 1')
    await k(page).press('Control+z')
    await expect(pre).toHaveText('')
    await expect(first).toHaveText('intro')
    await k(page).press('Control+Shift+z')
    await expect(pre).toHaveText('const x = 1')
    await expect(first).toHaveText('intro')
    await k(page).press('Control+Shift+z')
    await expect(first).toHaveText('intro more')
    await expect(pre).toHaveText('const x = 1')
    await expect(editor.locator('pre')).toHaveCount(1)
  })

  test('a chip relabelled from the other pane, then undo: no text duplicated or lost, the chip shows the new label', async ({ page }) => {
    await openDoc(page, docWith({ kind: 'daily', date: DAY }, { splitRight: { kind: 'risks' }, daily: 'see @[Risk 1](risk:r1) today' }))
    const p0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const p1 = page.locator('.tt-pane[data-pane-idx="1"]')
    const editor = p0.locator('.editor')
    await expect(editor.locator('a.ref')).toHaveText('@Risk 1')
    await editor.click()
    await k(page).press('Control+End')
    await k(page).type(' later')
    await page.waitForTimeout(400)

    const title = p1.locator('.tt-risk-row[data-risk-id="r1"] .tt-risk-title-input')
    await title.fill('Renamed risk')
    await title.press('Enter')
    await expect(editor.locator('a.ref')).toHaveText('@Renamed risk')

    await editor.click()
    await k(page).press('Control+End')
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual(['see @Renamed risk today'])
    await expect(editor.locator('a.ref')).toHaveCount(1)
    await k(page).press('Control+Shift+z')
    await expect.poll(() => blockTexts(editor)).toEqual(['see @Renamed risk today later'])
    await expect(editor.locator('a.ref')).toHaveCount(1)
  })

  test('a mention chip from the @ picker: undo gives back the typed "@tod", redo the chip', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('due @tod')
    await expect(page.locator('.tt-atref-dropdown')).toBeVisible()
    await k(page).press('Enter')
    const chip = editor.locator('a.ref[data-ref^="day:"]')
    await expect(chip).toHaveCount(1)
    const withChip = await html(editor)

    await k(page).press('Control+z')
    await expect(chip).toHaveCount(0)
    await expect.poll(() => blockTexts(editor)).toEqual(['due @tod'])
    await k(page).press('Control+Shift+z')
    await expect.poll(() => html(editor)).toBe(withChip)
    await expect(chip).toHaveCount(1)
  })

  test('a template from the / picker: undo gives back the "/" line, redo the template', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    await k(page).type('top')
    await k(page).press('Enter')
    await k(page).type('/')
    await expect(page.locator('.tt-atref-dropdown')).toBeVisible()
    await k(page).press('Enter')
    await expect.poll(async () => (await blockTexts(editor)).length).toBeGreaterThan(2)
    const inserted = await html(editor)

    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(editor)).toEqual(['top', '/'])
    await k(page).press('Control+Shift+z')
    await expect.poll(() => html(editor)).toBe(inserted)
  })
})

test.describe('editor undo — several editors', () => {
  test('two follow-up editors on one page: Ctrl+Z only acts on the focused one', async ({ page }) => {
    await openDoc(page, docWith({ kind: 'risks' }))
    await page.locator('.tt-risk-expand-all-btn').click()
    await expect(page.locator('.tt-risk-followup-row .editor')).toHaveCount(24)
    const a = page.locator('.tt-risk-followup-row[data-risk-followup-id="r0"] .editor')
    const b = page.locator('.tt-risk-followup-row[data-risk-followup-id="r1"] .editor')
    await a.click()
    await k(page).type('AAA')
    await page.waitForTimeout(400)
    await b.click()
    await k(page).type('BBB')
    await page.waitForTimeout(400)

    await a.click()
    await k(page).press('Control+End')
    await k(page).press('Control+z')
    await expect(a).toHaveText('')
    await expect(b).toHaveText('BBB')
    await k(page).press('Control+Shift+z')
    await expect(a).toHaveText('AAA')

    await b.click()
    await k(page).press('Control+z')
    await expect(b).toHaveText('')
    await expect(a).toHaveText('AAA')
  })

  test('split view: undo in one pane never touches the other pane', async ({ page }) => {
    await openDoc(page, docWith({ kind: 'daily', date: DAY }, { splitRight: { kind: 'general' } }))
    const left = page.locator('.tt-pane[data-pane-idx="0"] .editor')
    const right = page.locator('.tt-pane[data-pane-idx="1"] .editor')
    await expect(right).toBeVisible()
    const leftStart = await blockTexts(left)
    await left.click()
    await k(page).type('left side')
    await page.waitForTimeout(400)
    await right.click()
    await k(page).type('right side')
    await page.waitForTimeout(400)
    const rightTyped = await html(right)

    await left.click()
    await k(page).press('Control+z')
    await expect.poll(() => blockTexts(left)).toEqual(leftStart)
    expect(await html(right)).toBe(rightTyped)
    await k(page).press('Control+Shift+z')
    await expect(left).toContainText('left side')
    expect(await html(right)).toBe(rightTyped)
  })

  test('the note reloaded from the other pane clears the stack: Ctrl+Z cannot wipe that edit', async ({ page }) => {
    await openDoc(page, docWith({ kind: 'risks' }, { splitRight: { kind: 'risks' } }))
    const p0 = page.locator('.tt-pane[data-pane-idx="0"]')
    const p1 = page.locator('.tt-pane[data-pane-idx="1"]')
    for (const p of [p0, p1]) {
      await p.locator('.tt-risk-row[data-risk-id="r0"] .tt-risk-expand-btn').click()
      await expect(p.locator('.tt-risk-followup-row[data-risk-followup-id="r0"] .editor')).toBeVisible()
    }
    const left = p0.locator('.tt-risk-followup-row[data-risk-followup-id="r0"] .editor')
    const right = p1.locator('.tt-risk-followup-row[data-risk-followup-id="r0"] .editor')
    await left.click()
    await k(page).type('left')
    await page.waitForTimeout(400)
    await expect(right).toHaveText('left')
    await left.evaluate((ed) => { (ed as HTMLElement & { __mark?: number }).__mark = 1 })

    await right.click()
    await k(page).press('Control+End')
    await k(page).type(' right')
    await page.waitForTimeout(400)
    // The left pane rebuilt its editor from the store: a fresh stack.
    await expect(left).toHaveText('left right')
    expect(await left.evaluate((ed) => (ed as HTMLElement & { __mark?: number }).__mark)).toBeUndefined()

    await left.click()
    await k(page).press('Control+End')
    await k(page).press('Control+z')
    await k(page).press('Control+z')
    await page.waitForTimeout(400)
    await expect(left).toHaveText('left right')
    await expect(right).toHaveText('left right')
  })
})

// ---- pictures ---------------------------------------------------------------

/** Defines `window.__ttPng(w, h, noise)` in the page: a PNG File drawn there (bytes never cross the Playwright wire). */
async function installPicMaker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __ttPng: (w: number, h: number, noise: boolean) => Promise<File> }).__ttPng = async (w, h, noise) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')!
      if (noise) {
        const data = ctx.createImageData(w, h)
        for (let i = 0; i < data.data.length; i++) data.data[i] = i % 4 === 3 ? 255 : Math.random() * 256
        ctx.putImageData(data, 0, 0)
      } else {
        const g = ctx.createLinearGradient(0, 0, w, h)
        g.addColorStop(0, '#c0392b')
        g.addColorStop(1, '#2980b9')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
      }
      const blob: Blob = await new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'))
      return new File([blob], 'pic.png', { type: 'image/png' })
    }
  })
}

/** Pastes one picture at the end of the first editor. */
async function pastePicture(page: Page, w = 120, h = 80, noise = false): Promise<void> {
  await page.evaluate(async ({ w, h, noise }) => {
    const ed = document.querySelector('.editor') as HTMLElement
    ed.focus()
    const sel = getSelection()!
    const r = document.createRange()
    r.selectNodeContents(ed.lastElementChild ?? ed)
    r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
    const dt = new DataTransfer()
    dt.items.add(await (window as unknown as { __ttPng: (w: number, h: number, n: boolean) => Promise<File> }).__ttPng(w, h, noise))
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, { w, h, noise })
}

test.describe('editor undo — pictures', () => {
  test('paste a picture, undo, redo: one <img>, never a duplicate, no console error; an edit elsewhere keeps the rendered picture', async ({ page }) => {
    const errors = watchErrors(page)
    await installPicMaker(page)
    const editor = await openEditor(page)
    await clearEditor(page)
    const imgs = editor.locator('.tt-img img')
    await pastePicture(page)
    await expect(imgs).toHaveCount(1)
    await expect.poll(() => imgs.first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

    await k(page).press('Control+z')
    await expect(editor.locator('.tt-img')).toHaveCount(0)
    await k(page).press('Control+Shift+z')
    await expect(imgs).toHaveCount(1)
    await expect.poll(() => imgs.first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    await expect(imgs).toHaveCount(1)
    await expect(editor.locator('.tt-img')).toHaveCount(1)

    // Typing after the picture, then undo: the picture's block is not rebuilt (no reload, no flicker).
    await imgs.first().evaluate((i) => { (i as HTMLElement & { __mark?: number }).__mark = 1 })
    await k(page).press('Control+End')
    await k(page).type('caption')
    await expect(editor).toContainText('caption')
    await k(page).press('Control+z')
    await expect(editor).not.toContainText('caption')
    expect(await imgs.first().evaluate((i) => (i as HTMLElement & { __mark?: number }).__mark)).toBe(1)

    // Delete the picture (click selects, Backspace removes), undo brings it back unselected.
    await imgs.first().click()
    await k(page).press('Backspace')
    await expect(editor.locator('.tt-img')).toHaveCount(0)
    await k(page).press('Control+z')
    await expect(imgs).toHaveCount(1)
    await expect(editor.locator('.tt-img.is-selected')).toHaveCount(0)
    await k(page).press('Control+Shift+z')
    await expect(editor.locator('.tt-img')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('undo while the pasted picture is still loading, then redo: no stray <img>, no error', async ({ page }) => {
    const errors = watchErrors(page)
    await installPicMaker(page)
    const editor = await openEditor(page)
    await clearEditor(page)
    // Ctrl+Z dispatched the moment the picture block lands, before its bytes are read back.
    const sawLoading = await page.evaluate(async () => {
      const ed = document.querySelector('.editor') as HTMLElement
      const landed = new Promise<boolean>((resolve) => {
        const mo = new MutationObserver(() => {
          const block = ed.querySelector<HTMLElement>('.tt-img')
          if (!block) return
          mo.disconnect()
          const loading = block.dataset.imgLoading === '1' && !block.querySelector('img')
          ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }))
          resolve(loading)
        })
        mo.observe(ed, { childList: true, subtree: true })
      })
      ed.focus()
      const dt = new DataTransfer()
      dt.items.add(await (window as unknown as { __ttPng: (w: number, h: number, n: boolean) => Promise<File> }).__ttPng(200, 100, false))
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return landed
    })
    expect(sawLoading).toBe(true)
    await page.waitForTimeout(500)
    await expect(editor.locator('.tt-img')).toHaveCount(0)
    await expect(editor.locator('img')).toHaveCount(0)

    await k(page).press('Control+Shift+z')
    await expect(editor.locator('.tt-img img')).toHaveCount(1)
    await page.waitForTimeout(300)
    await expect(editor.locator('img')).toHaveCount(1)
    expect(errors).toEqual([])
  })
})

// The same budget as the 1,500-line paste spec in editor.spec.ts: each step stays under 1.5 s.
test.describe('editor undo — cost on a long note', () => {
  test('a 1,500-line note with pictures: one edit and its Ctrl+Z each finish in under 1.5 s', async ({ page }) => {
    await installPicMaker(page)
    const editor = await openEditor(page)
    await clearEditor(page)
    const text = Array.from({ length: 1500 }, (_, i) => `2026-10-17 12:00:${String(i % 60).padStart(2, '0')} INFO request ${i} path=/api/v1/items_${i}*`).join('\n')
    await page.evaluate((text) => {
      const ed = document.querySelector('.editor') as HTMLElement
      ed.focus()
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, text)
    await expect(editor.locator('> div')).toHaveCount(1500)
    // A large, incompressible picture, cloned through the note: every snapshot walks its data URI.
    await pastePicture(page, 1200, 900, true)
    await expect(editor.locator('.tt-img img')).toHaveCount(1)
    const uriLength = await editor.evaluate((ed) => {
      const block = ed.querySelector('.tt-img')!
      const kids = Array.from(ed.children)
      for (let i = 1; i < 20; i++) kids[i * 70]!.after(block.cloneNode(true))
      return (ed.querySelector('.tt-img img') as HTMLImageElement).src.length
    })
    expect(await editor.locator('.tt-img img').count()).toBe(20)
    await page.waitForTimeout(400)

    // Timing hooks: capture-phase keydown starts the clock; the input event (typing) or the bubbling keydown
    // after the editor's own handler (undo, which runs synchronously) stops it.
    await page.evaluate(() => {
      const w = window as unknown as { __t0: number; __typed: number; __undone: number }
      window.addEventListener('keydown', () => { w.__t0 = performance.now() }, true)
      window.addEventListener('input', () => { w.__typed = performance.now() - w.__t0 })
      window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'z') w.__undone = performance.now() - w.__t0 })
    })
    const line = editor.locator('> div').filter({ hasText: /request 700 / })
    await line.click()
    await k(page).press('End')
    await k(page).press('x')
    await expect(line).toHaveText(/items_700\*x$/)
    await page.waitForTimeout(400)
    await k(page).press('Control+z')
    await expect(line).toHaveText(/items_700\*$/)
    const t = await page.evaluate(() => {
      const w = window as unknown as { __typed: number; __undone: number }
      return { typed: w.__typed, undone: w.__undone }
    })
    console.log(`[perf] 1,500 lines + 20 pictures (data URI ${uriLength} chars): edit ${t.typed.toFixed(1)} ms, undo ${t.undone.toFixed(1)} ms`)
    expect(t.typed).toBeLessThan(1500)
    expect(t.undone).toBeLessThan(1500)
    expect(await editor.locator('.tt-img img').count()).toBe(20)
  })
})
