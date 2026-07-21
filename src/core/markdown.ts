import { REF_KINDS, refPattern, type IdRefKind } from './refs'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type LabelResolver = (target: RefInfo['target']) => string | null

const REF_PATTERN = refPattern()
const DAY_TARGET = new RegExp(`^${REF_KINDS.day.targetPattern}$`)

/** Max list nesting depth (0-indexed) — depths 0-3 = 4 levels. Shared with src/ui/editor.ts's Tab/Shift+Tab nest/promote logic so both sides agree on the cap. */
export const MAX_LIST_DEPTH = 3

function inline(s: string, resolveLabel?: LabelResolver): string {
  let out = esc(s)
  // refs primeiro (labels não contêm ]): @[label](person:ID) | @[label](day:date) | @[label](action:ID) | @[label](milestone:ID) | @[label](risk:ID)
  out = out.replace(REF_PATTERN, (_, label: string, ref: string) => {
    const target = resolveLabel ? parseRef(ref) : null
    const resolved = target ? resolveLabel!(target) : null
    const shown = resolved !== null ? esc(resolved) : label
    return `<a class="ref" data-ref="${ref}" contenteditable="false">@${shown}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  out = out.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
  return out
}

// A plain space at the very end of a block is CSS-collapsed to zero width,
// so after a line like "**Label:** " Chrome resolves an end-of-line click to
// a caret INSIDE the <strong> and typing sticks to bold (every template line
// shaped "**Label:** " hit this). A trailing &nbsp; keeps a real, visible
// caret slot after the formatting; htmlToMd normalizes it back to a regular
// space so documents never accumulate U+00A0.
const blockInline = (s: string, resolveLabel?: LabelResolver) => inline(s, resolveLabel).replace(/ $/, '&nbsp;')

/**
 * A line's leading run of plain spaces (Tab-inserted indent — see
 * ui/editor.ts) is rendered as non-breaking spaces so it survives the
 * editor's default `white-space: normal` instead of collapsing to one space
 * on re-render. htmlToMd's inlineMd normalizes '\u00a0' straight back to
 * plain spaces on the way out (existing behavior), so storage always stays
 * plain-space text — human-readable, and stable across repeated round trips.
 */
function preserveIndent(s: string): string {
  const m = /^( +)/.exec(s)
  if (!m) return s
  return '\u00a0'.repeat(m[1]!.length) + s.slice(m[1]!.length)
}

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

export interface RefInfo {
  label: string
  target:
    | { kind: 'person'; id: string }
    | { kind: 'day'; date: string }
    | { kind: 'action'; id: string }
    | { kind: 'milestone'; id: string }
    | { kind: 'risk'; id: string }
}
export function parseRef(href: string): RefInfo['target'] | null {
  const sep = href.indexOf(':')
  if (sep < 0) return null
  const kind = href.slice(0, sep)
  if (!(kind in REF_KINDS)) return null
  const target = href.slice(sep + 1)
  if (kind === 'day') return DAY_TARGET.test(target) ? { kind: 'day', date: target } : null
  return { kind: kind as IdRefKind, id: target }
}

function inlineMd(node: Node): string {
  // U+00A0 → ' ': undo mdToHtml's caret-slot &nbsp; (and the nbsp Chrome
  // itself inserts while editing) so markdown only ever stores plain spaces.
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  if (!(node instanceof HTMLElement)) return ''
  const kids = () => Array.from(node.childNodes).map(inlineMd).join('')
  const tag = node.tagName.toLowerCase()
  if (tag === 'a' && node.dataset.ref) {
    const label = (node.textContent ?? '').replace(/^@/, '')
    const safeLabel = label.replace(/[[\]()]/g, '')
    return `@[${safeLabel}](${node.dataset.ref})`
  }
  switch (tag) {
    case 'strong': case 'b': return `**${kids()}**`
    case 'em': case 'i': return `*${kids()}*`
    case 'u': return `<u>${kids()}</u>`
    case 's': case 'strike': case 'del': return `~~${kids()}~~`
    case 'br': return ''
    default: return kids()
  }
}

// Splits `nodes` at <br> boundaries into segments, renders each node with
// `render`, and joins segments with '\n' — shared by blockToMdNodes (markdown
// output) and blockToTextNodes (plain-text output), which differ only in
// which renderer they pass.
function segmentsToLines(nodes: Node[], render: (n: Node) => string): string {
  const segments: Node[][] = [[]]
  nodes.forEach(child => {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'br') segments.push([])
    else segments[segments.length - 1]!.push(child)
  })
  if (segments.length > 1 && segments[segments.length - 1]!.length === 0) segments.pop()
  return segments.map(seg => seg.map(render).join('')).join('\n')
}

function blockToMdNodes(nodes: Node[]): string {
  return segmentsToLines(nodes, inlineMd)
}

// An <li>'s direct <ul>/<ol> children — its nested sub-list, rendered
// separately from the item's own text by both renderListMd and renderListText.
function nestedListsOf(li: HTMLElement): HTMLElement[] {
  return Array.from(li.querySelectorAll(':scope > ul, :scope > ol')) as HTMLElement[]
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
    const nestedLists = nestedListsOf(child)
    const text = blockToMdNodes(Array.from(child.childNodes).filter(n => !nestedLists.includes(n as HTMLElement)))
    if (tag === 'ol') {
      const v = child.getAttribute('value')
      i = v ? Number(v) : i + 1
      out.push(`${prefix}${i}. ${text}`)
    } else {
      out.push(`${prefix}- ${text}`)
    }
    nestedLists.forEach(nested => renderListMd(nested, depth + 1, out))
  })
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  if (!(node instanceof HTMLElement)) return ''
  if (node.tagName.toLowerCase() === 'br') return ''
  return Array.from(node.childNodes).map(inlineText).join('')
}

function blockToTextNodes(nodes: Node[]): string {
  return segmentsToLines(nodes, inlineText)
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
    const nestedLists = nestedListsOf(child)
    out.push(blockToTextNodes(Array.from(child.childNodes).filter(n => !nestedLists.includes(n as HTMLElement))))
    nestedLists.forEach(nested => renderListText(nested, out))
  })
}

/** Renders the editor's rendered text with block/list-item/<br> boundaries preserved as '\n' — unlike Element.textContent, which flattens all block structure. Used for "copy without formatting" so paragraphs and list items don't run together on one line. */
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
