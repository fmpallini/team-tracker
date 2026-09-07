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
//     pasted content survives Ctrl+S → close → reopen  (currently test.fixme —
//     see the bug note on that test)
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
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

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
  await teamDialog.getByRole('button', { name: 'OK' }).click()
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

    await page.keyboard.press('Control+s')
    await expect(page.locator('.tt-save-pill[data-state="saved"]')).toBeVisible()
    await page.click('.tt-btn-close-file')
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
