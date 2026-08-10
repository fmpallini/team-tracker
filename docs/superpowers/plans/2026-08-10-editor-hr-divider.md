# Editor `---` Horizontal Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `---` (3+ dashes, alone on a line) followed by Space or Enter in any rich-text field inserts a visible horizontal divider, documented in the help modal.

**Architecture:** `src/core/markdown.ts` gains round-trip support for a bare `---` line ↔ `<hr>`. `src/ui/editor.ts` gains an `'hr'` case in the existing space-triggered autoformat path (`detectBlockPrefix`/`handleAutoFormat`), plus a new Enter-key interceptor (nothing currently handles Enter in `onKeydown`) — both funnel into one new `convertBlockToHr` helper, mirroring the existing `convertBlockToList`. `styles.css` themes the rule. Help modal + i18n document it.

**Tech Stack:** TypeScript, Vitest, jsdom (no `execCommand`/no real contenteditable — this feature is built with direct DOM manipulation like the existing list autoformat, so it's fully testable in jsdom).

## Global Constraints

- Zero runtime dependencies.
- Only the `---` spelling (not `***`/`___`).
- `---` inside a list item is left as literal text, not converted (same guard the existing `ul`/`ol` autoformat uses: `block.parentElement === editorEl`).
- No toolbar button or `/` picker entry — autoformat only, documented in help.
- Match spec at `docs/superpowers/specs/2026-08-10-editor-hr-divider-design.md`.

---

### Task 1: `mdToHtml`/`htmlToMd` round-trip for `<hr>`

**Files:**
- Modify: `src/core/markdown.ts`
- Test: `test/markdown.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `mdToHtml('---')` → HTML containing `<hr>`; `htmlToMd(root)` on a root containing an `<hr>` child → a `'---'` line. Task 2's editor code relies on this round-trip once it builds `<hr>` elements directly (it doesn't call `mdToHtml` itself, but `Editor.getMd()` does call `htmlToMd` on save).

- [ ] **Step 1: Write the failing tests**

Add to `test/markdown.test.ts`:

```ts
test('bare "---" line becomes <hr> and round-trips', () => {
  const md = 'before\n\n---\n\nafter'
  const html = mdToHtml(md)
  expect(html).toContain('<hr>')
  expect(roundTrip(md)).toBe(md)
})

test('"---" round-trips standalone and closes any open list first', () => {
  const md = '- a\n- b\n---\ntext'
  const html = mdToHtml(md)
  expect(html).toBe('<ul><li>a</li><li>b</li></ul><hr><div>text</div>')
  expect(roundTrip(md)).toBe(md)
})

test('a line with only 1-2 dashes is not treated as a rule', () => {
  const md = '--\nnot a rule'
  expect(mdToHtml(md)).not.toContain('<hr>')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/markdown.test.ts`
Expected: FAIL — first two tests, `<hr>` missing (falls through to `<div>---</div>` today); round-trip of the `<hr>` element back to markdown produces `''` for that line since `htmlToMd`'s default branch calls `inlineMd(node)` which returns `''` for a childless `<hr>`.

- [ ] **Step 3: Implement `mdToHtml`'s hr branch**

In `src/core/markdown.ts`, in the `mdToHtml` per-line loop (lines 84-93), add a `hr` check and branch:

```ts
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^( *)- (.*)$/.exec(line)
    const ol = /^( *)(\d+)\. (.*)$/.exec(line)
    const hr = /^-{3,}$/.test(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel, refTitle)}</h${h[1]!.length}>`) }
    else if (ul) addListItem(Math.floor(ul[1]!.length / 2), 'ul', blockInline(preserveIndent(ul[2]!), resolveLabel, refTitle), '')
    else if (ol) addListItem(Math.floor(ol[1]!.length / 2), 'ol', blockInline(preserveIndent(ol[3]!), resolveLabel, refTitle), ` value="${ol[2]}"`)
    else if (hr) { closeList(); out.push('<hr>') }
    else { closeList(); out.push(`<div>${line ? blockInline(preserveIndent(line), resolveLabel, refTitle) : '<br>'}</div>`) }
  }
```

- [ ] **Step 4: Implement `htmlToMd`'s hr branch**

In `src/core/markdown.ts`, in `htmlToMd`'s `walk` function (lines 292-306):

```ts
export function htmlToMd(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (!(node instanceof HTMLElement)) {
      const t = node.textContent?.trim(); if (t) out.push(t); return
    }
    const tag = node.tagName.toLowerCase()
    if (/^h[1-3]$/.test(tag)) out.push('#'.repeat(Number(tag[1])) + ' ' + blockToMd(node))
    else if (tag === 'ul' || tag === 'ol') renderListMd(node, 0, out)
    else if (tag === 'hr') out.push('---')
    else if (tag === 'div' || tag === 'p') out.push(blockToMd(node))
    else out.push(inlineMd(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/markdown.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "feat: round-trip a bare --- line as <hr> in markdown.ts"
```

---

### Task 2: `detectBlockPrefix` gains an `'hr'` type (space trigger)

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BlockPrefixMatch['type']` now includes `'hr'`; `detectBlockPrefix(text: string): BlockPrefixMatch | null` returns `{ type: 'hr', prefixLen: number }` for `/^-{3,}[  ]$/` (space or the NBSP the browser substitutes at a text-node edge — same char class the existing `#`/`-`/`1.` patterns use). Task 3 (`handleAutoFormat`) and Task 4 (Enter handling) both consume this type and `convertBlockToHr`, which Task 3 also defines.

- [ ] **Step 1: Write the failing tests**

Add to `test/editor.test.ts`, in the `describe('detectBlockPrefix', ...)` block, alongside the existing list-prefix assertions (near line 896-898):

```ts
test('detects --- (3+ dashes) with a trailing space as hr', () => {
  expect(detectBlockPrefix('--- ')).toEqual({ type: 'hr', prefixLen: 4 })
  expect(detectBlockPrefix('---- ')).toEqual({ type: 'hr', prefixLen: 5 })
  expect(detectBlockPrefix('----------- ')).toEqual({ type: 'hr', prefixLen: 12 })
})

test('does not detect hr with fewer than 3 dashes', () => {
  expect(detectBlockPrefix('-- ')).toBeNull()
  expect(detectBlockPrefix('- ')).toEqual({ type: 'ul', prefixLen: 2 }) // still a list bullet, unaffected
})
```

And alongside the existing NBSP test (near line 906-908):

```ts
test('detects hr prefix with trailing NBSP too', () => {
  const nbsp = ' '
  expect(detectBlockPrefix('---' + nbsp)).toEqual({ type: 'hr', prefixLen: 4 })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editor.test.ts -t "detects"`
Expected: FAIL — `detectBlockPrefix('--- ')` returns `null` today.

- [ ] **Step 3: Implement the `hr` branch in `detectBlockPrefix`**

In `src/ui/editor.ts`, extend `BlockPrefixMatch` (line 82-85):

```ts
export interface BlockPrefixMatch {
  type: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'hr'
  prefixLen: number
}
```

And in `detectBlockPrefix` (lines 97-107), add a branch before the final `return null`:

```ts
export function detectBlockPrefix(text: string): BlockPrefixMatch | null {
  let m = /^(#{1,3})[  ]$/.exec(text)
  if (m) return { type: (`h${m[1]!.length}` as 'h1' | 'h2' | 'h3'), prefixLen: m[0]!.length }

  if (/^-[  ]$/.test(text)) return { type: 'ul', prefixLen: 2 }

  m = /^\d+\.[  ]$/.exec(text)
  if (m) return { type: 'ol', prefixLen: m[0]!.length }

  m = /^(-{3,})[  ]$/.exec(text)
  if (m) return { type: 'hr', prefixLen: m[0]!.length }

  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts -t "detects"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: detectBlockPrefix recognizes --- as an hr prefix"
```

---

### Task 3: `convertBlockToHr` + wire into `handleAutoFormat` (space trigger, end-to-end)

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `BlockPrefixMatch` with `type: 'hr'` from Task 2.
- Produces: `convertBlockToHr(block: HTMLElement): void` (module-private function, same file) — Task 4's Enter handler also calls this.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts`, in the `describe('block-prefix auto-format on typing', ...)` block, alongside the existing `"- "` conversion test (after line 804):

```ts
test('typing "--- " auto-converts the block to a horizontal rule, with an empty block after it for the caret', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement

  setBlockText(editorEl, '--- ')
  editorEl.dispatchEvent(new Event('input', { bubbles: true }))

  const hr = editorEl.querySelector('hr')
  expect(hr).not.toBeNull()
  expect(hr!.parentElement).toBe(editorEl)
  const next = hr!.nextElementSibling as HTMLElement
  expect(next).not.toBeNull()
  expect(next.tagName).toBe('DIV')
  const sel = window.getSelection()!
  expect(sel.rangeCount).toBe(1)
  expect(sel.getRangeAt(0).collapsed).toBe(true)
  expect(next.contains(sel.anchorNode)).toBe(true)
  editor.destroy()
})

test('editor.getMd() serializes the inserted rule back to "---"', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement

  setBlockText(editorEl, '--- ')
  editorEl.dispatchEvent(new Event('input', { bubbles: true }))

  expect(editor.getMd()).toBe('---\n')
  editor.destroy()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editor.test.ts -t "horizontal rule"`
Expected: FAIL — no `<hr>` in the DOM (the `hr` blockMatch falls into the generic `applyBlockFormat` path today, which does `execCommand('formatBlock', false, '<hr>')` — jsdom's `execCommand` stub returns `false` and does nothing).

- [ ] **Step 3: Implement `convertBlockToHr`**

In `src/ui/editor.ts`, right after `convertBlockToList` (after line 408):

```ts
  /**
   * Replaces an emptied-out top-level block with `<hr>` followed by a fresh
   * empty block for the caret — unlike convertBlockToList's <li>, an <hr> is
   * a void element and can never hold a caret itself.
   */
  function convertBlockToHr(block: HTMLElement): void {
    editorEl.focus()
    const hr = document.createElement('hr')
    const next = document.createElement('div')
    next.appendChild(document.createElement('br'))
    block.replaceWith(hr, next)
    const r = document.createRange()
    r.selectNodeContents(next)
    r.collapse(true)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
  }
```

- [ ] **Step 4: Wire it into `handleAutoFormat`**

In `src/ui/editor.ts`, in `handleAutoFormat` (lines 426-449), add the `hr` case before the existing `ul`/`ol` check:

```ts
    if (caretOffset === text.length) {
      const blockMatch = detectBlockPrefix(text)
      if (blockMatch) {
        if (blockMatch.type === 'hr' && block.parentElement === editorEl) {
          convertBlockToHr(block)
          return
        }
        if ((blockMatch.type === 'ul' || blockMatch.type === 'ol') && block.parentElement === editorEl) {
          convertBlockToList(block, blockMatch.type)
          return
        }
        const range = rangeForTextOffsets(block, 0, blockMatch.prefixLen)
        range.deleteContents()
        const sel = window.getSelection()
        if (sel) { sel.removeAllRanges(); sel.addRange(range) }
        applyBlockFormat(blockMatch.type)
        return
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS, all tests in the file (including pre-existing ones — this confirms the new `hr` branch didn't disturb the `ul`/`ol`/heading branches).

- [ ] **Step 6: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: --- + space auto-converts the block to a horizontal rule"
```

---

### Task 4: Enter-key trigger

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `convertBlockToHr` (Task 3), `currentBlockAndOffset()` (existing, `src/ui/editor.ts:204-226`), `scheduleChange()` (existing, `src/ui/editor.ts:155`).
- Produces: nothing new consumed elsewhere — this completes the feature.

- [ ] **Step 1: Write the failing test**

Add to `test/editor.test.ts`, in the `describe('block-prefix auto-format on typing', ...)` block:

```ts
test('pressing Enter on a block containing only "---" converts it to an hr (no trailing space needed)', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement

  setBlockText(editorEl, '---')
  const e = dispatchKey(editorEl, { key: 'Enter' })

  expect(e.defaultPrevented).toBe(true)
  const hr = editorEl.querySelector('hr')
  expect(hr).not.toBeNull()
  const next = hr!.nextElementSibling as HTMLElement
  expect(next.tagName).toBe('DIV')
  const sel = window.getSelection()!
  expect(next.contains(sel.anchorNode)).toBe(true)
  editor.destroy()
})

test('Enter on a block that is not exactly "---" behaves normally (not intercepted)', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement

  setBlockText(editorEl, 'some text --')
  const e = dispatchKey(editorEl, { key: 'Enter' })

  expect(e.defaultPrevented).toBe(false)
  expect(editorEl.querySelector('hr')).toBeNull()
  editor.destroy()
})

test('Enter on "---" inside a list item is not intercepted (converting would produce unrepresentable markup)', () => {
  const editor = createEditor(makeHooks(), 'en-US')
  document.body.appendChild(editor.root)
  const editorEl = editor.root.querySelector('.editor') as HTMLElement
  editorEl.innerHTML = '<ul><li>---</li></ul>'
  const li = editorEl.querySelector('li')!
  const textNode = li.firstChild as Text
  const range = document.createRange()
  range.setStart(textNode, textNode.textContent!.length)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)

  const e = dispatchKey(editorEl, { key: 'Enter' })

  expect(e.defaultPrevented).toBe(false)
  expect(editorEl.querySelector('hr')).toBeNull()
  editor.destroy()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editor.test.ts -t "Enter"`
Expected: FAIL — the first new test fails (`e.defaultPrevented` is `false`, no `<hr>` created); the other two should already pass since nothing currently intercepts Enter (confirms baseline before the change, but run them all together with the rest of the file to be sure nothing else broke).

- [ ] **Step 3: Add the Enter interceptor to `onKeydown`**

In `src/ui/editor.ts`, at the top of `onKeydown` (line 741), before the existing `Tab` check:

```ts
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const ctx = currentBlockAndOffset()
      if (ctx && ctx.block.parentElement === editorEl && ctx.caretOffset === ctx.text.length && /^-{3,}$/.test(ctx.text)) {
        e.preventDefault()
        convertBlockToHr(ctx.block)
        scheduleChange()
        return
      }
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
```

(The rest of the existing function body is unchanged — this only adds the new branch above the pre-existing `Tab` check.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions elsewhere (e.g. in `test/rich-editor.test.ts`, which builds on top of `editor.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: pressing Enter after typing --- also inserts a horizontal rule"
```

---

### Task 5: Themed CSS for `<hr>` in the editor

**Files:**
- Modify: `styles.css`

**Interfaces:**
- Consumes: existing `--border` custom property (defined per-palette/light/dark throughout `styles.css`).
- Produces: nothing consumed by other tasks — purely visual.

- [ ] **Step 1: Add the rule**

In `styles.css`, right after the existing `.editor ul, .editor ol { padding-left: 1.5em; }` rule (line 592):

```css
.editor hr { border: none; border-top: 1px solid var(--border); margin: .75em 0; }
```

- [ ] **Step 2: Verify visually**

Run: `npm run build`, then open `dist/app.html`, create/open a doc, type `---` then Space in any note field, confirm a themed horizontal line appears (toggle a palette/dark mode in Prefs to confirm `--border` tracks the theme).

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "style: theme the editor's horizontal-rule divider"
```

---

### Task 6: Help modal + i18n

**Files:**
- Modify: `src/core/i18n.ts`
- Modify: `src/ui/help.ts`
- Test: none (no existing test asserts the full `MD_ROWS` content; this is a documentation-only addition, verified by running the suite to confirm the `MsgKey` type still resolves everywhere)

**Interfaces:**
- Consumes: nothing new.
- Produces: new `MsgKey` entries `help_md_hr` (both locales) — nothing else depends on these.

- [ ] **Step 1: Add the i18n keys**

In `src/core/i18n.ts`, in the `pt` object, right after `help_md_ol: 'Item de lista numerada',` (line 247):

```ts
  help_md_hr: 'Linha horizontal',
```

In the `en` object, right after `help_md_ol: 'Numbered list item',` (line 697):

```ts
  help_md_hr: 'Horizontal rule',
```

- [ ] **Step 2: Add the row to the help modal**

In `src/ui/help.ts`, add to `MD_ROWS` (lines 20-27), after the `'1. texto'` row:

```ts
const MD_ROWS: readonly (readonly [string, MsgKey])[] = [
  ['**texto**', 'help_md_bold'],
  ['*texto*', 'help_md_italic'],
  ['~~texto~~', 'help_md_strike'],
  ['# / ## / ###', 'help_md_headings'],
  ['- texto', 'help_md_ul'],
  ['1. texto', 'help_md_ol'],
  ['---', 'help_md_hr'],
]
```

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — confirms the new `MsgKey` compiles and nothing snapshots the old `MD_ROWS` length/content.

- [ ] **Step 4: Commit**

```bash
git add src/core/i18n.ts src/ui/help.ts
git commit -m "docs: document the --- horizontal-rule shortcut in the editor help modal"
```
