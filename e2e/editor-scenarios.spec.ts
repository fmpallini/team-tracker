// e2e/editor-scenarios.spec.ts — editing behavior as a table, in real Chromium.
//
// test/editor.test.ts runs under jsdom, which has no document.execCommand, no
// real selection model and no layout, so most of the editor's bugs (paste,
// undo, list structure, autoformat) can only be seen here. Each row is: the
// note as it starts (markdown, with ‸ marking the caret — two of them mark a
// selection), the steps a user takes, and the markdown the app SAVES — read
// back from the browser copy, the same bytes the file gets. Adding a
// regression is one row.
//
// Step strings are typed; press()/paste()/pasteHtml()/waitFor() build the others.
import { test, expect, type Page } from '@playwright/test'
import { openDoc } from './layout-fixtures'
import { flushLiveCopy } from './helpers'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

const TEAM = 'team-0'
const TODAY = new Date().toLocaleDateString('en-CA')
const CARET = '‸'

type Step = string | { press: string } | { paste: Record<string, string> } | { wait: string }
const press = (key: string): Step => ({ press: key })
const paste = (text: string): Step => ({ paste: { 'text/plain': text } })
const pasteHtml = (html: string, text: string): Step => ({ paste: { 'text/html': html, 'text/plain': text } })
/** Waits for `selector` to be visible (a picker opening on what was typed). */
const waitFor = (selector: string): Step => ({ wait: selector })

interface Row {
  name: string
  /**
   * The note before the steps; ‸ is the caret, two ‸ a selection. Empty: an empty note, caret in it. It loads as
   * markdown, so a space at the end of a line is not kept — type it as a step instead.
   */
  start: string
  steps: Step[]
  /** The note's saved markdown afterwards. */
  saved: string
}

const ROWS: Row[] = [
  // --- typing and autoformat --------------------------------------------------
  { name: '"- " starts a bulleted list, Enter continues it', start: '', steps: ['- one', press('Enter'), 'two'], saved: '- one\n- two' },
  { name: '"1. " starts a numbered list', start: '', steps: ['1. a', press('Enter'), 'b'], saved: '1. a\n2. b' },
  { name: '"> " starts a quote', start: '', steps: ['> q'], saved: '> q' },
  // The editor parks the caret after the bold in a space of its own; the space typed next is that one, not a second.
  { name: '"**x**" becomes bold as the closing marker is typed, and the next space is not doubled', start: '', steps: ['a **b** c'], saved: 'a **b** c' },
  { name: 'two spaces typed after the bold stay two', start: '', steps: ['a **b**  c'], saved: 'a **b**  c' },
  { name: 'an @-mention picked from the list, then a space and a word: one space', start: '', steps: ['see @Ana', waitFor('.tt-atref-dropdown'), press('Enter'), ' x'], saved: 'see @[Ana](person:p1) x' },
  { name: '"# " on the line under text makes THAT line a heading', start: `above${CARET}`, steps: [press('Enter'), '# Title'], saved: 'above\n# Title' },
  { name: 'Ctrl+1 on a blank line under text makes that line a heading', start: `text${CARET}`, steps: [press('Enter'), press('Control+1'), 'H'], saved: 'text\n# H' },
  { name: 'Ctrl+B bolds the selected word', start: `a ${CARET}word${CARET} b`, steps: [press('Control+b')], saved: 'a **word** b' },

  // --- list structure ---------------------------------------------------------
  { name: 'Enter mid-item splits the item', start: `- ab${CARET}cd`, steps: [press('Enter')], saved: '- ab\n- cd' },
  { name: 'Enter on an empty item ends the list', start: `- a${CARET}`, steps: [press('Enter'), press('Enter'), 'p'], saved: '- a\np' },
  { name: 'Tab nests an item', start: `- a\n- b${CARET}`, steps: [press('Tab')], saved: '- a\n  - b' },
  { name: 'Shift+Tab lifts a nested item', start: `- a\n  - b${CARET}`, steps: [press('Shift+Tab')], saved: '- a\n- b' },
  { name: 'Enter on the empty last line of a quote leaves the quote', start: `> q${CARET}`, steps: [press('Enter'), press('Enter'), 'after'], saved: '> q\nafter' },

  // --- paste ------------------------------------------------------------------
  { name: 'plain text pasted mid-item stays inside the item', start: `- ab${CARET}cd`, steps: [paste('XY')], saved: '- abXYcd' },
  { name: 'plain text pasted mid-paragraph', start: `ab${CARET}cd`, steps: [paste('XY')], saved: 'abXYcd' },
  { name: 'an HTML list pasted into an empty note becomes a real list', start: '', steps: [pasteHtml('<ul><li>one</li><li>two</li></ul>', 'one\ntwo')], saved: '- one\n- two' },
  { name: 'blocks inside one pasted list item save as sibling items', start: '', steps: [pasteHtml('<ul><li><p>a</p><p>b</p></li></ul>', 'a\nb')], saved: '- a\n- b' },
  { name: 'styled HTML pasted into a heading keeps a plain heading', start: `# He${CARET}ad`, steps: [pasteHtml('<span style="color:red;font-size:30px">X</span>', 'X')], saved: '# HeXad' },
  { name: 'HTML pasted inside a code block lands as its literal text', start: `\`\`\`\ncode${CARET}\n\`\`\``, steps: [pasteHtml('<b>bold</b>', 'bold')], saved: '```\ncodebold\n```' },

  // --- undo / redo ------------------------------------------------------------
  { name: 'Ctrl+Z takes a paste back', start: `ab${CARET}`, steps: [paste('XY'), press('Control+z')], saved: 'ab' },
  { name: 'Ctrl+Z takes a Tab back', start: `- a\n- b${CARET}`, steps: [press('Tab'), press('Control+z')], saved: '- a\n- b' },
  { name: 'Ctrl+Shift+Z redoes the Tab', start: `- a\n- b${CARET}`, steps: [press('Tab'), press('Control+z'), press('Control+Shift+z')], saved: '- a\n  - b' },
]

function noteDoc(note: string): Doc {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam(TEAM, 'Team', '📝', 'en-US')
  team.dailyNotes[TODAY] = note
  team.members.push({ id: 'p1', name: 'Ana', role: '', parentId: null, order: 0, notes: '' })
  doc.teams.push(team)
  doc.nav.activeTeamId = TEAM
  doc.nav.panes = [{ history: [{ teamId: TEAM, ref: { kind: 'daily', date: TODAY } }], index: 0 }, { history: [], index: -1 }]
  return doc
}

/** Focuses the editor and turns its ‸ markers into the selection (an empty note: caret in its first block). */
async function placeCaret(page: Page): Promise<void> {
  await page.evaluate((mark) => {
    const ed = document.querySelector<HTMLElement>('.editor')!
    ed.focus()
    const points: Array<[Node, number]> = []
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    // Last marker first, so removing it leaves the earlier offsets valid.
    for (const node of nodes.reverse()) {
      for (let i = node.data.lastIndexOf(mark); i !== -1; i = node.data.lastIndexOf(mark, i - 1)) {
        node.deleteData(i, mark.length)
        points.unshift([node, i])
        if (i === 0) break
      }
    }
    for (const [node] of points) {
      const block = node.parentElement!
      if (block.textContent === '' && !block.querySelector('br')) block.appendChild(document.createElement('br'))
    }
    const range = document.createRange()
    if (points.length === 0) {
      range.selectNodeContents(ed.firstElementChild ?? ed)
      range.collapse(true)
    } else {
      const [a, b] = [points[0]!, points[points.length - 1]!]
      const at = (p: [Node, number]): [Node, number] => ((p[0] as Text).data === '' ? [p[0].parentElement!, 0] : p)
      range.setStart(...at(a))
      range.setEnd(...at(b))
    }
    const sel = getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }, CARET)
}

/** A real paste event at the current selection: the app reads only `clipboardData`, and its execCommand is the browser's. */
async function dispatchPaste(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((data) => {
    const dt = new DataTransfer()
    for (const [type, value] of Object.entries(data)) dt.setData(type, value)
    document.querySelector('.editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
}

/** The note as the browser copy holds it once the editors and the store are flushed (plain document: rows are JSON text). */
async function savedNote(page: Page): Promise<string> {
  await flushLiveCopy(page)
  return page.evaluate(async (path) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('team-tracker-live')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('open failed'))
    })
    const rows: unknown[] = await new Promise((resolve, reject) => {
      const r = db.transaction('records', 'readonly').objectStore('records').getAll()
      r.onsuccess = () => resolve(r.result as unknown[])
      r.onerror = () => reject(r.error ?? new Error('read failed'))
    })
    db.close()
    const seen: string[] = []
    // live-db.ts: { docId, key, value }, where a plain document's value is { t: JSON text of { path, value } }.
    for (const row of rows) {
      const text = ((row as { value?: { t?: unknown } }).value)?.t
      if (typeof text !== 'string') { seen.push(JSON.stringify(row).slice(0, 80)); continue }
      const rec = JSON.parse(text) as { path: string; value: unknown }
      if (rec.path === path) return String(rec.value)
      seen.push(rec.path)
    }
    throw new Error(`no saved record ${path}; found: ${seen.join(', ')}`)
  }, `team/${TEAM}/daily/${TODAY}`)
}

test.describe('editor scenarios (real browser, saved markdown)', () => {
  for (const row of ROWS) {
    test(row.name, async ({ page }) => {
      await openDoc(page, noteDoc(row.start))
      await expect(page.locator('.editor').first()).toBeVisible()
      await placeCaret(page)
      for (const step of row.steps) {
        if (typeof step === 'string') await page.keyboard.type(step)
        else if ('press' in step) await page.keyboard.press(step.press)
        else if ('wait' in step) await expect(page.locator(step.wait)).toBeVisible()
        else await dispatchPaste(page, step.paste)
      }
      expect(await savedNote(page)).toBe(row.saved)
    })
  }
})
