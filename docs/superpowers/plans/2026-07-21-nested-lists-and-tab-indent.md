# Nested lists + natural Tab/Shift+Tab indentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Shift+Tab caret-jump bug in free-text blocks, and add real multi-level nested bullet/numbered lists with Tab/Shift+Tab nesting them like a standard text editor.

**Architecture:** `src/core/markdown.ts`'s `mdToHtml`/`htmlToMd` move from a flat single-list model to an indentation-based nested-list grammar (2 spaces/level, capped at 4 levels), building/serializing real nested `<ul>/<ol><li>` DOM trees via a small depth-tracking stack. `src/ui/editor.ts`'s Tab/Shift+Tab, when the caret or selection is inside a list item, hand-roll DOM restructuring to nest/promote the item (matching the existing hand-rolled-over-`execCommand` precedent already used for list-to-block conversion in this file), instead of `execCommand('indent'/'outdent')` — this keeps the resulting DOM shape exactly what `htmlToMd` expects. Outside lists, behavior is unchanged except for the caret-position fix.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vitest + jsdom, zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies — no new packages, `esbuild`/`typescript`/`vitest`/`jsdom` stay dev-only.
- `tsc --noEmit` strict mode must pass, including `noUncheckedIndexedAccess` (array/index access needs explicit `undefined` handling, not `!`-only assumptions where an index could realistically be out of range).
- Every touched `src` module's matching `test/*.test.ts` must stay green (`npm test`).
- No new i18n strings needed (Tab/Shift+Tab aren't surfaced as UI copy).
- Design source of truth: `docs/superpowers/specs/2026-07-21-nested-lists-and-tab-indent-design.md`.

---

## Task 1: Fix Shift+Tab caret-jump bug (plain paragraphs/headings)

**Files:**
- Modify: `src/ui/editor.ts` (`onKeydown`'s Shift+Tab branch, currently lines 442-459)
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: existing `currentBlockAndOffset()` (returns `{ block: HTMLElement; text: string; caretOffset: number } | null`), `rangeForTextOffsets(block: HTMLElement, start: number, end: number): Range`, `leadingIndentLen(text: string): number` — all already defined in this file, signatures unchanged.
- Produces: no new exports. Internal behavior fix only.

The bug: after deleting the line's leading indent, the caret is hardcoded to the start of the block (`r.setStart(ctx.block, 0)`) instead of staying near where it was. This reads as "Shift+Tab only works at the beginning of the line."

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('Tab indent', ...)` block in `test/editor.test.ts`, right before that block's closing `})` (after the `'Shift+Tab on a line with no leading indent is a no-op'` test):

```ts
  test('Shift+Tab keeps the caret near its position, not jumped to line start', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('    hello world')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const block = editorEl.firstElementChild as HTMLElement
    const textNode = block.firstChild!
    // Caret right after "hello" (4 indent chars + "hello".length = 9).
    const range = document.createRange()
    range.setStart(textNode, 9)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('hello world')
    const newRange = window.getSelection()!.getRangeAt(0)
    const pre = document.createRange()
    pre.selectNodeContents(block)
    pre.setEnd(newRange.startContainer, newRange.startOffset)
    // 4 indent chars removed from an offset-9 caret -> offset 5, right after "hello".
    expect(pre.toString().length).toBe(5)
    editor.destroy()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/editor.test.ts -t "keeps the caret near its position"`
Expected: FAIL — caret lands at offset 0, not 5.

- [ ] **Step 3: Implement the fix**

In `src/ui/editor.ts`, find `onKeydown`'s Shift+Tab branch:

```ts
      if (e.shiftKey) {
        const ctx = currentBlockAndOffset()
        if (ctx) {
          const n = leadingIndentLen(ctx.text)
          if (n > 0) {
            const range = rangeForTextOffsets(ctx.block, 0, n)
            range.deleteContents()
            const sel = window.getSelection()
            if (sel) {
              sel.removeAllRanges()
              const r = document.createRange()
              r.setStart(ctx.block, 0)
              r.collapse(true)
              sel.addRange(r)
            }
            scheduleChange()
          }
        }
      } else {
```

Replace the caret-placement block so it restores the caret at `caretOffset - n` instead of hardcoding `0`:

```ts
      if (e.shiftKey) {
        const ctx = currentBlockAndOffset()
        if (ctx) {
          const n = leadingIndentLen(ctx.text)
          if (n > 0) {
            const range = rangeForTextOffsets(ctx.block, 0, n)
            range.deleteContents()
            const sel = window.getSelection()
            if (sel) {
              sel.removeAllRanges()
              const newOffset = Math.max(0, ctx.caretOffset - n)
              sel.addRange(rangeForTextOffsets(ctx.block, newOffset, newOffset))
            }
            scheduleChange()
          }
        }
      } else {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS (all tests in the file, including the two pre-existing Shift+Tab tests — they only check caret-independent line-start-offset assertions, so they're unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "fix: Shift+Tab keeps caret position instead of jumping to line start"
```

---

## Task 2: Nested list support in `core/markdown.ts`

**Files:**
- Modify: `src/core/markdown.ts` (`mdToHtml`, `blockToMd`, `blockToText`, `htmlToPlainText`, `htmlToMd`)
- Test: `test/markdown.test.ts`

**Interfaces:**
- Produces: `export const MAX_LIST_DEPTH = 3` (new — depths 0-3, 4 levels total; Task 3 imports this into `editor.ts`).
- `mdToHtml(md: string, resolveLabel?: LabelResolver): string`, `htmlToMd(root: HTMLElement): string`, `htmlToPlainText(root: HTMLElement): string` keep their existing exported signatures — only their internal rendering changes.

List lines gain an optional leading-space run *before* the `- `/`N. ` marker, denoting nesting depth (2 spaces/level). This is independent of the *existing* same-line-indent feature, which reads leading spaces *after* the marker (inside the item's own text) — the two compose naturally since depth-parsing happens first, then the remainder is handed to the unchanged per-line inline rendering.

- [ ] **Step 1: Write the failing tests**

Add to `test/markdown.test.ts`. First, update the import line to include `htmlToPlainText`:

```ts
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef } from '../src/core/markdown'
```

Then add these tests (anywhere after the existing `'leading indent inside a header round-trips'` test):

```ts
test('nested unordered list round-trips (2 levels)', () => {
  const md = '- a\n  - a1\n  - a2\n- b'
  expect(roundTrip(md)).toBe(md)
})

test('nested list round-trips 4 levels deep', () => {
  const md = '- a\n  - b\n    - c\n      - d'
  expect(roundTrip(md)).toBe(md)
})

test('nested list produces a real nested <ul> inside the parent <li>', () => {
  const md = '- a\n  - a1'
  expect(mdToHtml(md)).toBe('<ul><li>a<ul><li>a1</li></ul></li></ul>')
})

test('promoting a nested item back to a top-level sibling round-trips', () => {
  const md = '- a\n  - a1\n- b\n  - b1\n  - b2'
  expect(roundTrip(md)).toBe(md)
})

test('ordered list with nested unordered sublist round-trips, numbering restarts per level', () => {
  const md = '1. a\n  - a1\n  - a2\n2. b'
  expect(roundTrip(md)).toBe(md)
})

test('nested ordered list restarts numbering independently per level', () => {
  const md = '1. a\n  1. a-sub\n  2. a-sub2\n2. b'
  expect(roundTrip(md)).toBe(md)
})

test('an indent jump of more than one level clamps to one level deeper than the actual parent', () => {
  const md = '- a\n      - too deep'
  expect(mdToHtml(md)).toBe('<ul><li>a<ul><li>too deep</li></ul></li></ul>')
})

test('an over-indented first list line (no parent yet) clamps to depth 0', () => {
  const md = '        - way too deep'
  expect(mdToHtml(md)).toBe('<ul><li>way too deep</li></ul>')
})

test('nesting depth caps at 4 levels (0-3) even if indentation implies deeper', () => {
  const md = '- a\n  - b\n    - c\n      - d\n        - e'
  const html = mdToHtml(md)
  const div = document.createElement('div')
  div.innerHTML = html
  expect(htmlToMd(div)).toBe('- a\n  - b\n    - c\n      - d\n      - e')
})

test('htmlToPlainText keeps nested list item text on its own line', () => {
  const div = document.createElement('div')
  div.innerHTML = mdToHtml('- a\n  - a1\n- b')
  expect(htmlToPlainText(div)).toBe('a\na1\nb')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/markdown.test.ts`
Expected: FAIL — nested list lines aren't parsed/serialized yet (flat single-list behavior only).

- [ ] **Step 3: Implement — `mdToHtml`**

In `src/core/markdown.ts`, add the depth-cap constant right after the `DAY_TARGET` line (below the existing top-of-file constants):

```ts
/** Max list nesting depth (0-indexed) — depths 0-3 = 4 levels. Shared with src/ui/editor.ts's Tab/Shift+Tab nest/promote logic so both sides agree on the cap. */
export const MAX_LIST_DEPTH = 3
```

Replace the whole `mdToHtml` function:

```ts
export function mdToHtml(md: string, resolveLabel?: LabelResolver): string {
  const lines = md.split('\n'); const out: string[] = []
  interface ListFrame { type: 'ul' | 'ol'; depth: number; hasOpenLi: boolean }
  const stack: ListFrame[] = []
  const closeFrame = (f: ListFrame) => { if (f.hasOpenLi) out.push('</li>'); out.push(`</${f.type}>`) }
  const closeList = () => { while (stack.length) closeFrame(stack.pop()!) }
  // Adds one list item at `rawDepth` (parsed from the line's leading-space
  // run, pre-clamp). Depth is capped at both the current nesting context
  // (stack.length — you can only ever nest one level deeper than whatever
  // is currently open) and MAX_LIST_DEPTH, so a malformed/hand-typed indent
  // jump never produces an orphaned list structure.
  const addListItem = (rawDepth: number, type: 'ul' | 'ol', itemHtml: string, valueAttr: string) => {
    const depth = Math.min(rawDepth, stack.length, MAX_LIST_DEPTH)
    while (stack.length && stack[stack.length - 1]!.depth > depth) closeFrame(stack.pop()!)
    let top = stack[stack.length - 1]
    if (top && top.depth === depth && top.type !== type) { closeFrame(stack.pop()!); top = stack[stack.length - 1] }
    if (top && top.depth === depth && top.type === type) {
      if (top.hasOpenLi) out.push('</li>')
    } else {
      out.push(`<${type}>`)
      stack.push({ type, depth, hasOpenLi: false })
      top = stack[stack.length - 1]!
    }
    out.push(`<li${valueAttr}>`, itemHtml)
    top!.hasOpenLi = true
  }
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^( *)- (.*)$/.exec(line)
    const ol = /^( *)(\d+)\. (.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel)}</h${h[1]!.length}>`) }
    else if (ul) addListItem(Math.floor(ul[1]!.length / 2), 'ul', blockInline(preserveIndent(ul[2]!), resolveLabel), '')
    else if (ol) addListItem(Math.floor(ol[1]!.length / 2), 'ol', blockInline(preserveIndent(ol[3]!), resolveLabel), ` value="${ol[2]}"`)
    else { closeList(); out.push(`<div>${line ? blockInline(preserveIndent(line), resolveLabel) : '<br>'}</div>`) }
  }
  closeList(); return out.join('')
}
```

- [ ] **Step 4: Implement — `blockToMd` / `htmlToMd`**

Replace the `blockToMd` function:

```ts
function blockToMdNodes(nodes: Node[]): string {
  const segments: Node[][] = [[]]
  nodes.forEach(child => {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'br') segments.push([])
    else segments[segments.length - 1]!.push(child)
  })
  if (segments.length > 1 && segments[segments.length - 1]!.length === 0) segments.pop()
  return segments.map(seg => seg.map(inlineMd).join('')).join('\n')
}

// Splits a block element's children at <br> boundaries and joins each
// segment's rendered markdown with '\n', so soft line breaks survive the
// html -> markdown conversion. A trailing <br> produces no extra empty line.
function blockToMd(node: HTMLElement): string {
  return blockToMdNodes(Array.from(node.childNodes))
}

// Renders a <ul>/<ol> element (and any nested <ul>/<ol> inside its <li>
// children) as indented markdown lines, 2 spaces per depth level. Each
// <li>'s own text excludes its nested sub-list (rendered separately, right
// after that item's own line, at depth + 1).
function renderListMd(list: HTMLElement, depth: number, out: string[]): void {
  const tag = list.tagName.toLowerCase()
  const prefix = '  '.repeat(depth)
  let i = 0
  Array.from(list.children).forEach(child => {
    if (!(child instanceof HTMLElement) || child.tagName.toLowerCase() !== 'li') return
    const nested = child.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
    const text = blockToMdNodes(Array.from(child.childNodes).filter(n => n !== nested))
    if (tag === 'ol') {
      const v = child.getAttribute('value')
      i = v ? Number(v) : i + 1
      out.push(`${prefix}${i}. ${text}`)
    } else {
      out.push(`${prefix}- ${text}`)
    }
    if (nested) renderListMd(nested, depth + 1, out)
  })
}
```

Then replace `htmlToMd`'s `ul`/`ol` handling — the full function becomes:

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
    else if (tag === 'div' || tag === 'p') out.push(blockToMd(node))
    else out.push(inlineMd(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
```

- [ ] **Step 5: Implement — `blockToText` / `htmlToPlainText`**

Replace the `blockToText` function:

```ts
function blockToTextNodes(nodes: Node[]): string {
  const segments: Node[][] = [[]]
  nodes.forEach(child => {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'br') segments.push([])
    else segments[segments.length - 1]!.push(child)
  })
  if (segments.length > 1 && segments[segments.length - 1]!.length === 0) segments.pop()
  return segments.map(seg => seg.map(inlineText).join('')).join('\n')
}

// Same <br>-segment-splitting shape as blockToMd, but renders visual text
// (no markdown syntax markers) — used for "copy without formatting".
function blockToText(node: HTMLElement): string {
  return blockToTextNodes(Array.from(node.childNodes))
}

// Text-only counterpart to renderListMd: walks nested <ul>/<ol> recursively
// so copy-as-plain-text doesn't run sub-bullet text together with its
// parent's.
function renderListText(list: HTMLElement, out: string[]): void {
  Array.from(list.children).forEach(child => {
    if (!(child instanceof HTMLElement) || child.tagName.toLowerCase() !== 'li') return
    const nested = child.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
    out.push(blockToTextNodes(Array.from(child.childNodes).filter(n => n !== nested)))
    if (nested) renderListText(nested, out)
  })
}
```

Then update `htmlToPlainText`'s `ul`/`ol` branch — the full function becomes:

```ts
export function htmlToPlainText(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (!(node instanceof HTMLElement)) {
      const t = node.textContent; if (t) out.push(t); return
    }
    const tag = node.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') renderListText(node, out)
    else if (/^h[1-3]$/.test(tag) || tag === 'div' || tag === 'p') out.push(blockToText(node))
    else out.push(inlineText(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/markdown.test.ts`
Expected: PASS — all new tests plus every pre-existing test in the file (the flat single-level list tests are just depth-0-only cases of the same code path now).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck`
Run: `npm run lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/markdown.ts test/markdown.test.ts
git commit -m "feat: nested list support in markdown load/save (core/markdown.ts)"
```

---

## Task 3: Editor Tab/Shift+Tab nest/promote for a single list item

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `MAX_LIST_DEPTH` from `../core/markdown` (Task 2).
- Produces (internal, not exported): `closestLi(node: Node): HTMLElement | null`, `listItemDepth(li: HTMLElement): number`, `indentListItems(items: HTMLElement[]): void`, `outdentListItems(items: HTMLElement[]): void`, `selectedListItemsForTab(): HTMLElement[]` — Task 4 replaces `selectedListItemsForTab` in place with a multi-item-aware version; the other four functions are unchanged by Task 4.

Inside a list item, Tab/Shift+Tab stop meaning "insert/remove a same-line nbsp indent" and instead restructure the DOM: Tab nests the item under its previous sibling (no-op if it's the first item, or already at `MAX_LIST_DEPTH`); Shift+Tab promotes it out one level, and any items that were after it in the same nested list move with it as its own new children (no-op at depth 0). This task wires up the single-item case (collapsed caret); Task 4 adds multi-item selection.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/editor.test.ts`, after the existing `describe('Tab indent', ...)` block:

```ts
describe('list nesting via Tab/Shift+Tab', () => {
  function collapseInto(li: Element): void {
    const range = document.createRange()
    range.selectNodeContents(li)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('Tab nests a list item under its previous sibling', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n- b')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[1]!)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe('- a\n  - b')
    editor.destroy()
  })

  test('Tab on the first item of a list is a no-op (nothing to nest under)', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const md = '- a\n- b'
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[0]!)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })

  test('Tab at max nesting depth (4 levels) is a no-op', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const md = '- a\n  - b\n    - c\n      - d\n      - e'
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const items = editorEl.querySelectorAll('li')
    collapseInto(items[items.length - 1]!) // "e", already at depth 3 alongside "d"

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })

  test('Shift+Tab promotes a nested item out one level, carrying its trailing siblings as its own children', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n  - b\n  - c\n- d')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[1]!) // "b"

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- b\n  - c\n- d')
    editor.destroy()
  })

  test('Shift+Tab on a top-level list item is a no-op', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    const md = '- a\n- b'
    editor.setMd(md)
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    collapseInto(editorEl.querySelectorAll('li')[0]!)

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe(md)
    editor.destroy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editor.test.ts -t "list nesting via Tab/Shift+Tab"`
Expected: FAIL — Tab inside a list item still does the old nbsp-insert behavior.

- [ ] **Step 3: Implement**

In `src/ui/editor.ts`, update the import line to pull in `MAX_LIST_DEPTH`:

```ts
import { mdToHtml, htmlToMd, htmlToPlainText, parseRef, MAX_LIST_DEPTH, type RefInfo, type LabelResolver } from '../core/markdown'
```

Add these functions right after `rangeForTextOffsets` (before `setCaretAfter`):

```ts
  function closestLi(node: Node): HTMLElement | null {
    let n: Node | null = node
    while (n && n !== editorEl) {
      if (n instanceof HTMLElement && n.tagName === 'LI') return n
      n = n.parentElement
    }
    return null
  }

  function listItemDepth(li: HTMLElement): number {
    let depth = 0
    let n: HTMLElement | null = li.parentElement
    while (n && n !== editorEl) {
      if (n.tagName === 'LI') depth++
      n = n.parentElement
    }
    return depth
  }

  /** Nests `items` (sibling <li>s, in document order) under the previous
   * sibling of the first one, as that sibling's nested sub-list (reusing one
   * if it already has one). No-op if there's no previous sibling to nest
   * under, or the batch is already at MAX_LIST_DEPTH. */
  function indentListItems(items: HTMLElement[]): void {
    const first = items[0]
    if (!first || listItemDepth(first) >= MAX_LIST_DEPTH) return
    const prev = first.previousElementSibling as HTMLElement | null
    if (!prev || prev.tagName !== 'LI') return
    const parentList = first.parentElement as HTMLElement
    let sub = prev.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
    if (!sub) {
      sub = document.createElement(parentList.tagName.toLowerCase())
      prev.appendChild(sub)
    }
    items.forEach(li => sub!.appendChild(li))
    scheduleChange()
  }

  /** Promotes `items` (sibling <li>s, in document order) out one level, into
   * the list they're nested under as new siblings right after the item they
   * were nested under. Any items after `items` in the same nested list move
   * with them, becoming children of the last promoted item (preserves
   * hierarchy). No-op at depth 0. */
  function outdentListItems(items: HTMLElement[]): void {
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const list = first.parentElement as HTMLElement
    const parentLi = list.parentElement as HTMLElement | null
    if (!parentLi || parentLi.tagName !== 'LI') return
    const grandList = parentLi.parentElement as HTMLElement

    const trailing: HTMLElement[] = []
    let sib = last.nextElementSibling
    while (sib) { trailing.push(sib as HTMLElement); sib = sib.nextElementSibling }
    if (trailing.length > 0) {
      let sub = last.querySelector(':scope > ul, :scope > ol') as HTMLElement | null
      if (!sub) {
        sub = document.createElement(list.tagName.toLowerCase())
        last.appendChild(sub)
      }
      trailing.forEach(li => sub!.appendChild(li))
    }

    const insertBefore = parentLi.nextElementSibling
    items.forEach(li => grandList.insertBefore(li, insertBefore))
    if (list.children.length === 0) list.remove()
    scheduleChange()
  }

  // Task 4 replaces this with a version that also detects a multi-item
  // sibling selection; for now, only the item containing the collapsed caret.
  function selectedListItemsForTab(): HTMLElement[] {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return []
    const li = closestLi(sel.getRangeAt(0).startContainer)
    return li ? [li] : []
  }
```

Then wire it into `onKeydown` — the Tab branch's opening changes from:

```ts
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (e.shiftKey) {
```

to:

```ts
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const listItems = selectedListItemsForTab()
      if (listItems.length > 0) {
        if (e.shiftKey) outdentListItems(listItems)
        else indentListItems(listItems)
        return
      }
      if (e.shiftKey) {
```

(the rest of the branch — the paragraph/heading same-line-indent logic from Task 1 — is unchanged; it now only runs when the caret isn't inside a list item).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS — all tests in the file, including the pre-existing `describe('Tab indent', ...)` tests (they use plain `<div>` blocks, never list items, so `selectedListItemsForTab()` returns `[]` for them and they fall through to the unchanged paragraph path).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck`
Run: `npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: Tab/Shift+Tab nest and promote list items"
```

---

## Task 4: Multi-item selection support for list Tab/Shift+Tab

**Files:**
- Modify: `src/ui/editor.ts`
- Test: `test/editor.test.ts`

**Interfaces:**
- Consumes: `closestLi`, `indentListItems`, `outdentListItems` from Task 3 (unchanged signatures).
- Produces: `selectedListItems(): HTMLElement[]` — replaces Task 3's `selectedListItemsForTab` (same call site in `onKeydown`, renamed).

If the selection spans multiple sibling list items (same parent `<ul>/<ol>`), Tab/Shift+Tab applies to the whole batch — they nest/promote together, preserving relative order. If the selection's start/end land in list items that aren't siblings (different parent lists — a mixed-depth selection), fall back to only the item containing the selection's start point.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('list nesting via Tab/Shift+Tab', ...)` block in `test/editor.test.ts`, before its closing `})`:

```ts
  function selectAcross(startLi: Element, endLi: Element): void {
    const range = document.createRange()
    range.setStart(startLi.firstChild!, 0)
    range.setEnd(endLi.firstChild!, endLi.firstChild!.textContent!.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  test('Tab with multiple sibling list items selected nests the whole batch together', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n- b\n- c')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const [, liB, liC] = Array.from(editorEl.querySelectorAll('li'))
    selectAcross(liB!, liC!)

    dispatchKey(editorEl, { key: 'Tab' })

    expect(editor.getMd()).toBe('- a\n  - b\n  - c')
    editor.destroy()
  })

  test('Shift+Tab with multiple sibling nested items selected promotes the whole batch together', () => {
    const editor = createEditor(makeHooks(), 'en-US')
    document.body.appendChild(editor.root)
    editor.setMd('- a\n  - b\n  - c\n- d')
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    const items = editorEl.querySelectorAll('li')
    selectAcross(items[1]!, items[2]!) // "b", "c"

    dispatchKey(editorEl, { key: 'Tab', shiftKey: true })

    expect(editor.getMd()).toBe('- a\n- b\n- c\n- d')
    editor.destroy()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editor.test.ts -t "multiple sibling"`
Expected: FAIL — `selectedListItemsForTab` only ever returns the single item at the selection's start, so only "b" moves, not "b" and "c" together.

- [ ] **Step 3: Implement**

In `src/ui/editor.ts`, replace `selectedListItemsForTab` (added in Task 3) with:

```ts
  function selectedListItems(): HTMLElement[] {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return []
    const range = sel.getRangeAt(0)
    const startLi = closestLi(range.startContainer)
    if (!startLi) return []
    const endLi = closestLi(range.endContainer)
    if (!endLi || endLi === startLi) return [startLi]
    if (startLi.parentElement !== endLi.parentElement) return [startLi]
    const siblings = Array.from(startLi.parentElement!.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && c.tagName === 'LI'
    )
    const startIdx = siblings.indexOf(startLi)
    const endIdx = siblings.indexOf(endLi)
    return siblings.slice(Math.min(startIdx, endIdx), Math.max(startIdx, endIdx) + 1)
  }
```

Update the one call site in `onKeydown`:

```ts
      const listItems = selectedListItemsForTab()
```

to:

```ts
      const listItems = selectedListItems()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editor.test.ts`
Expected: PASS — every test in the file, including Task 3's single-item tests (a collapsed selection still resolves `startLi === endLi`, taking the `return [startLi]` path).

- [ ] **Step 5: Typecheck, lint, and full test suite**

Run: `npm run typecheck`
Run: `npm run lint`
Run: `npm test`
Run: `npm run build` (confirms `dist/app.html` and `dist/pwa/` still bundle cleanly)
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/editor.ts test/editor.test.ts
git commit -m "feat: multi-item selection support for list Tab/Shift+Tab"
```

---

## Final Verification

- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` one more time, all green.
- [ ] Manually smoke-test in a browser (`npm run build` then open `dist/app.html`): open a note, type a bulleted list, press Tab on the second item to nest it, Shift+Tab to promote it back out, nest 4 levels deep and confirm Tab no-ops at the 5th, select multiple sibling items and Tab/Shift+Tab them together, and confirm Shift+Tab on a plain indented paragraph line no longer jumps the caret to the start of the line.
