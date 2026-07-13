const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  let out = esc(s)
  // refs primeiro (labels não contêm ]): @[label](person:ID) | @[label](day:date)
  out = out.replace(/@\[([^\]]+)\]\((person:[^)\s]+|day:\d{4}-\d{2}-\d{2})\)/g,
    (_, label, ref) => `<a class="ref" data-ref="${ref}" contenteditable="false">@${label}</a>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  out = out.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
  return out
}

export function mdToHtml(md: string): string {
  const lines = md.split('\n'); const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const line of lines) {
    const h = /^(#{1,3}) (.*)$/.exec(line)
    const ul = /^- (.*)$/.exec(line)
    const ol = /^(\d+)\. (.*)$/.exec(line)
    if (h) { closeList(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`) }
    else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' } out.push(`<li>${inline(ul[1]!)}</li>`) }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' } out.push(`<li value="${ol[1]}">${inline(ol[2]!)}</li>`) }
    else { closeList(); out.push(`<div>${line ? inline(line) : '<br>'}</div>`) }
  }
  closeList(); return out.join('')
}

export interface RefInfo { label: string; target: { kind: 'person'; id: string } | { kind: 'day'; date: string } }
export function parseRef(href: string): RefInfo['target'] | null {
  if (href.startsWith('person:')) return { kind: 'person', id: href.slice(7) }
  const m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(href)
  return m ? { kind: 'day', date: m[1]! } : null
}

function inlineMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
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
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
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
