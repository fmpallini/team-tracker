// e2e/editor.spec.ts — the rich-text editor legs that only a real browser
// exercises. src/ui/editor.ts is heavily unit-tested in test/editor.test.ts,
// but jsdom stubs document.execCommand to a no-op, so every path that ends in
// execCommand('insertHTML' | 'insertText' | 'insertUnorderedList' | ...) is
// asserted there only as "the right string was handed to execCommand" — never
// as "the editor DOM actually changed, the debounced commit fired, and the
// value round-tripped through save/reopen". Native undo/redo has no jsdom
// coverage at all. This spec fills those:
//
//   - paste of clipboard HTML → real converted blocks in the editor, and the
//     pasted content survives close → reopen
//   - paste inside a fenced code block stays literal text (plain, not HTML)
//   - a hostile clipboard payload (<img onerror>, javascript: link) is
//     disarmed in the resulting DOM and loads nothing
//   - type-to-autoformat actually applied by the browser: "- " → <ul>,
//     "**x**" → <strong>, "# " → <h1>
//   - Ctrl+Z / Ctrl+Shift+Z drive native undo/redo on the contenteditable
//
// Served over http://localhost (secure context) so the OPFS picker shim and
// the real File System Access save path are available, same as fs-api.spec.ts.
import { test, expect, type Page, type Locator } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck, openModule } from './helpers'

const PASSWORD = 'e2e-editor-password'

/** Create an encrypted doc, add the first team, and return the (focused, empty) daily-notes editor. */
async function openEditor(page: Page): Promise<Locator> {
  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, PASSWORD)

  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'Save' }).click()
  await teamDialog.waitFor({ state: 'hidden' })

  const editor = page.locator('.editor').first()
  await editor.click()
  return editor
}

/** Reset the editor to a single empty block and drop the caret into it — so each autoformat gesture starts from a clean line. */
async function clearEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ed = document.querySelector('.editor') as HTMLElement
    ed.innerHTML = '<div><br></div>'
    ed.focus()
    const sel = getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    r.selectNodeContents(ed.firstElementChild!)
    r.collapse(true)
    sel.addRange(r)
  })
}

/**
 * Dispatch a real `paste` ClipboardEvent at the editor with a populated
 * DataTransfer — Playwright can't put arbitrary `text/html` on the OS
 * clipboard cross-platform, but the app's onPaste handler only ever reads
 * `e.clipboardData`, and the execCommand it then calls is the real browser
 * one. Caret is forced to the end of the editor's LAST block first (not the
 * editor root) so `preAtCaret()` / `selectionTouchesPre()` see a container
 * inside that block, and insertHTML has a real target range.
 */
async function pasteInto(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((data) => {
    const ed = document.querySelector('.editor') as HTMLElement
    ed.focus()
    const target = ed.lastElementChild ?? ed
    const sel = getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    r.selectNodeContents(target)
    r.collapse(false)
    sel.addRange(r)

    const dt = new DataTransfer()
    for (const [type, value] of Object.entries(data)) dt.setData(type, value)
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, data)
  // let the 300ms debounced commit (scheduleChange) settle
  await page.waitForTimeout(400)
}

test.describe('rich-text editor — real-browser paste, autoformat, undo', () => {
  // Regression: pasting multi-block clipboard HTML into an empty line used to
  // nest the whole run inside a single wrapper <div> sibling —
  //   <div><h1>Heading</h1><ul>…</ul><div>tail</div></div>
  // — because execCommand('insertHTML') nests a multi-block fragment in the
  // caret's (empty) block. On the next markdown round-trip (save→reopen, or
  // any pane/module switch) htmlToMd() read that outer <div> as ONE block and
  // collapsed it to run-on text ("Headingonetwotail"), losing every heading,
  // list and word boundary. onPaste() now calls flattenTopLevelBlockWrappers()
  // right after the insert to restore the flat-block-children shape.
  test('pasted clipboard HTML becomes real blocks and survives save → close → reopen', async ({ page }) => {
    const editor = await openEditor(page)
    await page.keyboard.type('intro')
    await page.keyboard.press('Enter')

    await pasteInto(page, {
      'text/html': '<h1>Heading</h1><ul><li>one</li><li>two</li></ul><p>tail</p>',
      'text/plain': 'Heading one two tail',
    })

    await expect(editor.locator('> h1')).toHaveText('Heading')
    await expect(editor.locator('> ul > li')).toHaveCount(2)
    await expect(editor.getByText('tail')).toBeVisible()

    await page.click('.tt-btn-close-file') // Lock/Close writes the file
    await expect(page.locator('.tt-start-screen')).toBeVisible()

    await page.getByRole('button', { name: /Reopen last/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[name="tt-password"]').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tt-shell')).toBeVisible()

    const reopened = page.locator('.editor').first()
    await expect(reopened.locator('> h1')).toHaveText('Heading')
    await expect(reopened.locator('> ul > li')).toHaveCount(2)
    await expect(reopened.getByText('tail')).toBeVisible()
  })

  test('a real Google Docs paste keeps its heading, nested list and per-item formatting', async ({ page }) => {
    const editor = await openEditor(page)

    // The exact text/html Google Docs puts on the clipboard: whole fragment
    // wrapped in <b id="docs-internal-guid">, a trailing <br>, headings as
    // real <h1>, bold/italic/underline as inline style=, a sub-<ul> that is a
    // direct child of the outer <ul>.
    const gdocHtml =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-x">' +
      '<h1 dir="ltr"><span style="font-size:20pt;font-weight:400;">Vamos la</span></h1>' +
      '<ul style="padding-inline-start:48px;">' +
      '<li dir="ltr" style="font-weight:400;"><p role="presentation"><span style="font-weight:400;">Aqui tenho uma lista</span></p></li>' +
      '<ul style="padding-inline-start:48px;">' +
      '<li dir="ltr" style="font-weight:700;font-style:italic;"><p role="presentation"><span style="font-weight:700;font-style:italic;text-decoration:underline;">Com bullets</span></p></li>' +
      '<li dir="ltr" style="font-weight:400;"><p role="presentation"><a href="http://www.g1.com.br"><span style="text-decoration:underline;">G1</span></a></p></li>' +
      '</ul>' +
      '<li dir="ltr" style="font-weight:400;"><p role="presentation"><span>Teste</span></p></li>' +
      '</ul><br /></b>'

    await pasteInto(page, { 'text/html': gdocHtml, 'text/plain': 'Vamos la Aqui tenho uma lista Com bullets G1 Teste' })

    await expect(editor.locator('> h1')).toHaveText('Vamos la') // heading, as its own block
    await expect(editor.locator('> ul')).toHaveCount(1)
    await expect(editor.locator('> ul > li')).toHaveCount(2) // "Aqui tenho uma lista", "Teste"
    await expect(editor.locator('ul ul li')).toHaveCount(2) // nested bullets
    await expect(editor.getByText('Com bullets')).toBeVisible()
    await expect(editor.locator('a[href="http://www.g1.com.br"]')).toHaveText('G1')
    await expect(editor.locator('ul ul li').first().locator('strong, b')).toHaveCount(1) // per-item bold survived
    await expect(editor.locator('ul ul li').first().locator('em, i')).toHaveCount(1) // and italic
  })

  test('paste inside a fenced code block inserts literal text, not converted HTML', async ({ page }) => {
    const editor = await openEditor(page)

    // "```" alone on a line + Enter opens a fenced code block (editor.ts onKeydown).
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await expect(editor.locator('pre')).toHaveCount(1)

    await pasteInto(page, {
      'text/html': '<strong>bold</strong> and <em>italic</em>',
      'text/plain': '**bold** and *italic*',
    })

    // selectionTouchesPre() forces the plain-text branch: the markdown
    // punctuation is kept verbatim and no <strong>/<em> is spliced in.
    const pre = editor.locator('pre')
    await expect(pre).toContainText('**bold** and *italic*')
    await expect(pre.locator('strong')).toHaveCount(0)
    await expect(pre.locator('em')).toHaveCount(0)
  })

  // Chromium's insertText of many lines is quadratic (4–9 s for a 1,500-line log
  // paste); onPaste inserts the lines as one insertHTML instead. Also pins that
  // the literal text ("*", "_") is still literal after the note is reloaded.
  test('a 1,500-line plain-text paste lands in under 1.5 s and keeps every line literal', async ({ page }) => {
    const editor = await openEditor(page)
    await clearEditor(page)
    const text = Array.from({ length: 1500 }, (_, i) => `2026-10-17 12:00:${String(i % 60).padStart(2, '0')} INFO request ${i} path=/api/v1/items_${i}*`).join('\n')

    const ms = await page.evaluate((text) => {
      const ed = document.querySelector('.editor') as HTMLElement
      ed.focus()
      const sel = getSelection()!
      sel.removeAllRanges()
      const r = document.createRange()
      r.selectNodeContents(ed.lastElementChild ?? ed)
      r.collapse(false)
      sel.addRange(r)
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      const t0 = performance.now()
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return performance.now() - t0
    }, text)
    expect(ms).toBeLessThan(1500)
    await page.waitForTimeout(400)
    await expect(editor.locator('> div')).toHaveCount(1500)

    // Away to another module and back: the note is rebuilt from what was saved.
    const pane = page.locator('.tt-pane[data-pane-idx="0"]')
    for (const label of [/Members/i, /Daily/i]) {
      await openModule(pane, label)
    }
    const reopened = page.locator('.editor').first()
    await expect(reopened.locator('> div')).toHaveCount(1500)
    await expect(reopened.locator('> div').last()).toHaveText('2026-10-17 12:00:59 INFO request 1499 path=/api/v1/items_1499*')
  })

  // Chromium's insertHTML into a heading or quote copies the surrounding
  // block's computed font/colour onto the inserted spans as inline style="…",
  // so the pasted text looks different from the rest until it is reopened.
  test('paste into a heading leaves no inline style on the inserted text', async ({ page }) => {
    const editor = await openEditor(page)
    await page.evaluate(() => {
      const ed = document.querySelector('.editor') as HTMLElement
      ed.innerHTML = '<h2>Head text</h2>'
      ed.focus()
      const text = ed.querySelector('h2')!.firstChild!
      const r = document.createRange()
      r.setStart(text, 4)
      r.collapse(true)
      const sel = getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
      const dt = new DataTransfer()
      dt.setData('text/html', '<p>Texto <b>negrito</b> e <i>itálico</i></p>')
      dt.setData('text/plain', 'Texto negrito e itálico')
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(400)
    await expect(editor).toContainText('Texto negrito e itálico')
    await expect(editor.locator('[style]')).toHaveCount(0)
  })

  test('a hostile clipboard payload is disarmed and loads no resources', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (r) => requests.push(r.url()))
    const editor = await openEditor(page)

    await pasteInto(page, {
      'text/html':
        '<p><img src="https://evil.example.test/x.png" onerror="window.__pwned=1">' +
        '<a href="javascript:window.__pwned=1">click</a></p>',
      'text/plain': 'click',
    })

    // No handler ran, no <img> survived into the editor, and the
    // javascript: URL did not become a live href.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    await expect(editor.locator('img')).toHaveCount(0)
    const hrefs = await editor.locator('a').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')))
    for (const h of hrefs) expect(h?.startsWith('javascript:')).toBeFalsy()
    expect(requests.some((u) => u.includes('evil.example.test'))).toBe(false)
  })

  test('type-to-autoformat is applied by the browser: "- " → list, "**x**" → bold, "# " → heading', async ({ page }) => {
    const editor = await openEditor(page)

    await clearEditor(page)
    await page.keyboard.type('- first item')
    await expect(editor.locator('ul > li')).toHaveText('first item')

    await clearEditor(page)
    await page.keyboard.type('**bold**')
    await expect(editor.locator('strong')).toHaveText('bold')
    await expect(editor).not.toContainText('**')

    await clearEditor(page)
    await page.keyboard.type('# Title')
    await expect(editor.locator('h1')).toHaveText('Title')
  })

  test('Ctrl+Z / Ctrl+Shift+Z drive native undo and redo', async ({ page }) => {
    const editor = await openEditor(page)

    await page.keyboard.type('alpha beta gamma')
    await page.waitForTimeout(350)
    const full = (await editor.innerText()).trim()
    expect(full).toBe('alpha beta gamma')

    await page.keyboard.press('Control+z')
    await page.waitForTimeout(100)
    const undone = (await editor.innerText()).trim()
    expect(undone.length).toBeLessThan(full.length) // last typed chunk removed

    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(100)
    const redone = (await editor.innerText()).trim()
    expect(redone.length).toBeGreaterThan(undone.length) // chunk restored
  })
})

test.describe('rich-text editor — Ctrl+Z after paste', () => {
  const cases: Record<string, Record<string, string>> = {
    'html bullet list': { 'text/html': '<ul><li>one</li><li>two</li><li>three</li></ul>', 'text/plain': '- one\n- two\n- three' },
    'html bullet list + heading': { 'text/html': '<h2>Head</h2><ul><li>one</li><li>two</li></ul><p>tail</p>', 'text/plain': 'Head\n- one\n- two\ntail' },
    'plain bullet lines': { 'text/plain': '- one\n- two\n- three' },
    'plain dot bullets': { 'text/plain': '• one\n• two\n• three' },
  }
  // Chromium nests a multi-block paste inside the empty line it lands on; the editor hoists it out
  // again, an edit the native undo stack never saw. Ctrl+Z must still take the paste back, and
  // Ctrl+Shift+Z bring it back, whether the empty line is the only one or follows other text.
  for (const [name, data] of Object.entries(cases)) {
    for (const lead of [false, true]) {
      test(`Ctrl+Z / Ctrl+Shift+Z undo and redo a pasted ${name}${lead ? ' after typed text' : ' into an empty note'}`, async ({ page }) => {
        const editor = await openEditor(page)
        if (lead) {
          await page.keyboard.type('before')
          await page.keyboard.press('Enter')
          await page.waitForTimeout(350)
        }
        const baseline = (await editor.innerText()).trim()
        await pasteInto(page, data)
        const pasted = (await editor.innerText()).trim()
        expect(pasted).not.toBe(baseline)
        await page.keyboard.press('Control+z')
        await page.waitForTimeout(150)
        expect((await editor.innerText()).trim()).toBe(baseline)
        await page.keyboard.press('Control+Shift+z')
        await page.waitForTimeout(150)
        expect((await editor.innerText()).trim()).toBe(pasted)
        // still flat afterwards, so the markdown reads back as blocks
        expect(await editor.evaluate((ed) => Array.from(ed.children).some((c) => c.tagName === 'DIV' && c.firstElementChild !== null && /^(H[1-6]|UL|OL)$/.test(c.firstElementChild.tagName)))).toBe(false)
      })
    }
  }
})

// The editor makes some edits by moving nodes itself (autoformat, Tab indent, leaving a quote); the
// browser's undo stack never sees those. Each must come back with ONE Ctrl+Z, and return on Ctrl+Shift+Z.
test.describe('rich-text editor — Ctrl+Z after hand-made edits', () => {
  const k = (page: Page) => page.keyboard
  const html = (editor: Locator) => editor.evaluate((e) => e.innerHTML)
  async function fresh(page: Page): Promise<Locator> {
    const editor = await openEditor(page)
    await clearEditor(page)
    return editor
  }

  const autoformats: Array<{ name: string; type: string[]; has: string; text: string }> = [
    { name: '"- " list', type: ['hello', 'Enter', '- '], has: 'ul', text: 'hello\n- ' },
    { name: '"1. " list', type: ['hello', 'Enter', '1. '], has: 'ol', text: 'hello\n1. ' },
    { name: '"# " heading', type: ['hello', 'Enter', '# '], has: 'h1', text: 'hello\n# ' },
    { name: '"> " quote', type: ['hello', 'Enter', '> '], has: 'blockquote', text: 'hello\n> ' },
    { name: '"---" rule', type: ['hello', 'Enter', '---', 'Enter'], has: 'hr', text: 'hello\n---' },
    { name: '"```" code block', type: ['hello', 'Enter', '```', 'Enter'], has: 'pre', text: 'hello\n```' },
    { name: '"**bold**" run', type: ['hello **bold**'], has: 'strong', text: 'hello **bold**' },
  ]
  for (const a of autoformats) {
    test(`${a.name}: Ctrl+Z gives back what was typed, Ctrl+Shift+Z converts again`, async ({ page }) => {
      const editor = await fresh(page)
      for (const part of a.type) {
        if (part === 'Enter') await k(page).press('Enter')
        else await k(page).type(part)
      }
      await expect(editor.locator(a.has)).toHaveCount(1)
      await k(page).press('Control+z')
      await expect(editor.locator(a.has)).toHaveCount(0)
      expect((await editor.innerText()).replace(/ /g, ' ').replace(/\s+$/, '')).toBe(a.text.replace(/\s+$/, ''))
      await k(page).press('Control+Shift+z')
      await expect(editor.locator(a.has)).toHaveCount(1)
    })
  }

  test('typing "# " under a line makes a heading of the NEW line, not of the one above', async ({ page }) => {
    const editor = await fresh(page)
    await k(page).type('hello')
    await k(page).press('Enter')
    await k(page).type('# Title')
    await expect(editor.locator('h1')).toHaveText('Title')
    await expect(editor.locator('div').first()).toHaveText('hello')
    expect(await html(editor)).not.toContain('helloTitle')
  })

  test('Ctrl+1 on a blank line under text makes a heading of that line', async ({ page }) => {
    const editor = await fresh(page)
    await k(page).type('hello')
    await k(page).press('Enter')
    await k(page).press('Control+1')
    await k(page).type('Title')
    await expect(editor.locator('h1')).toHaveText('Title')
    await expect(editor.locator('div').first()).toHaveText('hello')
  })

  test('Tab / Shift+Tab on a list item: Ctrl+Z puts the item back, Ctrl+Shift+Z indents it again', async ({ page }) => {
    const editor = await fresh(page)
    await k(page).type('- a')
    await k(page).press('Enter')
    await k(page).type('b')
    await page.waitForTimeout(350)
    await k(page).press('Tab')
    await expect(editor.locator('ul ul')).toHaveCount(1)
    await k(page).press('Control+z')
    await expect(editor.locator('ul ul')).toHaveCount(0)
    await expect(editor.locator('li')).toHaveCount(2)
    await k(page).press('Control+Shift+z')
    await expect(editor.locator('ul ul')).toHaveCount(1)
    await k(page).press('Shift+Tab')
    await expect(editor.locator('ul ul')).toHaveCount(0)
    await k(page).press('Control+z')
    await expect(editor.locator('ul ul')).toHaveCount(1)
  })

  test('Enter on the empty last line of a quote leaves it; Ctrl+Z puts the empty line back inside', async ({ page }) => {
    const editor = await fresh(page)
    await k(page).type('> q')
    await k(page).press('Enter')
    await page.waitForTimeout(350)
    await k(page).press('Enter')
    await expect(editor.locator('blockquote + div')).toHaveCount(1)
    await k(page).press('Control+z')
    await expect(editor.locator('blockquote + div')).toHaveCount(0)
    await expect(editor.locator('blockquote')).toHaveCount(1)
  })

  test('Ctrl+X: Ctrl+Z brings the cut text back', async ({ page }) => {
    const editor = await fresh(page)
    await k(page).type('one')
    await k(page).press('Enter')
    await k(page).type('two')
    await page.waitForTimeout(350)
    await k(page).press('Control+a')
    await k(page).press('Control+x')
    await expect(editor).toHaveText('')
    await k(page).press('Control+z')
    await expect(editor).toContainText('one')
    await expect(editor).toContainText('two')
  })

  test('a mixed chain walks back one step at a time: typing, Tab, typing', async ({ page }) => {
    const editor = await fresh(page)
    await k(page).type('- one')
    await k(page).press('Enter')
    await k(page).type('two')
    await page.waitForTimeout(350)
    await k(page).press('Tab')
    await k(page).type(' more')
    await page.waitForTimeout(350)
    await expect(editor.locator('ul ul li')).toHaveText('two more')
    await k(page).press('Control+z')
    await expect(editor.locator('ul ul li')).toHaveText('two')
    await k(page).press('Control+z')
    await expect(editor.locator('ul ul')).toHaveCount(0)
    await expect(editor.locator('li').nth(1)).toHaveText('two')
    await k(page).press('Control+Shift+z')
    await k(page).press('Control+Shift+z')
    await expect(editor.locator('ul ul li')).toHaveText('two more')
  })
})

test.describe('rich-text editor — Ctrl+C / Ctrl+X carry no theme background', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('Ctrl+C out of the editor writes formatted HTML with no background-color', async ({ page }) => {
    const editor = await openEditor(page)
    await editor.click()
    await page.keyboard.type('# Heading')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('a line with ')
    await page.keyboard.press('Control+b')
    await page.keyboard.type('bold')
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(350)

    // Select everything in the editor and copy with the keyboard.
    await page.evaluate(() => {
      const ed = document.querySelector('.editor') as HTMLElement
      ed.focus()
      const r = document.createRange()
      r.selectNodeContents(ed)
      const sel = getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
    })
    await page.keyboard.press('Control+c')

    const html = await page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      for (const it of items) {
        if (it.types.includes('text/html')) return (await (await it.getType('text/html')).text())
      }
      return null
    })

    expect(html).toBeTruthy()
    expect(html!).toContain('<h1>')
    expect(html!.toLowerCase()).toContain('bold')
    // the actual bug: native copy inlined <body>'s themed background onto the fragment
    expect(html!.toLowerCase()).not.toMatch(/background(-color)?\s*:/)
  })
})
