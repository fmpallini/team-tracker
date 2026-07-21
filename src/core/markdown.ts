import { REF_KINDS, refPattern, type IdRefKind } from './refs'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type LabelResolver = (target: RefInfo['target']) => string | null

const REF_PATTERN = refPattern()
const DAY_TARGET = new RegExp(`^${REF_KINDS.day.targetPattern}$`)

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
  let list: 'ul' | 'ol' | null = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^- (.*)$/.exec(line)
    const ol = /^(\d+)\. (.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${blockInline(preserveIndent(h[2]!), resolveLabel)}</h${h[1]!.length}>`) }
    else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' } out.push(`<li>${blockInline(preserveIndent(ul[1]!), resolveLabel)}</li>`) }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' } out.push(`<li value="${ol[1]}">${blockInline(preserveIndent(ol[2]!), resolveLabel)}</li>`) }
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

// Splits a block element's children at <br> boundaries and joins each
// segment's rendered markdown with '\n', so soft line breaks survive the
// html -> markdown conversion. A trailing <br> produces no extra empty line.
function blockToMd(node: HTMLElement): string {
  const segments: Node[][] = [[]]
  node.childNodes.forEach(child => {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'br') segments.push([])
    else segments[segments.length - 1]!.push(child)
  })
  if (segments.length > 1 && segments[segments.length - 1]!.length === 0) segments.pop()
  return segments.map(seg => seg.map(inlineMd).join('')).join('\n')
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\u00a0/g, ' ')
  if (!(node instanceof HTMLElement)) return ''
  if (node.tagName.toLowerCase() === 'br') return ''
  return Array.from(node.childNodes).map(inlineText).join('')
}

// Same <br>-segment-splitting shape as blockToMd, but renders visual text
// (no markdown syntax markers) — used for "copy without formatting".
function blockToText(node: HTMLElement): string {
  const segments: Node[][] = [[]]
  node.childNodes.forEach(child => {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'br') segments.push([])
    else segments[segments.length - 1]!.push(child)
  })
  if (segments.length > 1 && segments[segments.length - 1]!.length === 0) segments.pop()
  return segments.map(seg => seg.map(inlineText).join('')).join('\n')
}

/** Renders the editor's rendered text with block/list-item/<br> boundaries preserved as '\n' — unlike Element.textContent, which flattens all block structure. Used for "copy without formatting" so paragraphs and list items don't run together on one line. */
export function htmlToPlainText(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (!(node instanceof HTMLElement)) {
      const t = node.textContent; if (t) out.push(t); return
    }
    const tag = node.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') node.querySelectorAll<HTMLElement>(':scope > li').forEach(li => out.push(blockToText(li)))
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
    else if (tag === 'ul') node.querySelectorAll<HTMLElement>(':scope > li').forEach(li => out.push('- ' + blockToMd(li)))
    else if (tag === 'ol') {
      let i = 0
      node.querySelectorAll<HTMLElement>(':scope > li').forEach(li => {
        const v = li.getAttribute('value')
        i = v ? Number(v) : i + 1
        out.push(`${i}. ` + blockToMd(li))
      })
    }
    else if (tag === 'div' || tag === 'p') out.push(blockToMd(node))
    else out.push(inlineMd(node))
  }
  root.childNodes.forEach(walk)
  return out.join('\n')
}
