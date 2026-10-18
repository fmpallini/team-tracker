// e2e/paste-sources.spec.ts — the editor against clipboard HTML/text as real
// sources put it there, at every kind of caret position, in a real Chromium.
//
// jsdom stubs document.execCommand, so the unit tests only see "the right string
// went to insertHTML". What a person gets also depends on what Chromium does
// with it (nesting a multi-block fragment in the caret's block, copying inline
// styles onto spans, dropping text into a heading) and on what comes back after
// the note is saved and reopened. This pastes a corpus (Word, Excel, Outlook,
// Wikipedia, VS Code, GitHub, Slack, Notion, Google Sheets, ChatGPT, odd
// shapes, hostile payloads, plain text) into five positions and checks, for
// each: only the editor's own block/inline tags, no style/on* attributes, only
// safe links, no clipboard junk (CF_HTML markers, mso-* styles, conditional
// comments), nothing loaded or executed — and that the text is identical after
// switching to another module and back (i.e. what is shown is what is saved).
import { test, expect, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../playwright.config'
import { installOpfsPickerShim } from './opfs-shim'
import { createEncryptedDoc, blockUpdateCheck } from './helpers'

const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const TAB = String.fromCharCode(9)

const WORD =
  '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style><!-- p.MsoNormal {margin:0cm; font-size:11.0pt;} @list l0:level1 {mso-level-number-format:bullet;} --></style></head>' +
  '<body lang="PT-BR"><!--StartFragment--><p class="MsoNormal">Texto <b>negrito</b> e <i>itálico</i><o:p></o:p></p>' +
  '<p class="MsoListParagraphCxSpFirst" style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><!--[if !supportLists]--><span style="font-family:Symbol"><span style="mso-list:Ignore">·<span style="font:7.0pt \'Times New Roman\'">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><!--[endif]-->Item um<o:p></o:p></p>' +
  '<p class="MsoListParagraphCxSpLast" style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><!--[if !supportLists]--><span style="font-family:Symbol"><span style="mso-list:Ignore">·<span style="font:7.0pt \'Times New Roman\'">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><!--[endif]-->Item dois<o:p></o:p></p>' +
  '<p class="MsoNormal"><span style="mso-tab-count:1">' + TAB + '</span>Tabbed<o:p>&nbsp;</o:p></p><!--EndFragment--></body></html>'

const CORPUS: Record<string, Record<string, string>> = {
  word: { 'text/html': WORD, 'text/plain': 'Texto negrito e itálico' + CR + NL + '·Item um' + CR + NL + '·Item dois' },
  excel: {
    'text/html': '<html><head><style>td{mso-number-format:General}</style></head><body><!--StartFragment--><table border=0><col width=64><tr><td>Nome</td><td>Qtd</td></tr><tr><td>Ana</td><td align=right>3</td></tr><!--EndFragment--></table></body></html>',
    'text/plain': 'Nome' + TAB + 'Qtd' + CR + NL + 'Ana' + TAB + '3' + CR + NL,
  },
  outlook: {
    'text/html': '<html><head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]--></head><body><div class="WordSection1"><p class="MsoNormal">Oi time,<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p class="MsoNormal"><b>From:</b> Ana &lt;ana@x.com&gt;<br><b>Sent:</b> Monday</p></div><blockquote style="margin-left:30pt"><p class="MsoNormal">mensagem original</p></blockquote></div></body></html>',
    'text/plain': 'Oi time,',
  },
  wikipedia: {
    'text/html': '<div><h2><span class="mw-headline" id="History">History</span><span class="mw-editsection"><span>[</span><a href="/w/index.php?edit">edit</a><span>]</span></span></h2><p>Some <b>text</b> with a ref<sup class="reference"><a href="#cite_note-1">[1]</a></sup> and <a href="/wiki/Other">relative link</a> and <a href="https://en.wikipedia.org/wiki/X">absolute</a>.</p><figure><img src="https://upload.wikimedia.org/x.png"><figcaption>Caption</figcaption></figure><style>.x{color:red}</style><script>window.__pwned=1</script><h4>Sub sub</h4><p>end</p></div>',
    'text/plain': 'History',
  },
  vscode: {
    'text/html': '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas;white-space: pre;"><div><span style="color: #569cd6;">const</span> total = a * b * c</div><div>  <span style="color: #c586c0;">return</span> my_var_name</div><div><br></div><div>}</div></div>',
    'text/plain': 'const total = a * b * c' + NL + '  return my_var_name' + NL + NL + '}',
  },
  github: {
    'text/html': '<h2 dir="auto">Title</h2><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked> done task</li><li class="task-list-item"><input type="checkbox" disabled> open task</li></ul><div class="highlight highlight-source-js"><pre><span class="pl-k">const</span> a <span class="pl-c1">=</span> 1;' + NL + '<span class="pl-k">const</span> b = 2;</pre></div><p>Use <code>npm test</code> here.</p>',
    'text/plain': 'Title',
  },
  slack: {
    'text/html': '<meta charset="utf-8"><span>hello <b>world</b></span><br><span>line two</span><br><span>&gt; not a quote</span><br><ul><li>x</li></ul>',
    'text/plain': 'hello world' + NL + 'line two',
  },
  notion: {
    'text/html': '<meta charset="utf-8"><h1>Notion page</h1><p>para one</p><ul><li>bullet<ul><li>nested</li></ul></li></ul><details><summary>toggle</summary>hidden body</details><p><mark>marked</mark> <s>struck</s> <u>under</u> <sub>sub</sub><sup>sup</sup> <kbd>Ctrl</kbd></p>',
    'text/plain': 'Notion page',
  },
  gsheets: {
    'text/html': '<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/></colgroup><tbody><tr style="height:21px;"><td>Name</td><td>Qty</td></tr><tr><td>Ana | B</td><td style="text-align:right;">3</td></tr></tbody></table>',
    'text/plain': 'Name' + TAB + 'Qty',
  },
  chatgpt: {
    'text/html': '<h3>Steps</h3><ol><li><p><strong>Install</strong>: run <code>npm i</code></p></li><li><p>Then</p><p>second para in item</p></li></ol><pre><div class="code-header"><span>bash</span><button>Copy code</button></div><div><code class="language-bash">npm test' + NL + 'npm run build' + NL + '</code></div></pre><p>2*3*4 = 24 and a_b_c</p>',
    'text/plain': 'Steps',
  },
  htmlEdge: {
    'text/html': '<h1>Head<br>broken</h1><h5>five</h5><blockquote><blockquote>deep quote</blockquote></blockquote><hr><ol start="5"><li>five</li><li>six</li></ol><p>a&nbsp;&nbsp;b</p><p dir="rtl">שלום עולם</p><p>' + String.fromCharCode(0x200b) + '```js</p>',
    'text/plain': 'Head',
  },
  imageOnly: { 'text/html': '<meta charset="utf-8"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">', 'text/plain': '' },
  deepNest: { 'text/html': '<div>'.repeat(400) + 'deep text' + '</div>'.repeat(400), 'text/plain': 'deep text' },
  hostile: {
    'text/html': '<svg onload="window.__pwned=2"><circle/></svg><iframe src="https://evil.example.test/f"></iframe><a href=" javascript:window.__pwned=3">js</a><a href="data:text/html,<script>1</script>">data</a><style>@import url(https://evil.example.test/a.css);</style><link rel="stylesheet" href="https://evil.example.test/b.css"><meta http-equiv="refresh" content="0;url=https://evil.example.test"><base href="https://evil.example.test/"><form action="https://evil.example.test"><input value="in"></form><object data="https://evil.example.test/o"></object><a data-ref="person:x&quot; onmouseover=&quot;window.__pwned=4" href="#">chip</a><img src=x onerror="window.__pwned=5"><p style="background:url(https://evil.example.test/bg.png)">styled</p>',
    'text/plain': 'js data chip styled',
  },
  plainCrlf: { 'text/plain': 'line1' + CR + NL + 'line2' + CR + NL + CR + NL + 'line4' },
  plainMarkdown: { 'text/plain': '# Title' + NL + '- a' + NL + '- b' + NL + '**bold** and 2*3*4' + NL + '```js' + NL + 'code' + NL + '```' },
  plainTsv: { 'text/plain': 'Nome' + TAB + 'Qtd' + NL + 'Ana' + TAB + '3' },
  plainUnicode: { 'text/plain': 'nbsp' + String.fromCharCode(0xa0) + 'here zw' + String.fromCharCode(0x200b) + 'sp rtl ' + String.fromCharCode(0x202e) + 'abc emoji ' + String.fromCharCode(0xd83d, 0xdc68, 0x200d, 0xd83d, 0xdc69) + ' nfd ac' + String.fromCharCode(0x327) + 'a' + String.fromCharCode(0x303) + 'o' },
  plainBigLog: { 'text/plain': Array.from({ length: 1500 }, (_, i) => `2026-10-17 12:00:${String(i % 60).padStart(2, '0')} INFO request ${i} path=/api/v1/items_${i}*`).join(NL) },
  bigHtml: { 'text/html': Array.from({ length: 800 }, (_, i) => `<p>Paragraph ${i} with <b>bold</b> and <a href="https://x.y/${i}">link</a></p>`).join(''), 'text/plain': 'x' },
}

type Position = 'empty' | 'midline' | 'listItem' | 'heading' | 'quote'
const ALL_POSITIONS: Position[] = ['empty', 'midline', 'listItem', 'heading', 'quote']
// The two big payloads are about size, not caret position; listItem would take
// Chromium's slow native insertText path for the plain one.
const POSITIONS: Record<string, Position[]> = { plainBigLog: ['empty', 'midline'], bigHtml: ['empty', 'midline'] }

async function setup(page: Page, pos: Position): Promise<void> {
  await page.evaluate((pos) => {
    const ed = document.querySelector('.editor') as HTMLElement
    const html: Record<string, string> = {
      empty: '<div><br></div>',
      midline: '<div>before after</div>',
      listItem: '<ul><li>item text</li></ul>',
      heading: '<h2>Head text</h2>',
      quote: '<blockquote>quoted text</blockquote>',
    }
    ed.innerHTML = html[pos]!
    ed.focus()
    const target = ed.querySelector('li, h2, blockquote, div') as HTMLElement
    const sel = getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    const text = target.firstChild
    if (text && text.nodeType === 3) { r.setStart(text, Math.min(6, (text as Text).length)); r.collapse(true) } else { r.selectNodeContents(target); r.collapse(true) }
    sel.addRange(r)
  }, pos)
}

async function paste(page: Page, data: Record<string, string>): Promise<number> {
  const ms = await page.evaluate((data) => {
    const ed = document.querySelector('.editor') as HTMLElement
    const dt = new DataTransfer()
    for (const [type, value] of Object.entries(data)) dt.setData(type, value)
    const t0 = performance.now()
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return performance.now() - t0
  }, data)
  await page.waitForTimeout(400) // the 300 ms debounced commit
  return ms
}

interface Snapshot { text: string; liCount: number; emCount: number; issues: string[] }

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const ed = document.querySelector('.editor') as HTMLElement
    const issues: string[] = []
    const BLOCK = new Set(['DIV', 'H1', 'H2', 'H3', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'HR'])
    const ALLOWED = new Set([...BLOCK, 'LI', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE', 'A', 'SPAN'])
    for (const c of Array.from(ed.children)) if (!BLOCK.has(c.tagName)) issues.push('top-level ' + c.tagName)
    for (const c of Array.from(ed.children)) if (c.tagName === 'DIV' && c.querySelector('div,h1,h2,h3,ul,ol,pre,blockquote')) issues.push('block nested in a div')
    for (const e of Array.from(ed.querySelectorAll('*'))) {
      if (!ALLOWED.has(e.tagName)) issues.push('tag ' + e.tagName)
      for (const a of Array.from(e.attributes)) if (a.name === 'style' || /^on/i.test(a.name)) issues.push(`attribute ${e.tagName}@${a.name}`)
      const href = e.getAttribute('href')
      if (href && !/^(https?:|mailto:)/.test(href)) issues.push('href ' + href.slice(0, 40))
    }
    const text = ed.innerText
    for (const junk of ['StartFragment', 'EndFragment', 'mso-', '<!--', '[if', 'MsoNormal', 'xmlns']) if (text.includes(junk)) issues.push('junk ' + junk)
    if ((window as unknown as { __pwned?: number }).__pwned) issues.push('SCRIPT RAN')
    return { text, liCount: ed.querySelectorAll('li').length, emCount: ed.querySelectorAll('em, i').length, issues: [...new Set(issues)] }
  })
}

/** Away to another module and back: the editor is rebuilt from what was saved. */
async function reopen(page: Page): Promise<void> {
  const pane = page.locator('.tt-pane[data-pane-idx="0"]')
  for (const label of [/Members/i, /Daily/i]) {
    await pane.locator('.tt-pane-modules-btn').click()
    await pane.locator('.tt-pane-menu-item', { hasText: label }).first().click()
  }
  await page.locator('.editor').first().waitFor()
}

const norm = (s: string): string => s.split(String.fromCharCode(0xa0)).join(' ').replace(/\s+/g, ' ').trim()

// Pasted into the middle of a list item, a fragment that holds a list ends up with the
// item's own text first and its nested list after once saved (an item is its text plus
// its sub-lists), so there the order and line breaks can differ. Nothing may be lost or invented.
const sameText = (pos: Position, a: string, b: string): boolean => {
  const chars = (s: string): string => s.replace(/\s/g, '').split('').sort().join('')
  return pos === 'listItem' ? chars(a) === chars(b) : norm(a) === norm(b)
}

test('pasted content from common sources stays clean, safe and unchanged after a save/reopen', async ({ page }) => {
  test.setTimeout(600_000)
  const hostRequests: string[] = []
  page.on('request', (r) => { if (/evil\.example\.test|upload\.wikimedia\.org/.test(r.url())) hostRequests.push(r.url()) })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await installOpfsPickerShim(page)
  await blockUpdateCheck(page)
  await page.goto(`${E2E_BASE_URL}/app.html`)
  await createEncryptedDoc(page, 'e2e-paste-sources')
  await page.getByRole('button', { name: /Create first team/ }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.locator('input[name="tt-team-name"]').fill('T')
  await teamDialog.getByRole('button', { name: 'OK' }).click()
  await teamDialog.waitFor({ state: 'hidden' })
  await page.locator('.editor').first().click()

  const failures: string[] = []
  for (const [name, data] of Object.entries(CORPUS)) {
    for (const pos of POSITIONS[name] ?? ALL_POSITIONS) {
      const where = `${name} @ ${pos}`
      errors.length = 0
      await setup(page, pos)
      const ms = await paste(page, data)
      const before = await snapshot(page)
      await reopen(page)
      const after = await snapshot(page)

      for (const issue of before.issues) failures.push(`${where}: ${issue} (after paste)`)
      for (const issue of after.issues) failures.push(`${where}: ${issue} (after reopen)`)
      if (!sameText(pos, before.text, after.text)) {
        failures.push(`${where}: text changed on reopen:\n    shown : ${JSON.stringify(before.text.slice(0, 160))}\n    saved : ${JSON.stringify(after.text.slice(0, 160))}`)
      }
      if (errors.length) failures.push(`${where}: page errors ${JSON.stringify(errors)}`)
      if (name === 'plainBigLog' && ms > 1500) failures.push(`${where}: paste took ${Math.round(ms)} ms`)

      // What each source must look like when pasted onto an empty line.
      if (pos === 'empty') {
        if (name === 'vscode' && before.text.split(NL).filter((l) => l.trim() !== '').length < 3) failures.push(`${where}: code collapsed to fewer than 3 lines`)
        if (name === 'gsheets' && !before.text.includes('Name | Qty')) failures.push(`${where}: table lost`)
        if (name === 'word' && before.liCount !== 2) failures.push(`${where}: expected 2 list items, got ${before.liCount}`)
      }
      if (name === 'plainMarkdown') {
        if (!after.text.includes('2*3*4')) failures.push(`${where}: 2*3*4 not literal after reopen`)
        if (after.emCount !== 0) failures.push(`${where}: literal asterisks turned into emphasis`)
      }
    }
  }

  expect(hostRequests, 'no request to a hostile or remote host').toEqual([])
  expect(failures, failures.join(NL)).toEqual([])
})
