import { REF_KINDS, refPattern, type IdRefKind } from './refs'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type LabelResolver = (target: RefInfo['target']) => string | null

const REF_PATTERN = refPattern()
const DAY_TARGET = new RegExp(`^${REF_KINDS.day.targetPattern}$`)

/** Max list nesting depth (0-indexed) — depths 0-3 = 4 levels. Shared with src/ui/editor.ts's Tab/Shift+Tab nest/promote logic so both sides agree on the cap. */
export const MAX_LIST_DEPTH = 3

// Delimiters for inline()'s ref-chip placeholder tokens — two Private Use
// Area code points (U+E000/U+E001) no markdown/HTML syntax below ever
// matches, and that esc() never produces from `&`/`<`/`>`/`"`, so none of
// the bold/italic/strike/tilde/underline passes below can ever match into,
// or split, a token.
const REF_OPEN = ''
const REF_CLOSE = ''
const REF_PLACEHOLDER = /(\d+)/g

function inline(s: string, resolveLabel?: LabelResolver, refTitle?: string): string {
  let out = esc(s)
  // refs primeiro (labels não contêm ]): @[label](person:ID) | @[label](day:date) | @[label](action:ID) | @[label](milestone:ID) | @[label](risk:ID)
  //
  // Each match is extracted into a placeholder token here; the actual
  // <a data-ref="${ref}"> markup is spliced back in only as the LAST step
  // below, after every other substitution in this function has already run.
  // Building the <a> tag directly at this point (as this used to do) isn't
  // safe: the substitutions further down re-scan the *entire* string,
  // including whatever this pass already emitted — and the single-tilde
  // marker's own template (`class="tt-unlinked-ref"`) contains a literal,
  // unescaped `"`. A ref value containing `~x~` — reachable through
  // ui/editor.ts's clipboard paste, either via a crafted `data-ref`
  // attribute or, since this function has no way to tell the two apart,
  // via plain `@[label](kind:x~y~z)`-shaped *text* in the pasted HTML —
  // would let that injected `"` land inside the still-open
  // `data-ref="..."` attribute and break out of it, even though `esc(s)`
  // above already neutralizes any quote that was in the *original* text.
  // Deferring the real HTML to the last step closes both paths at once:
  // there is no longer a "later pass" left to corrupt it.
  const refChips: string[] = []
  out = out.replace(REF_PATTERN, (_, label: string, ref: string) => {
    const target = resolveLabel ? parseRef(ref) : null
    const resolved = target ? resolveLabel!(target) : null
    const shown = resolved !== null ? esc(resolved) : label
    const titleAttr = refTitle ? ` title="${esc(refTitle)}"` : ''
    refChips.push(`<a class="ref" data-ref="${ref}" contenteditable="false"${titleAttr}>@${shown}</a>`)
    return `${REF_OPEN}${refChips.length - 1}${REF_CLOSE}`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  // Former @-mention left behind by refs.ts's unlink-on-delete — single
  // tilde, distinct from the double-tilde strike rule just above (which has
  // already consumed every `~~...~~` pair by this point, so only genuine
  // single-tilde spans remain to match here).
  out = out.replace(/~([^~]+)~/g, '<span class="tt-unlinked-ref">$1</span>')
  out = out.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
  // Falls back to the literal match (not e.g. an empty string) on an index
  // with no corresponding chip — unreachable through normal input, since
  // every token this function itself ever produces has one, but input text
  // could in principle already contain a literal U+E000/U+E001 pair typed
  // or pasted from elsewhere; leaving it as-is is the safe, inert default.
  out = out.replace(REF_PLACEHOLDER, (m, i: string) => refChips[Number(i)] ?? m)
  return out
}

// A plain space at the very end of a block is CSS-collapsed to zero width,
// so after a line like "**Label:** " Chrome resolves an end-of-line click to
// a caret INSIDE the <strong> and typing sticks to bold (every template line
// shaped "**Label:** " hit this). A trailing &nbsp; keeps a real, visible
// caret slot after the formatting; htmlToMd normalizes it back to a regular
// space so documents never accumulate U+00A0.
const blockInline = (s: string, resolveLabel?: LabelResolver, refTitle?: string) =>
  inline(s, resolveLabel, refTitle).replace(/ $/, '&nbsp;')

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

export function mdToHtml(md: string, resolveLabel?: LabelResolver, refTitle?: string): string {
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
    const hr = /^-{3,}$/.test(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel, refTitle)}</h${h[1]!.length}>`) }
    else if (ul) addListItem(Math.floor(ul[1]!.length / 2), 'ul', blockInline(preserveIndent(ul[2]!), resolveLabel, refTitle), '')
    else if (ol) addListItem(Math.floor(ol[1]!.length / 2), 'ol', blockInline(preserveIndent(ol[3]!), resolveLabel, refTitle), ` value="${ol[2]}"`)
    else if (hr) { closeList(); out.push('<hr>') }
    else { closeList(); out.push(`<div>${line ? blockInline(preserveIndent(line), resolveLabel, refTitle) : '<br>'}</div>`) }
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

/**
 * Reads a CSS `font-weight` and reports whether it means bold — `null` when
 * the element has no `font-weight` set at all (i.e. defer to the tag), as
 * opposed to `false` for an *explicit* non-bold value, which must override
 * the tag (see inlineMd's doc comment for why that distinction matters).
 */
function styleBold(el: HTMLElement): boolean | null {
  const fw = el.style.fontWeight
  if (fw === '') return null
  if (fw === 'bold' || fw === 'bolder') return true
  if (fw === 'normal' || fw === 'lighter') return false
  const n = Number(fw)
  return Number.isNaN(n) ? null : n >= 600
}

/** Same null-means-"no opinion" contract as styleBold, for `font-style`. */
function styleItalic(el: HTMLElement): boolean | null {
  const fs = el.style.fontStyle
  if (fs === '') return null
  return fs === 'italic' || fs === 'oblique'
}

/** Same null-means-"no opinion" contract as styleBold, for one `text-decoration-line` keyword (`underline` or `line-through`). */
function styleHasDecoration(el: HTMLElement, line: 'underline' | 'line-through'): boolean | null {
  const td = el.style.textDecorationLine || el.style.textDecoration
  if (!td) return null
  if (td === 'none') return false
  return td.includes(line)
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
  if (tag === 'br') return ''
  // Without this case, the generic handling below would unwrap the span and
  // drop the marker entirely — re-rendering a note through the rich editor
  // (even untouched) would silently flatten it back to bare text.
  if (tag === 'span' && node.classList.contains('tt-unlinked-ref')) return `~${kids()}~`
  // Inert on the page (never executes here — see ui/editor.ts's paste doc
  // comment on DOMParser) but its text content would otherwise leak into
  // the note as visible text via the generic handling below.
  if (tag === 'script' || tag === 'style') return ''

  // Formatting is tag-based by default (b/strong => bold, etc.) but an
  // *explicit* inline style always overrides the tag — needed for clipboard
  // HTML from apps that represent real inline formatting via `style=`
  // rather than semantic tags (Google Docs' inline bold is
  // `<span style="font-weight:700">`, not `<strong>`), and for apps that
  // reuse a formatting tag as a plain, non-formatting wrapper (Docs wraps
  // its *entire* clipboard export in `<b style="font-weight:normal">`,
  // which would otherwise bold the whole paste). `??`, not `||`: an
  // explicit `false` (the override case) must not fall through to the tag
  // default the way `false || tagDefault` would.
  const bold = styleBold(node) ?? (tag === 'strong' || tag === 'b')
  const italic = styleItalic(node) ?? (tag === 'em' || tag === 'i')
  const underline = styleHasDecoration(node, 'underline') ?? tag === 'u'
  const strike = styleHasDecoration(node, 'line-through') ?? (tag === 's' || tag === 'strike' || tag === 'del')

  let out = kids()
  if (bold) out = `**${out}**`
  if (italic) out = `*${out}*`
  if (underline) out = `<u>${out}</u>`
  if (strike) out = `~~${out}~~`
  return out
}

// Splits `nodes` at <br> boundaries into per-line node arrays. A <br>
// doesn't have to be a direct child of `nodes` to mark a line boundary —
// bolding/italicizing a multi-line selection makes the browser wrap the
// whole run (including the <br>) in a single <b>/<i> etc. — so this recurses
// into any child that still contains a <br>, splitting it into per-line
// clones of that same wrapper (an empty resulting line is dropped, matching
// a trailing top-level <br> producing no extra empty segment). Deep-clones
// `nodes` up front so moving pieces into new per-line wrappers never
// detaches anything from the live editor DOM.
//
// The overwhelmingly common case is a block with no <br> at all (a single
// line): nothing is ever moved into a wrapper, so the deep-clone is pure
// waste on every getMd()/htmlToPlainText() call. Detect that up front and
// hand the original nodes straight back — every caller only *reads* them
// (inlineMd/inlineText), never mutates.
function nodeRunHasBr(nodes: Node[]): boolean {
  return nodes.some(
    (n) => n instanceof HTMLElement && (n.tagName.toLowerCase() === 'br' || n.querySelector('br') !== null)
  )
}

function segmentsToLineNodes(nodes: Node[]): Node[][] {
  if (!nodeRunHasBr(nodes)) return [nodes]
  const segments: Node[][] = [[]]
  nodes.map(n => n.cloneNode(true)).forEach(node => {
    if (node instanceof HTMLElement && node.tagName.toLowerCase() === 'br') {
      segments.push([])
    } else if (node instanceof HTMLElement && node.querySelector('br')) {
      segmentsToLineNodes(Array.from(node.childNodes)).forEach((sub, i) => {
        if (i > 0) segments.push([])
        if (sub.length > 0) {
          const wrapper = node.cloneNode(false) as HTMLElement
          sub.forEach(n => wrapper.appendChild(n))
          segments[segments.length - 1]!.push(wrapper)
        }
      })
    } else {
      segments[segments.length - 1]!.push(node)
    }
  })
  if (segments.length > 1 && segments[segments.length - 1]!.length === 0) segments.pop()
  return segments
}

// Renders each <br>-split line with `render` and joins with '\n' — shared by
// blockToMdNodes (markdown output) and blockToTextNodes (plain-text output),
// which differ only in which renderer they pass.
function segmentsToLines(nodes: Node[], render: (n: Node) => string): string {
  return segmentsToLineNodes(nodes).map(seg => seg.map(render).join('')).join('\n')
}

function blockToMdNodes(nodes: Node[]): string {
  return segmentsToLines(nodes, inlineMd)
}

// An <li>'s nested <ul>/<ol> sub-list(s), rendered separately from the
// item's own text by both renderListMd and renderListText. Not necessarily a
// *direct* child — real contenteditable editing at deep nesting (Chrome
// restructuring on Enter/Backspace merges inside a multi-level list) can
// land the sub-list a level or two down, wrapped in a stray <div>/<p>. This
// walks through any such wrapper, stopping (without descending further) as
// soon as it finds a ul/ol, so a sub-list one wrapper deep is still found as
// this item's own nested list rather than silently flattened into its text.
function nestedListsOf(li: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = []
  const search = (node: Element) => {
    Array.from(node.children).forEach(child => {
      if (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol') found.push(child as HTMLElement)
      else search(child)
    })
  }
  search(li)
  return found
}

// An <li>'s own content nodes with every nested <ul>/<ol> (however deep,
// however wrapped) stripped out — what's left is exactly what belongs on
// this item's own line. Works on a deep clone so stripping never touches
// the live editor DOM the nodes came from.
function liOwnContentNodes(li: HTMLElement): Node[] {
  const clone = li.cloneNode(true) as HTMLElement
  clone.querySelectorAll('ul, ol').forEach(list => list.remove())
  return Array.from(clone.childNodes)
}

// Splits a block element's children at <br> boundaries and joins each
// segment's rendered markdown with '\n', so soft line breaks survive the
// html -> markdown conversion. A trailing <br> produces no extra empty line.
function blockToMd(node: HTMLElement): string {
  return blockToMdNodes(Array.from(node.childNodes))
}

// Block-level tags htmlToMd's top-level walker recognizes as direct
// children of its root. Also used by unwrapBlockContainers below to
// detect a non-block wrapper that needs splitting.
export const BLOCK_TAGS = new Set(['div', 'p', 'ul', 'ol', 'h1', 'h2', 'h3', 'hr', 'table'])

function isBlockTag(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName.toLowerCase())
}

/**
 * Some real-world clipboard sources wrap an entire multi-paragraph paste in
 * a single non-block "container" element — most notably Google Docs, whose
 * whole export is `<b style="font-weight:normal" id="docs-internal-guid-
 * ...">` around every paragraph. htmlToMd's top-level walker only
 * recognizes block tags (BLOCK_TAGS) as *direct* children of its root, so a
 * block buried one level inside such a wrapper is invisible to it: its
 * paragraphs collapse into one run-on inline blob instead of separate
 * lines, and whatever formatting the wrapper carries (bold, in Docs' case
 * reliably cancelled via `font-weight:normal`, but potentially real for
 * other sources) ends up applied — or, worse, incorrectly applied — to
 * that whole blob at once instead of scoped per-paragraph.
 *
 * Called on ui/editor.ts's parsed clipboard fragment before htmlToMd runs.
 * Repeatedly replaces any element whose children are *entirely* block-level
 * (deliberately narrow — a wrapper mixing inline and block content is left
 * alone, since there's no single sane way to split it without more
 * context) with clones of those block children, each one's own content
 * re-wrapped in a shallow clone of the removed wrapper — so real
 * formatting the wrapper carried is preserved and correctly scoped to each
 * block individually, while a wrapper that (like Docs') carries none
 * simply disappears.
 */
// Elements that already have their own correct, structure-aware handling
// elsewhere in this file (a <ul>/<ol>'s <li> nesting another <ul>/<ol>;
// a <table>'s <td>/<th> wrapping a <p>) and must never be treated as a
// generic wrapper to dissolve, even though their children happen to all
// be block-level tags too.
const STRUCTURAL_CONTAINERS = new Set(['li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot'])

export function unwrapBlockContainers(root: HTMLElement): void {
  for (;;) {
    const wrapper = Array.from(root.querySelectorAll<HTMLElement>('*')).find(
      (el) =>
        !isBlockTag(el) &&
        !STRUCTURAL_CONTAINERS.has(el.tagName.toLowerCase()) &&
        el.children.length > 0 &&
        Array.from(el.children).every(isBlockTag)
    )
    if (!wrapper) return
    const blocks = Array.from(wrapper.children) as HTMLElement[]
    for (const block of blocks) {
      const shell = wrapper.cloneNode(false) as HTMLElement
      while (block.firstChild) shell.appendChild(block.firstChild)
      block.appendChild(shell)
    }
    wrapper.replaceWith(...blocks)
  }
}

/**
 * Renders one <tr>'s <td>/<th> cells, joined with " | " — this app's
 * markdown dialect has no native table syntax, so a pasted table becomes
 * readable delimited text rather than a real (re-parseable) table. Each
 * cell's own block content (a table cell can itself contain <p>/<div>/
 * <br>) is flattened to one line so a multi-line cell can't split its row
 * into extra lines.
 */
function renderTableRowMd(tr: HTMLElement): string {
  return Array.from(tr.children)
    .filter((c): c is HTMLElement => c.tagName === 'TD' || c.tagName === 'TH')
    .map((c) => blockToMdNodes(Array.from(c.childNodes)).replace(/\n/g, ' '))
    .join(' | ')
}

/** Renders every row of a <table> (regardless of <thead>/<tbody>/<tfoot> nesting) as one line each. */
function renderTableMd(table: HTMLElement, out: string[]): void {
  table.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr')
    .forEach((tr) => out.push(renderTableRowMd(tr as HTMLElement)))
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
    const text = blockToMdNodes(liOwnContentNodes(child))
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
// parent's, indenting 2 spaces per depth level (same convention as
// renderListMd's markdown indent) so nesting survives the copy instead of
// flattening every level to the same column.
function renderListText(list: HTMLElement, out: string[], depth = 0): void {
  const prefix = '  '.repeat(depth)
  Array.from(list.children).forEach(child => {
    if (!(child instanceof HTMLElement) || child.tagName.toLowerCase() !== 'li') return
    const nestedLists = nestedListsOf(child)
    const text = blockToTextNodes(liOwnContentNodes(child))
    out.push(text.split('\n').map(line => prefix + line).join('\n'))
    nestedLists.forEach(nested => renderListText(nested, out, depth + 1))
  })
}

/** Renders the editor's rendered text with block/list-item/<br> boundaries preserved as '\n' — unlike Element.textContent, which flattens all block structure. Used for "copy without formatting" so paragraphs and list items don't run together on one line. */
export function htmlToPlainText(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent; if (t) out.push(t); return
    }
    // Non-text, non-element nodes — chiefly the <!--StartFragment-->/
    // <!--EndFragment--> comment markers Windows' clipboard HTML format
    // (CF_HTML) wraps around a partial selection — carry no real content.
    // Comment.textContent is the comment's own string, so without this
    // guard "StartFragment" would leak into the output as if it were text.
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') renderListText(node, out)
    else if (tag === 'hr') out.push('---')
    else if (/^h[1-3]$/.test(tag) || tag === 'div' || tag === 'p') out.push(blockToText(node))
    else out.push(inlineText(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}

export function htmlToMd(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim(); if (t) out.push(t); return
    }
    // See htmlToPlainText's identical guard above: skips comment nodes
    // (notably CF_HTML's StartFragment/EndFragment markers) instead of
    // reading Comment.textContent as if it were real text.
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName.toLowerCase()
    if (/^h[1-3]$/.test(tag)) out.push('#'.repeat(Number(tag[1])) + ' ' + blockToMd(node))
    else if (tag === 'ul' || tag === 'ol') renderListMd(node, 0, out)
    else if (tag === 'hr') out.push('---')
    else if (tag === 'table') renderTableMd(node, out)
    else if (tag === 'div' || tag === 'p') out.push(blockToMd(node))
    else out.push(inlineMd(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
