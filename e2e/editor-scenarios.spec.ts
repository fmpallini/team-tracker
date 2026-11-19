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
// Every row also REOPENS what was saved, in a fresh page, and compares what the
// user sees before and after: each line's text, and each visible character's
// block (heading, list depth and task state, quote, code) and inline format
// (bold, italic, underline, strike, link, inline code, monospace or a font size
// of its own). The editor rewrites the whole note on every edit, so a shape the
// markdown can't hold silently changes the note the next time it is opened —
// that check catches it even in rows whose `saved` text looks right.
//
// Step strings are typed; press()/paste()/pasteHtml()/waitFor() build the others.
import { test, expect, type Page, type Browser } from '@playwright/test'
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
  /** The note's saved markdown afterwards. Omitted: the row only checks that the note reopens looking the same. */
  saved?: string
}

const ROWS: Row[] = [
  // --- typing and autoformat --------------------------------------------------
  { name: '"- " starts a bulleted list, Enter continues it', start: '', steps: ['- one', press('Enter'), 'two'], saved: '- one\n- two' },
  // Bold autoformat parks the caret in an nbsp after the run; Enter before that nbsp carries it to a line that looks empty.
  { name: '"- " on a line holding only a leftover space starts a list', start: '', steps: ['a **b**', press('ArrowLeft'), press('Enter'), '- x'], saved: 'a **b**\n- x' },
  { name: '"1. " starts a numbered list', start: '', steps: ['1. a', press('Enter'), 'b'], saved: '1. a\n2. b' },
  { name: '"3. " starts a numbered list at 3', start: '', steps: ['3. third', press('Enter'), 'fourth'], saved: '3. third\n4. fourth' },
  { name: '"> " starts a quote', start: '', steps: ['> q'], saved: '> q' },
  // The editor parks the caret after the bold in a space of its own; the space typed next is that one, not a second.
  { name: '"**x**" becomes bold as the closing marker is typed, and the next space is not doubled', start: '', steps: ['a **b** c'], saved: 'a **b** c' },
  { name: 'two spaces typed after the bold stay two', start: '', steps: ['a **b**  c'], saved: 'a **b**  c' },
  { name: 'an @-mention picked from the list, then a space and a word: one space', start: '', steps: ['see @Ana', waitFor('.tt-atref-dropdown'), press('Enter'), ' x'], saved: 'see @[Ana](person:p1) x' },
  { name: '"# " on the line under text makes THAT line a heading', start: `above${CARET}`, steps: [press('Enter'), '# Title'], saved: 'above\n# Title' },
  { name: 'Ctrl+1 on a blank line under text makes that line a heading', start: `text${CARET}`, steps: [press('Enter'), press('Control+1'), 'H'], saved: 'text\n# H' },
  { name: 'Ctrl+B bolds the selected word', start: `a ${CARET}word${CARET} b`, steps: [press('Control+b')], saved: 'a **word** b' },

  // --- formatting that must reopen as it was made -----------------------------
  // Italic inside bold used to save as `***` runs the parser could not read: the note reopened with literal asterisks.
  { name: 'Ctrl+I on the last word of a bold phrase', start: `${CARET}one two${CARET} x`, steps: [press('Control+b'), press('ArrowRight'), press('Control+Shift+ArrowLeft'), press('Control+i')], saved: '**one *two*** x' },
  { name: 'Ctrl+I on the first word of a bold phrase', start: `${CARET}one two${CARET} x`, steps: [press('Control+b'), press('ArrowLeft'), press('Control+Shift+ArrowRight'), press('Control+i')], saved: '***one* two** x' },
  { name: 'Ctrl+B on the last word of an italic phrase', start: `${CARET}one two${CARET} x`, steps: [press('Control+i'), press('ArrowRight'), press('Control+Shift+ArrowLeft'), press('Control+b')], saved: '*one **two*** x' },
  { name: 'bold, italic, underline and strike on overlapping words', start: `${CARET}a b c${CARET} d`, steps: [press('Control+b'), press('Home'), press('Control+Shift+ArrowRight'), press('Control+i'), press('End'), press('Control+Shift+ArrowLeft'), press('Control+u'), press('Control+Shift+ArrowLeft'), press('Control+Shift+x')] },
  { name: 'italic inside a bold word', start: `re${CARET}use${CARET}d`, steps: [press('Control+i'), press('Control+a'), press('Control+b')], saved: '**re*use*d**' },
  { name: 'pasted bold with italic at its end', start: '', steps: [pasteHtml('<b>one <i>two</i></b> x', 'one two x')], saved: '**one *two*** x' },
  { name: 'brackets typed inside a link text', start: `[li${CARET}nk](https://e.com)`, steps: ['[1]'], saved: '[li\\[1\\]nk](https://e.com)' },
  { name: 'literal markdown characters typed as text', start: '', steps: ['a_b `x` 2 * 3 ~5 #1 [n] \\o/'] },

  // --- list structure ---------------------------------------------------------
  { name: 'Enter mid-item splits the item', start: `- ab${CARET}cd`, steps: [press('Enter')], saved: '- ab\n- cd' },
  { name: 'Enter on an empty item ends the list', start: `- a${CARET}`, steps: [press('Enter'), press('Enter'), 'p'], saved: '- a\np' },
  { name: 'Tab nests an item', start: `- a\n- b${CARET}`, steps: [press('Tab')], saved: '- a\n  - b' },
  { name: 'Shift+Tab lifts a nested item', start: `- a\n  - b${CARET}`, steps: [press('Shift+Tab')], saved: '- a\n- b' },
  { name: 'Enter on the empty last line of a quote leaves the quote', start: `> q${CARET}`, steps: [press('Enter'), press('Enter'), 'after'], saved: '> q\nafter' },
  // Items used to carry a fixed number each, which Enter copied (5, 5, 6) and a delete left gapped.
  { name: 'Enter in a list starting at 5 numbers the new item 6', start: `5. a${CARET}\n6. b`, steps: [press('Enter'), 'x'], saved: '5. a\n6. x\n7. b' },
  { name: 'deleting a numbered item renumbers the rest', start: `1. a\n2. b${CARET}\n3. c`, steps: [press('Shift+Home'), press('Backspace'), press('Backspace')], saved: '1. a\n2. c' },
  { name: 'Backspace at the start of a sub-item merges it into its parent', start: `- a\n  - b${CARET}\n- c`, steps: [press('Home'), press('Backspace')], saved: '- ab\n- c' },
  { name: 'select across two bullets and Delete', start: `- a${CARET}a\n- b${CARET}b\n- c`, steps: [press('Delete')], saved: '- ab\n- c' },
  { name: 'Backspace at the start of an open task under a done one', start: `- [x] done\n- [ ] ${CARET}open`, steps: [press('Home'), press('Backspace'), press('Backspace')], saved: '- [x] doneopen' },

  // --- Shift+Enter ------------------------------------------------------------
  // A soft break inside a list item or heading can't be saved (the rest fell out of the block on reopen), so there
  // Shift+Enter acts as Enter. In a quote, a code block or a plain line it stays a line break.
  { name: 'Shift+Enter in a bullet starts the next item', start: `- a${CARET}\n- c`, steps: [press('Shift+Enter'), 'b'], saved: '- a\n- b\n- c' },
  { name: 'Shift+Enter in a nested bullet starts the next sub-item', start: `- p\n  - a${CARET}\n- c`, steps: [press('Shift+Enter'), 'b'], saved: '- p\n  - a\n  - b\n- c' },
  { name: 'Shift+Enter in a task starts the next open task', start: `- [ ] a${CARET}`, steps: [press('Shift+Enter'), 'b'], saved: '- [ ] a\n- [ ] b' },
  { name: 'Shift+Enter in a numbered item starts the next number', start: `1. a${CARET}`, steps: [press('Shift+Enter'), 'b'], saved: '1. a\n2. b' },
  { name: 'Shift+Enter in a heading starts a plain line under it', start: `# a${CARET}`, steps: [press('Shift+Enter'), 'b'], saved: '# a\nb' },
  { name: 'Shift+Enter in a quote stays inside the quote', start: `> a${CARET}`, steps: [press('Shift+Enter'), 'b'], saved: '> a\n> b' },
  { name: 'Shift+Enter in a plain line is a line break', start: `a${CARET}`, steps: [press('Shift+Enter'), 'b'], saved: 'a\nb' },

  // --- joining blocks ---------------------------------------------------------
  // Chrome copies a merged block's computed style onto the text as <span style="font-size…; font-weight…">: a heading
  // joined into a line showed big and saved as bold, a code line kept its monospace until reopened.
  { name: 'Backspace at the start of a heading joins it into the line above as plain text', start: `above\n# ${CARET}Title`, steps: [press('Backspace')], saved: 'aboveTitle' },
  { name: 'Delete at the end of a line pulls the heading below in as plain text', start: `text${CARET}\n# Title`, steps: [press('Delete')], saved: 'textTitle' },
  { name: 'Backspace at the start of a line under a heading joins it into the heading', start: `## Sub\n${CARET}text`, steps: [press('Backspace')], saved: '## Subtext' },
  { name: 'Backspace at the start of a code block joins its first line into the line above', start: 'text\n```\n' + CARET + 'code\n```', steps: [press('Backspace')], saved: 'textcode' },
  { name: 'Backspace at the start of a quote joins it into the line above', start: `text\n> ${CARET}q`, steps: [press('Backspace')], saved: 'textq' },
  { name: 'Ctrl+B on a word in a heading changes nothing a save would lose', start: `# a ${CARET}word${CARET}`, steps: [press('Control+b')], saved: '# a word' },

  // --- paste ------------------------------------------------------------------
  { name: 'plain text pasted mid-item stays inside the item', start: `- ab${CARET}cd`, steps: [paste('XY')], saved: '- abXYcd' },
  { name: 'plain text pasted mid-paragraph', start: `ab${CARET}cd`, steps: [paste('XY')], saved: 'abXYcd' },
  { name: 'an HTML list pasted into an empty note becomes a real list', start: '', steps: [pasteHtml('<ul><li>one</li><li>two</li></ul>', 'one\ntwo')], saved: '- one\n- two' },
  { name: 'blocks inside one pasted list item save as sibling items', start: '', steps: [pasteHtml('<ul><li><p>a</p><p>b</p></li></ul>', 'a\nb')], saved: '- a\n- b' },
  { name: 'styled HTML pasted into a heading keeps a plain heading', start: `# He${CARET}ad`, steps: [pasteHtml('<span style="color:red;font-size:30px">X</span>', 'X')], saved: '# HeXad' },
  { name: 'HTML pasted inside a code block lands as its literal text', start: `\`\`\`\ncode${CARET}\n\`\`\``, steps: [pasteHtml('<b>bold</b>', 'bold')], saved: '```\ncodebold\n```' },
  { name: 'an HTML heading pasted mid-line splits the line around it', start: `ab${CARET}cd`, steps: [pasteHtml('<h1>H</h1>', 'H')], saved: 'ab\n# H\ncd' },

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
    // Each marker's offset once the markers before it in the same node are gone (two markers in one node used to
    // put the second point one character late).
    for (const node of nodes) {
      let k = 0
      for (let i = node.data.indexOf(mark); i !== -1; i = node.data.indexOf(mark, i + mark.length)) points.push([node, i - k++ * mark.length])
      if (k) node.data = node.data.split(mark).join('')
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
      // A marker that was a whole text node (after a link or a bold run) leaves it empty: put the point where that
      // node sits, right after its previous sibling, not at the start of the line.
      const at = (p: [Node, number]): [Node, number] => {
        if ((p[0] as Text).data !== '') return p
        const parent = p[0].parentNode!
        return [parent, Array.from(parent.childNodes).indexOf(p[0] as ChildNode)]
      }
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

/**
 * What the user sees in the note: its lines, and for every visible character its block and inline formatting as
 * the browser computes them (so a <span style="font-weight:600"> counts as bold, exactly as it looks). Whitespace
 * is compared as whitespace only: a run's edge space moves outside its markers on save without looking different.
 */
async function visibleNote(page: Page): Promise<{ lines: string; chars: string }> {
  return page.evaluate(() => {
    const ed = document.querySelector<HTMLElement>('.editor')!
    const base = parseFloat(getComputedStyle(ed).fontSize)
    const lines = ed.innerText.split(String.fromCharCode(0xa0)).join(' ').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '')
    const chars: string[] = []
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!
      if (el.closest('[contenteditable="false"]:not(a)')) continue
      const cs = getComputedStyle(el)
      const block = el.closest('h1,h2,h3,li,blockquote,pre')
      const f: string[] = []
      if (block?.tagName === 'LI') {
        let depth = 0
        for (let p = block.parentElement; p && p !== ed; p = p.parentElement) if (p.tagName === 'LI') depth++
        f.push(`${block.parentElement!.tagName}${depth}${block.getAttribute('data-task') ?? ''}`)
      } else if (block) f.push(block.tagName)
      const heading = !!block && /^H\d$/.test(block.tagName)
      if (!heading && Number(cs.fontWeight) >= 600) f.push('B')
      if (cs.fontStyle === 'italic') f.push('I')
      let deco = ''
      for (let p: HTMLElement | null = el; p && p !== ed; p = p.parentElement) deco += getComputedStyle(p).textDecorationLine
      if (/underline/.test(deco) && !el.closest('a')) f.push('U')
      if (/line-through/.test(deco)) f.push('S')
      if (el.closest('a')) f.push('A')
      if (!block || block.tagName !== 'PRE') {
        if (/mono/i.test(cs.fontFamily)) f.push('M')
        if (!heading && Math.abs(parseFloat(cs.fontSize) - base) > 0.5) f.push(`Z${cs.fontSize}`)
      }
      for (const c of (n.textContent ?? '').split(String.fromCharCode(0xa0)).join(' ')) {
        if (c.trim() === '') { if (chars[chars.length - 1] !== ' ') chars.push(' ') } else chars.push(`${c}:${f.join('+')}`)
      }
    }
    return { lines, chars: chars.join('|').replace(/^ \||\| $/g, '') }
  })
}

/** Opens `md` as a note in a fresh browser context and returns what it shows. */
async function reopened(browser: Browser, md: string): Promise<{ lines: string; chars: string }> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await openDoc(page, noteDoc(md))
    await expect(page.locator('.editor').first()).toBeVisible()
    return await visibleNote(page)
  } finally {
    await context.close()
  }
}

test.describe('editor scenarios (real browser, saved markdown)', () => {
  for (const row of ROWS) {
    test(row.name, async ({ page, browser }) => {
      await openDoc(page, noteDoc(row.start))
      await expect(page.locator('.editor').first()).toBeVisible()
      await placeCaret(page)
      for (const step of row.steps) {
        if (typeof step === 'string') await page.keyboard.type(step)
        else if ('press' in step) await page.keyboard.press(step.press)
        else if ('wait' in step) await expect(page.locator(step.wait)).toBeVisible()
        else await dispatchPaste(page, step.paste)
      }
      const seen = await visibleNote(page)
      const saved = await savedNote(page)
      if (row.saved !== undefined) expect(saved).toBe(row.saved)
      expect(await reopened(browser, saved), `reopening ${JSON.stringify(saved)}`).toEqual(seen)
    })
  }
})
