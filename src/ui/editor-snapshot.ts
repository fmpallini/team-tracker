// src/ui/editor-snapshot.ts — pure snapshot/diff-restore over the WYSIWYG
// contenteditable root, the data layer of the editor's own undo stack.
//
// A snapshot is plain data: one normalized HTML string per top-level child of
// the root, the selection as {block index, text offset inside that block}, and
// the root's scrollTop. Blocks are DOM HTML, not markdown, so the caret comes
// back exactly (a markdown round trip trims spaces, re-labels chips, can split
// a block). Restore diffs the live document against a target by block string,
// keeps the unchanged prefix/suffix nodes untouched (scroll, spellcheck state
// and rendered pictures survive) and swaps only the middle, parsed through
// DOMParser into an inert document — never innerHTML on a live element.

import { preLines } from '../core/markdown'

/**
 * `offset` is the text offset inside the block. `path` + `domOffset` pin the
 * exact DOM point (child indexes from the block down to the container, and the
 * DOM offset in it) where text offsets are ambiguous: the end of one `<li>` and
 * the start of the next share an offset, and an empty `<li><br></li>` has no
 * text node. Only captured outside `<pre>` / `.tt-img`, whose stored form is
 * normalized so DOM paths would not match.
 */
export interface BlockPos { block: number; offset: number; path?: number[]; domOffset?: number }

export interface Snapshot {
  blocks: string[]
  /** `backward`: the anchor is at `end` (a selection made right to left, e.g. Shift+ArrowLeft); omitted when forward. */
  selection: { start: BlockPos; end: BlockPos; backward?: true } | null
  scrollTop: number
}

/**
 * Attributes the editor adds to a `<pre>` for presentation only. `data-lines`
 * is set once and not kept current while typing, so storing it would make two
 * snapshots of the same text differ (an undo that changes nothing visible).
 */
const PRE_TRANSIENT = ['data-collapsed', 'data-lines', 'data-more-label', 'spellcheck', 'autocorrect', 'autocapitalize']

/**
 * Classes the editor puts on a picture block for the view only: the click
 * selection (a restored picture must not come back selected, or the next
 * Backspace deletes it again) and the missing marker, which hydration sets
 * again on an emptied block.
 */
const IMG_TRANSIENT_CLASSES = ['is-selected', 'tt-img-missing']

function stripEventHandlers(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name)
  }
}

/** Stored HTML of one top-level block. Works on a clone, never the live node. */
function normalizedBlock(block: Element): string {
  const clone = block.cloneNode(true) as HTMLElement
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (const el of all) stripEventHandlers(el)
  const imgs = clone.matches('.tt-img') ? [clone] : []
  for (const img of [...imgs, ...Array.from(clone.querySelectorAll<HTMLElement>('.tt-img'))]) {
    img.replaceChildren()
    img.removeAttribute('data-img-loading')
    img.classList.remove(...IMG_TRANSIENT_CLASSES)
  }
  const pres = [...(clone.matches('pre') ? [clone] : []), ...Array.from(clone.querySelectorAll<HTMLElement>('pre'))]
  for (const pre of pres) {
    const lines = preLines(pre)
    pre.replaceChildren()
    if (lines.length === 0) pre.appendChild(pre.ownerDocument.createElement('br'))
    else pre.appendChild(pre.ownerDocument.createTextNode(lines.join('\n')))
    for (const a of PRE_TRANSIENT) pre.removeAttribute(a)
  }
  let html = clone.outerHTML
  // The HTML parser drops one newline right after `<pre>`, and serializers
  // disagree on whether they write a compensating one. Make the stored form
  // deterministic: a pre whose text starts with k newlines carries k + 1.
  if (clone.tagName === 'PRE') {
    const text = clone.firstChild?.nodeType === Node.TEXT_NODE ? clone.firstChild.textContent ?? '' : ''
    const k = /^\n*/.exec(text)![0].length
    if (k > 0) {
      const at = html.indexOf('>') + 1
      const have = /^\n*/.exec(html.slice(at))![0].length
      if (have === k) html = html.slice(0, at) + '\n' + html.slice(at)
    }
  }
  return html
}

function blocksOf(root: HTMLElement): string[] {
  return Array.from(root.children).map(normalizedBlock)
}

/** A `<br>` is a newline only inside a `<pre>`; everywhere else it matches textContent (0). */
function brLength(br: Node): number {
  return (br as Element).closest('pre') ? 1 : 0
}

/** Characters in a subtree, counted the way offsetInBlock counts them. */
function subtreeLength(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').length
  if (n.nodeName === 'BR') return brLength(n)
  let sum = 0
  n.childNodes.forEach((c) => { sum += subtreeLength(c) })
  return sum
}

/**
 * Text offset of the DOM point (node, offset) inside `block`: text characters
 * before it, a `<br>` inside a `<pre>` counting as one newline (the plain-text
 * shape a stored `<pre>` has). rangeForTextOffsets ignores those, so it is not
 * reused.
 */
function offsetInBlock(block: HTMLElement, node: Node, offset: number): number {
  let count = 0
  let done = false
  const walk = (n: Node): void => {
    if (done) return
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) count += offset
      else {
        const kids = n.childNodes
        for (let i = 0; i < offset && i < kids.length; i++) count += subtreeLength(kids[i]!)
      }
      done = true
      return
    }
    if (n.nodeType === Node.TEXT_NODE) { count += (n.textContent ?? '').length; return }
    if (n.nodeName === 'BR') { count += brLength(n); return }
    n.childNodes.forEach(walk)
  }
  walk(block)
  return count
}

/** Inverse of offsetInBlock; an offset past the end clamps to the end of the last text. */
function pointInBlock(block: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = offset
  let lastText: Text | null = null
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? '').length
      if (remaining <= len) return { node: n, offset: remaining }
      remaining -= len
      lastText = n as Text
    } else if (n.nodeName === 'BR' && brLength(n) === 1) {
      if (remaining === 0) {
        return { node: n.parentNode!, offset: Array.prototype.indexOf.call(n.parentNode!.childNodes, n) }
      }
      remaining -= 1
    }
  }
  if (lastText) return { node: lastText, offset: (lastText.textContent ?? '').length }
  return { node: block, offset: 0 }
}

function toBlockPos(root: HTMLElement, node: Node, offset: number): BlockPos | null {
  const n = root.children.length
  if (n === 0) return null
  if (node === root) {
    // A point on the root itself: before child `offset`. Past the last child is the end of the last block.
    if (offset >= n) return { block: n - 1, offset: subtreeLength(root.children[n - 1]!) }
    return { block: offset, offset: 0 }
  }
  let top: Node = node
  while (top.parentNode && top.parentNode !== root) top = top.parentNode
  if (top.parentNode !== root) return null
  if (top.nodeType !== Node.ELEMENT_NODE) {
    // A stray text node directly under the root: attribute it to the next block.
    let idx = 0
    for (let s = top.previousSibling; s; s = s.previousSibling) if (s.nodeType === Node.ELEMENT_NODE) idx++
    return { block: Math.min(idx, n - 1), offset: 0 }
  }
  const pos: BlockPos = {
    block: Array.prototype.indexOf.call(root.children, top),
    offset: offsetInBlock(top as HTMLElement, node, offset),
  }
  const host = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  if (!host?.closest('pre, .tt-img')) {
    const path: number[] = []
    for (let c: Node = node; c !== top; c = c.parentNode!) path.unshift(Array.prototype.indexOf.call(c.parentNode!.childNodes, c))
    pos.path = path
    pos.domOffset = offset
  }
  return pos
}

/** The exact DOM point of `p`, when its path still resolves and agrees with its text offset. */
function pointFromPath(block: HTMLElement, p: BlockPos): { node: Node; offset: number } | null {
  if (!p.path || p.domOffset === undefined) return null
  let node: Node = block
  for (const i of p.path) {
    const next = node.childNodes[i]
    if (!next) return null
    node = next
  }
  const max = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : node.childNodes.length
  if (p.domOffset < 0 || p.domOffset > max) return null
  if (offsetInBlock(block, node, p.domOffset) !== p.offset) return null
  return { node, offset: p.domOffset }
}

export function takeSnapshot(root: HTMLElement): Snapshot {
  const blocks = blocksOf(root)
  let selection: Snapshot['selection'] = null
  const sel = root.ownerDocument.getSelection()
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0)
    if (root.contains(r.startContainer) && root.contains(r.endContainer)) {
      const start = toBlockPos(root, r.startContainer, r.startOffset)
      const end = toBlockPos(root, r.endContainer, r.endOffset)
      const backward = !r.collapsed && (sel.anchorNode !== r.startContainer || sel.anchorOffset !== r.startOffset)
      if (start && end) selection = backward ? { start, end, backward: true } : { start, end }
    }
  }
  return { blocks, selection, scrollTop: root.scrollTop }
}

/** Blocks only; selection and scroll are ignored. */
export function sameBlocks(a: Snapshot, b: Snapshot): boolean {
  return a.blocks.length === b.blocks.length && a.blocks.every((s, i) => s === b.blocks[i])
}

/**
 * One element per stored block, always. Each block is parsed on its own: the
 * HTML parser reshapes some markup a live contenteditable can hold (a `<p>`
 * is closed before a block inside it), and parsed together one stored block
 * could turn into several and shift every later block index. A block that
 * still parses into more than one node comes back wrapped in a `<div>`, so its
 * text is kept and the count matches.
 */
function parseBlock(doc: Document, html: string): HTMLElement {
  const body = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html').body
  body.querySelectorAll('script').forEach((s) => s.remove())
  const nodes = Array.from(body.childNodes).filter((n) => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? '').trim() !== '')
  let source: Element
  if (nodes.length === 1 && nodes[0]!.nodeType === Node.ELEMENT_NODE) source = nodes[0] as Element
  else {
    source = body.ownerDocument.createElement('div')
    source.append(...nodes)
  }
  const node = doc.importNode(source, true) as HTMLElement
  for (const el of [node, ...Array.from(node.querySelectorAll('*'))]) stripEventHandlers(el)
  return node
}

function parseBlocks(doc: Document, htmls: string[]): HTMLElement[] {
  return htmls.map((h) => parseBlock(doc, h))
}

function setRestoredSelection(root: HTMLElement, sel: NonNullable<Snapshot['selection']>): void {
  const n = root.children.length
  if (n === 0) return
  const point = (p: BlockPos) => {
    const el = root.children[Math.max(0, Math.min(p.block, n - 1))] as HTMLElement
    return pointFromPath(el, p) ?? pointInBlock(el, Math.max(0, p.offset))
  }
  const s = point(sel.start)
  const e = point(sel.end)
  const live = root.ownerDocument.getSelection()
  if (!live) return
  // setBaseAndExtent keeps the direction: Shift+Arrow after an undo extends from the end the user moved.
  if (sel.backward) live.setBaseAndExtent(e.node, e.offset, s.node, s.offset)
  else live.setBaseAndExtent(s.node, s.offset, e.node, e.offset)
}

/**
 * Puts the user back where `target` was: its selection (when it has one) and
 * scrollTop. restoreSnapshot calls it; the undo stack calls it again after
 * the editor's post-restore passes, which can change heights and re-home the
 * caret.
 */
export function applyView(root: HTMLElement, target: Snapshot): void {
  if (target.selection) setRestoredSelection(root, target.selection)
  root.scrollTop = target.scrollTop
}

/**
 * Makes the live document match `target`: blocks shared at the start and end
 * (by stored string) keep their nodes, only the middle is replaced. Restores
 * the selection and scrollTop. Returns the newly inserted top-level elements
 * (empty when nothing was inserted), for the editor's post-restore passes;
 * the elements taken out are pushed onto `removed` when given (their view
 * state, such as a collapsed code block, is not part of a snapshot).
 */
export function restoreSnapshot(root: HTMLElement, target: Snapshot, removed?: HTMLElement[]): HTMLElement[] {
  const current = blocksOf(root)
  const want = target.blocks
  const limit = Math.min(current.length, want.length)
  let prefix = 0
  while (prefix < limit && current[prefix] === want[prefix]) prefix++
  let suffix = 0
  while (suffix < limit - prefix && current[current.length - 1 - suffix] === want[want.length - 1 - suffix]) suffix++

  const kids = Array.from(root.children)
  const ref: Element | null = kids[current.length - suffix] ?? null
  for (const old of kids.slice(prefix, current.length - suffix)) {
    old.remove()
    removed?.push(old as HTMLElement)
  }
  const added = parseBlocks(root.ownerDocument, want.slice(prefix, want.length - suffix))
  for (const el of added) root.insertBefore(el, ref)

  applyView(root, target)
  return added
}
