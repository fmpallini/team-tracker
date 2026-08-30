import { REF_KINDS, refPattern, type IdRefKind } from './refs'

// Strip the Private-Use-Area code points inline() uses for its own
// LINK/REF/CODE placeholder tokens (U+E000–U+E005) BEFORE anything else, so
// a token spliced into the text — via a crafted link URL, ref target or
// @[label] — is unforgeable rather than merely unlikely. esc() runs on
// every string inline() feeds downstream (the body, and thus the href /
// ref target / code-span content, plus the resolver label and refTitle),
// so this one strip closes every direction at once. The REAL tokens are
// emitted by inline() AFTER esc() using the *_OPEN/*_CLOSE consts, so they
// are untouched.
const esc = (s: string) =>
  s.replace(/[\uE000-\uE005]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:']

/**
 * Returns `raw` (trimmed) when it is a safe external URL to put in an
 * `href`, else `null`. Safe = an explicit `http:` / `https:` / `mailto:`
 * scheme and no ASCII control or whitespace character anywhere (the latter
 * blocks `java	script:` / `java
script:` smuggling, which browsers
 * tolerate in an href). Relative, scheme-relative and fragment-only URLs
 * are rejected: this app has no server, so an in-doc relative link is
 * always a mistake, and rejecting them keeps the allowlist total.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) return null
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url)
  if (!m) return null
  return ALLOWED_SCHEMES.includes(m[1]!.toLowerCase()) ? url : null
}

export type LabelResolver = (target: RefInfo['target']) => string | null

const REF_PATTERN = refPattern()
const DAY_TARGET = new RegExp(`^${REF_KINDS.day.targetPattern}$`)

/** Max list nesting depth (0-indexed) — depths 0-3 = 4 levels. Shared with src/ui/editor.ts's Tab/Shift+Tab nest/promote logic so both sides agree on the cap. */
export const MAX_LIST_DEPTH = 3

// Delimiters for inline()'s ref-chip placeholder tokens — two Private Use
// Area code points (U+E000/U+E001) no markdown/HTML syntax below ever
// matches, and that esc() strips out of its input (U+E000–U+E005) before
// any pass runs — so these tokens are UNFORGEABLE from text, not merely
// unlikely, and none of the bold/italic/strike/tilde/underline passes
// below can ever match into, or split, a token.
const REF_OPEN = ''
const REF_CLOSE = ''
const REF_PLACEHOLDER = /(\d+)/g

// Same PUA rationale as REF_OPEN/REF_CLOSE above: code points no
// markdown/HTML pass below matches and esc() strips from its input, so a
// forged token can't reach here. Code spans are extracted FIRST (before
// refs) so their contents are frozen against every later pass — that
// literalness is the whole point of an inline code span.
const CODE_OPEN = ''
const CODE_CLOSE = ''
const CODE_PLACEHOLDER = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g')

// Same PUA rationale again (U+E004/U+E005). A link is FULLY frozen: the
// mark passes (bold/italic/strike/tilde/underline) run on the link TEXT
// alone inside the link callback, the whole `<a …>…</a>` is assembled
// there, and the entire thing is placeholder-frozen — so no later pass can
// pair a marker inside the link text with one after the closing tag (which
// used to silently rewrite saved markdown on every open/save cycle — spec
// §2.1). esc(s) already ran, so the href carries no raw quote AND no
// forged LINK/REF/CODE placeholder code point (esc() strips U+E000–U+E005)
// — so the terminal REF/CODE passes that run AFTER this link splice cannot
// find a token to resolve inside the frozen href.
const LINK_OPEN = ''
const LINK_CLOSE = ''
const LINK_PLACEHOLDER = new RegExp(`${LINK_OPEN}(\\d+)${LINK_CLOSE}`, 'g')

function inline(s: string, resolveLabel?: LabelResolver, refTitle?: string, linkHint?: string): string {
  let out = esc(s)
  // Code spans first: their content must survive every pass below untouched.
  const codeSpans: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`
  })
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
  // Deferring the real HTML to the last step handles the mark passes (they
  // all run before the terminal splice). The terminal REF/CODE splices DO
  // run after this chip is spliced back, so a forged CODE/LINK placeholder
  // token smuggled into `ref` could otherwise be resolved inside the
  // rebuilt `data-ref="..."` — that direction is closed at the source by
  // esc() stripping U+E000–U+E005 from the input.
  const refChips: string[] = []
  out = out.replace(REF_PATTERN, (_, label: string, ref: string) => {
    const target = resolveLabel ? parseRef(ref) : null
    const resolved = target ? resolveLabel!(target) : null
    const shown = resolved !== null ? esc(resolved) : label
    const titleAttr = refTitle ? ` title="${esc(refTitle)}"` : ''
    refChips.push(`<a class="ref" data-ref="${ref}" contenteditable="false"${titleAttr}>@${shown}</a>`)
    return `${REF_OPEN}${refChips.length - 1}${REF_CLOSE}`
  })
  // The five inline mark passes (bold / italic / strike / former-@-mention
  // single-tilde / escaped <u>). Run on the link TEXT alone inside the link
  // callback below (spec §2.1 step 4), then on the body after links are
  // extracted — so a marker inside link text is never paired with one that
  // sits after the link. The single-tilde pass is distinct from the
  // double-tilde strike rule right above it: strike has already consumed
  // every `~~...~~` pair by the time single-tilde runs, so only genuine
  // single-tilde spans remain.
  const applyMarks = (str: string): string => {
    str = str.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    str = str.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    str = str.replace(/~~([^~]+)~~/g, '<s>$1</s>')
    str = str.replace(/~([^~]+)~/g, '<span class="tt-unlinked-ref">$1</span>')
    str = str.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
    return str
  }
  // Links: format the link text, assemble the whole <a>…</a>, and freeze all
  // of it in one placeholder — no later pass can reach inside or straddle it.
  // esc(s) at the top already turned any `"` in the URL into `&quot;` AND
  // stripped every U+E000–U+E005 code point, so a URL can neither break out
  // of the href attribute nor smuggle a forged REF/CODE placeholder token
  // that the terminal passes below (which run AFTER this splice) would
  // resolve inside the frozen href; safeHref gates the scheme, and a
  // rejected URL drops the <a> and keeps only the visible text (its marks
  // then get applied by the body pass below).
  //
  // Link text is `[^\]]+` (no `]`); the URL is a run of non-paren chars with
  // at most one level of *balanced* `(...)` — so a rejected scheme like
  // `javascript:alert(1)` is consumed whole and degrades to just its text
  // with no orphan `)` left behind. A URL still cannot contain an unbalanced
  // `)` (that closes the link) — a documented boundary.
  const linkTags: string[] = []
  out = out.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/g, (_m, text: string, rawUrl: string) => {
    const href = safeHref(rawUrl)
    if (!href) return text
    // `title` shows the destination on hover (the visible link text is often
    // a label, not the URL). `linkHint`, when supplied by the editor, adds a
    // second line spelling out the Ctrl/middle-click-to-open gesture — a
    // plain click only places the caret so the link text stays editable.
    // href is already safeHref-validated (no control chars, no `"`); esc()
    // covers the hint. htmlToMd ignores `title`, so nothing persists.
    const titleAttr = ` title="${esc(linkHint ? `${href}\n${linkHint}` : href)}"`
    linkTags.push(`<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${applyMarks(text)}</a>`)
    return `${LINK_OPEN}${linkTags.length - 1}${LINK_CLOSE}`
  })
  out = applyMarks(out)
  // Terminal splice order: LINK first, then REF, then CODE. Link text can
  // contain a REF or CODE placeholder token (both are extracted before
  // links), so the <a>…</a> HTML must be spliced back in before those
  // tokens are resolved. Ref-chip and code-span HTML never contain a LINK
  // token, so LINK-first is safe.
  //
  // Each pass falls back to the literal match (not e.g. an empty string) on
  // an index with no corresponding entry. esc() strips U+E000–U+E005 from
  // the input up front, so a well-formed token here is always one this
  // function itself just produced and always has a matching entry; the
  // fallback is a belt-and-braces inert default, not a reachable path.
  out = out.replace(LINK_PLACEHOLDER, (m, i: string) => linkTags[Number(i)] ?? m)
  out = out.replace(REF_PLACEHOLDER, (m, i: string) => refChips[Number(i)] ?? m)
  out = out.replace(CODE_PLACEHOLDER, (m, i: string) => codeSpans[Number(i)] ?? m)
  return out
}

// A plain space at the very end of a block is CSS-collapsed to zero width,
// so after a line like "**Label:** " Chrome resolves an end-of-line click to
// a caret INSIDE the <strong> and typing sticks to bold (every template line
// shaped "**Label:** " hit this). A trailing &nbsp; keeps a real, visible
// caret slot after the formatting; htmlToMd normalizes it back to a regular
// space so documents never accumulate U+00A0.
const blockInline = (s: string, resolveLabel?: LabelResolver, refTitle?: string, linkHint?: string) =>
  inline(s, resolveLabel, refTitle, linkHint).replace(/ $/, '&nbsp;')

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

export function mdToHtml(md: string, resolveLabel?: LabelResolver, refTitle?: string, linkHint?: string): string {
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
  // Flat blockquote (no nesting — like H1–H3): consecutive `> ` lines buffer
  // here and flush as one <blockquote>, inner lines joined by <br>; a bare
  // `>` line contributes an empty inner line, so `> a` / `>` / `> b` becomes
  // `a<br><br>b`. Every non-`>` branch flushes the buffer first, and the
  // blockquote branch itself calls closeList() before buffering, exactly as
  // the heading/hr branches do.
  let bqBuf: string[] | null = null
  const flushBq = () => {
    if (bqBuf === null) return
    const inner = bqBuf
      .map(l => blockInline(preserveIndent(l), resolveLabel, refTitle, linkHint))
      .join('<br>')
    out.push(`<blockquote>${inner}</blockquote>`)
    bqBuf = null
  }
  for (const line of lines) {
    const bq = /^> ?(.*)$/.exec(line)
    if (bq) { closeList(); (bqBuf ??= []).push(bq[1]!); continue }
    flushBq()
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^( *)- (.*)$/.exec(line)
    const ol = /^( *)(\d+)\. (.*)$/.exec(line)
    const hr = /^-{3,}$/.test(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel, refTitle, linkHint)}</h${h[1]!.length}>`) }
    else if (ul) addListItem(Math.floor(ul[1]!.length / 2), 'ul', blockInline(preserveIndent(ul[2]!), resolveLabel, refTitle, linkHint), '')
    else if (ol) addListItem(Math.floor(ol[1]!.length / 2), 'ol', blockInline(preserveIndent(ol[3]!), resolveLabel, refTitle, linkHint), ` value="${ol[2]}"`)
    else if (hr) { closeList(); out.push('<hr>') }
    else { closeList(); out.push(`<div>${line ? blockInline(preserveIndent(line), resolveLabel, refTitle, linkHint) : '<br>'}</div>`) }
  }
  flushBq(); closeList(); return out.join('')
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
  // External link (no data-ref). Re-validate the href through safeHref on the
  // way out — a disallowed scheme drops the <a> and keeps only its text —
  // and strip any [ ] from the link text so it can't reopen the [text](url)
  // grammar on a later re-parse.
  if (tag === 'a' && !node.dataset.ref) {
    const href = safeHref(node.getAttribute('href') ?? '')
    const text = kids().replace(/[[\]]/g, '')
    return href ? `[${text}](${href})` : text
  }
  if (tag === 'br') return ''
  // Literal content, no child recursion — mirrors inline()'s freeze.
  if (tag === 'code') return '`' + (node.textContent ?? '').replace(/\u00a0/g, ' ') + '`'
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
export const BLOCK_TAGS = new Set(['div', 'p', 'ul', 'ol', 'h1', 'h2', 'h3', 'hr', 'table', 'blockquote'])

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
 * `document.execCommand('formatBlock', '<h1>')` on a selection spanning
 * multiple lines, or on a list, makes Chromium NEST a fresh <hN> inside the
 * existing heading instead of replacing it — and every repeat of the same
 * Ctrl+1/2/3 shortcut stacks another wrapper (<h1><h1><h1>…). Because the
 * UA stylesheet sizes headings with a *relative* `2em`, each extra level
 * multiplies the rendered size (32 -> 64 -> 128px…), so the heading appears
 * to grow without bound. The editor calls this right after every
 * formatBlock: any heading nested inside another heading is unwrapped, so
 * repeated presses collapse back to a single heading (the outer one wins).
 *
 * Also dissolves any heading that sits INSIDE an `<li>`: on a list item
 * Chromium wraps the new <hN> inside the item (often nested in a previous
 * <hN>, so `<li><h1><h2>…</h2></h1></li>` after Ctrl+1 then Ctrl+2), and the
 * "outer heading wins" rule above then trapped the item — a level change
 * kept the stale outer heading, and the ¶ button (a <p>/<div> nested in the
 * <h1>) couldn't dislodge it either. A heading on a list item never
 * round-trips anyway (renderListMd flattens it), so it's purely a visual
 * artifact; removing it lets re-formatting and ¶ work on nested list items.
 *
 * Deliberately does NOT touch a top-level heading that wraps a whole
 * list/block — that heading is outside every `<li>`, it's the browser's own
 * (if imperfect) answer to "make this list a heading", and dissolving it
 * would make Ctrl+1 a no-op on a flat list. The companion fixed-rem
 * `.editor h1/h2/h3` sizing keeps even that shape from compounding.
 *
 * Idempotent: a well-formed heading tree is left untouched.
 */
export function flattenNestedHeadings(root: HTMLElement): void {
  const HEADING = 'h1,h2,h3'
  // Bounded loop — each iteration removes one heading element, so it always
  // terminates; the cap is just belt-and-braces against an unforeseen shape.
  for (let pass = 0; pass < 100; pass++) {
    const doomed = Array.from(root.querySelectorAll<HTMLElement>(HEADING)).find(
      (h) => h.parentElement?.closest(HEADING) || h.closest('li')
    )
    if (!doomed) return
    doomed.replaceWith(...doomed.childNodes)
  }
}

/**
 * The editor's ❝ button / Ctrl+Shift+9 route through
 * `execCommand('formatBlock', '<blockquote>')`, which — like the heading
 * case `flattenNestedHeadings` fixes — can NEST a fresh <blockquote> inside
 * an existing one on a repeat press or a multi-line selection. This app's
 * blockquote is flat (no nesting), so any blockquote inside another is
 * unwrapped; repeated presses collapse to one. Idempotent.
 */
export function flattenNestedBlockquotes(root: HTMLElement): void {
  for (let pass = 0; pass < 100; pass++) {
    const nested = Array.from(root.querySelectorAll<HTMLElement>('blockquote')).find(
      (b) => b.parentElement?.closest('blockquote')
    )
    if (!nested) return
    // Bare unwrap is intentional here: `nested` sits inside an enclosing
    // <blockquote>, so its child nodes land in that blockquote, not at the
    // editor root — the "top-level nodes must be block elements" invariant
    // the other unwrap sites guard is not in play.
    nested.replaceWith(...nested.childNodes)
  }
}

/** Standard `Range.intersectsNode` polyfill (jsdom's Range has no such
 * method): true when `range` overlaps any part of `node`. */
function rangeHitsNode(range: Range, node: Node): boolean {
  const nr = (node.ownerDocument ?? document).createRange()
  nr.selectNode(node)
  return (
    range.compareBoundaryPoints(Range.END_TO_START, nr) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nr) > 0
  )
}

/**
 * "Clear formatting" (the editor's 🧹 button) reverts every heading the
 * selection touches back to a plain paragraph — matching Google Docs / Word,
 * where clearing formatting drops the heading style, not just inline
 * bold/italic. `document.execCommand('removeFormat')` only ever touches
 * inline formatting, so without this an <h1>/<h2>/<h3> survives the broom.
 * List nesting is deliberately left alone (removing it isn't what "clear
 * formatting" means in those products either).
 */
export function demoteHeadings(root: HTMLElement, range: Range): void {
  for (const h of Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3'))) {
    if (!rangeHitsNode(range, h)) continue
    const div = (root.ownerDocument ?? document).createElement('div')
    while (h.firstChild) div.appendChild(h.firstChild)
    h.replaceWith(div)
  }
}

/**
 * Companion to demoteHeadings for the editor's 🧹 button: "clear
 * formatting" also drops blockquote styling (Google Docs / Word both do).
 * Unwraps every <blockquote> the selection touches into its own children.
 * List nesting is still left alone, same as demoteHeadings.
 */
export function demoteBlockquotes(root: HTMLElement, range: Range): void {
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('blockquote'))) {
    if (!rangeHitsNode(range, b)) continue
    // Re-wrap the contents in a <div> rather than dumping bare text nodes /
    // <br>s straight into `editorEl` — same as demoteHeadings above. A bare
    // run there breaks the "top-level children are blocks" invariant:
    // `currentBlockAndOffset()` can't resolve a block for those lines, and
    // htmlToMd would emit a spurious blank line between them.
    const div = (root.ownerDocument ?? document).createElement('div')
    while (b.firstChild) div.appendChild(b.firstChild)
    b.replaceWith(div)
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
    if (!(child instanceof HTMLElement)) return
    const childTag = child.tagName.toLowerCase()
    // A sub-list left as a direct child of this list (sibling to the <li>s
    // rather than inside one) — a shape contenteditable editing can produce,
    // same family as nestedListsOf's wrapper cases. Render it one level
    // deeper instead of skipping it, so its items aren't silently dropped.
    if (childTag === 'ul' || childTag === 'ol') { renderListMd(child, depth + 1, out); return }
    if (childTag !== 'li') return
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
    if (!(child instanceof HTMLElement)) return
    const childTag = child.tagName.toLowerCase()
    if (childTag === 'ul' || childTag === 'ol') { renderListText(child, out, depth + 1); return }
    if (childTag !== 'li') return
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
    else if (tag === 'blockquote') {
      // A quote pasted off a web page / email arrives with block children
      // (<blockquote><p>a</p><p>b</p></blockquote>), which blockToText would
      // merge onto one line. Recurse through htmlToPlainText for that shape;
      // the mdToHtml <br>-joined shape (no block child) keeps the flat path.
      const inner = Array.from(node.children).some(isBlockTag) ? htmlToPlainText(node) : blockToText(node)
      for (const l of inner.split('\n')) out.push(l ? `> ${l}` : '>')
    }
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
    else if (tag === 'blockquote') {
      // A quote copied off a web page / email reaches here whole as
      // <blockquote><p>a</p><p>b</p></blockquote> (or <div>-built) — its
      // block children would otherwise be merged onto one run-on line by
      // blockToMd. Recurse through htmlToMd for that shape so each child
      // block keeps its own line. The mdToHtml <br>-joined shape
      // (<blockquote>a<br>b</blockquote> — 'br' is NOT in BLOCK_TAGS) has no
      // block child, so it still takes the blockToMd path and idempotency is
      // preserved.
      const inner = Array.from(node.children).some(isBlockTag) ? htmlToMd(node) : blockToMd(node)
      for (const l of inner.split('\n')) out.push(l ? `> ${l}` : '>')
    }
    else if (tag === 'ul' || tag === 'ol') renderListMd(node, 0, out)
    else if (tag === 'hr') out.push('---')
    else if (tag === 'table') renderTableMd(node, out)
    else if (tag === 'div' || tag === 'p') out.push(blockToMd(node))
    else out.push(inlineMd(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
