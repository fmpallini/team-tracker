// src/ui/editor-dom.ts — pure caret/block helpers over the WYSIWYG
// contenteditable root (`.editor`). Extracted from src/ui/editor.ts so
// src/ui/atref.ts and src/ui/template-picker.ts stop each carrying a
// byte-identical private copy: both already couple to `.editor` and to the
// editor's CustomEvent contract (AT_TRIGGER_EVENT / SLASH_TRIGGER_EVENT), so
// the "stay fully decoupled from the editor's internals" rationale that once
// justified the duplication no longer holds. One implementation, one place
// for the block-walk and the text-offset->Range mapping to be correct.

export interface BlockCtx {
  block: HTMLElement
  text: string
  caretOffset: number
}

/**
 * The top-level block (a direct child of `editorEl`) or `<li>` the collapsed
 * caret sits in, that block's plain text, and the caret's character offset
 * within it. Null when there is no collapsed selection, the caret is outside
 * `editorEl`, or no block ancestor is found.
 */
export function blockAndCaret(editorEl: HTMLElement): BlockCtx | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!editorEl.contains(range.startContainer)) return null

  let block: HTMLElement | null = null
  let n: Node | null = range.startContainer
  while (n && n !== editorEl) {
    if (n instanceof HTMLElement && (n.parentElement === editorEl || n.tagName === 'LI')) {
      block = n
      break
    }
    n = n.parentElement
  }
  if (!block) return null

  const preRange = document.createRange()
  preRange.selectNodeContents(block)
  preRange.setEnd(range.startContainer, range.startOffset)
  const caretOffset = preRange.toString().length
  return { block, text: block.textContent ?? '', caretOffset }
}

/**
 * Places the caret immediately past a just-inserted inline node, genuinely
 * OUTSIDE its formatting context.
 *
 * `gap` controls a trailing NBSP that gives the caret a real slot when the
 * node sits at the end of its block: a plain trailing space is CSS-collapsed
 * to zero width, and Chrome then resolves the caret back INSIDE the inline
 * element — so typing `**b**` then more words produced one long bold run, and
 * a just-inserted `@`-chip swallowed the next keystrokes.
 *   - `'auto'` (default): add the NBSP only when no non-empty text already
 *     follows `node` — the case that needs it. For typed bold/italic/strike
 *     autoformat (`replaceInlineMatch`).
 *   - `'always'`: always add it. For `@`-mention chips, almost always the
 *     last thing on the line.
 *   - `'none'`: never add it — a plain `setStartAfter`. Where `node` is a
 *     link (Chrome does NOT pull the caret back into an `<a>` — verified) or
 *     plain text, so an NBSP would just be visible cruft.
 *
 * The NBSP renders as a space and htmlToMd (core/markdown.ts's inlineMd)
 * normalises it straight back to a plain space, so storage never accumulates
 * U+00A0.
 */
export function caretAfterInline(node: ChildNode, gap: 'auto' | 'always' | 'none' = 'auto'): void {
  const sel = window.getSelection()
  if (!sel) return
  const next = node.nextSibling
  const hasFollowingText = !!next && next.nodeType === Node.TEXT_NODE && (next.textContent ?? '').length > 0
  const r = document.createRange()
  if (gap === 'always' || (gap === 'auto' && !hasFollowingText)) {
    const slot = document.createTextNode('\u00a0')
    node.after(slot)
    r.setStart(slot, 1)
  } else {
    r.setStartAfter(node)
  }
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

/** Builds a Range spanning text offsets [start, end) within `block`'s text content. */
export function rangeForTextOffsets(block: HTMLElement, start: number, end: number): Range {
  const range = document.createRange()
  let remainingStart = start
  let remainingEnd = end
  let startSet = false
  let endSet = false
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0
    if (!startSet && remainingStart <= len) {
      range.setStart(node, remainingStart)
      startSet = true
    }
    if (!endSet && remainingEnd <= len) {
      range.setEnd(node, remainingEnd)
      endSet = true
      break
    }
    remainingStart -= len
    remainingEnd -= len
  }
  if (!startSet) range.setStart(block, block.childNodes.length)
  if (!endSet) range.setEnd(block, block.childNodes.length)
  return range
}
