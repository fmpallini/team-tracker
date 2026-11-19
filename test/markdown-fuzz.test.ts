// Seeded fuzz over the markdown <-> editor-DOM codec. Fixed seeds, so a failure
// reproduces from the message alone (seed, case index and the input).
import { mdToHtml, htmlToMd } from '../src/core/markdown'
import { makeRng } from './search-fixture'

const ch = (...c: number[]): string => String.fromCharCode(...c)
const NL = ch(10)
const TOKENS = [
  'a', 'b', 'word', ' ', ' ', '  ', ch(9), NL, NL, NL + NL,
  '**', '*', '_', '__', '~~', '~', '`', '```', '````', '++', '==',
  '# ', '## ', '### ', '#### ', '- ', '* ', '+ ', '1. ', '2) ', '> ', '>> ', '---', '***', '___',
  '[', ']', '(', ')', '[t](http://a.b/c)', '[x](javascript:alert(1))', 'http://x.y/a_b*c', 'mailto:a@b.c',
  '@[Ana](person:p1)', '(person:p1)', '[d](day:2026-01-02)', '[r](risk:r-1)',
  '\\', '\\*', '<', '>', '&', '&amp;', '"', "'", '<b>', '</b>', '<script>x</script>', '<img src=x onerror=1>',
  ch(0xe9), 'ca' + ch(0xe7) + ch(0xe3) + 'o', ch(0xd83d, 0xde00), ch(0x200b), ch(0xa0), ch(0x202e),
  '|', '| a | b |', '- [ ] ', '- [x] ', '    ', '1.', '#', '-',
  `![x](img:${'a'.repeat(32)})`, NL + `![y](img:${'b'.repeat(32)})` + NL,
]
const gen = (rnd: () => number, n: number): string => {
  let s = ''
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(rnd() * TOKENS.length)]
  return s
}
const toDom = (md: string): HTMLElement => {
  const d = document.createElement('div')
  d.innerHTML = mdToHtml(md, () => 'Label')
  return d
}
const save = (md: string): string => htmlToMd(toDom(md))
const norm = (s: string): string => s.split(ch(0xa0)).join(' ').replace(/\s+/g, ' ').trim()
const ALLOWED_TAGS = new Set(['DIV', 'BR', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'U', 'S', 'PRE', 'BLOCKQUOTE', 'HR', 'A', 'SPAN'])

test('random literal text in any block position survives save/reopen', () => {
  const seed = 999
  const rnd = makeRng(seed)
  const positions = ['div', 'li', 'h2', 'blockquote'] as const
  for (let i = 0; i < 1500; i++) {
    const text = gen(rnd, 1 + Math.floor(rnd() * 10)).split(NL).join(' ')
    const position = positions[i % positions.length]!
    const root = document.createElement('div')
    const host = position === 'li' ? root.appendChild(document.createElement('ul')) : root
    host.appendChild(document.createElement(position)).textContent = text
    const back = toDom(htmlToMd(root))
    expect(norm(back.textContent ?? ''), `seed ${seed} case ${i} ${position}: ${JSON.stringify(text)}`).toBe(norm(text))
  }
})

test('normalization is idempotent: a second save never changes the markdown again', () => {
  const seed = 12345
  const rnd = makeRng(seed)
  for (let i = 0; i < 1500; i++) {
    const md = gen(rnd, 1 + Math.floor(rnd() * 30))
    const first = save(md)
    expect(save(first), `seed ${seed} case ${i}: ${JSON.stringify(md)}`).toBe(first)
  }
})

// What a reader sees of one character: its text plus every inline format it is under.
const FORMAT_OF: Record<string, string> = { STRONG: 'B', B: 'B', EM: 'I', I: 'I', U: 'U', S: 'S', STRIKE: 'S', DEL: 'S', A: 'A' }
function visibleChars(root: HTMLElement): string[] {
  const out: string[] = []
  const walk = (n: Node, fmt: ReadonlySet<string>): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      for (const c of (n.textContent ?? '').split(ch(0xa0)).join(' ')) out.push(c === ' ' ? ' ' : `${c}:${[...fmt].sort().join('')}`)
      return
    }
    if (!(n instanceof HTMLElement)) return
    const f = FORMAT_OF[n.tagName]
    const next = f ? new Set([...fmt, f]) : fmt
    n.childNodes.forEach((k) => walk(k, next))
  }
  walk(root, new Set())
  // Edge whitespace of a run moves outside its markers on save (mark()), so a space only counts as a space;
  // runs of spaces and the line's own edges are not compared.
  while (out[0] === ' ') out.shift()
  while (out[out.length - 1] === ' ') out.pop()
  return out.filter((c, i) => c !== ' ' || out[i - 1] !== ' ')
}

const FORMAT_TAGS = ['strong', 'em', 'u', 's', 'a'] as const
type FormatTag = (typeof FORMAT_TAGS)[number]
// Text that includes markdown-significant characters, an nbsp and a backslash.
const RUN_TEXTS = ['one', 'two', 'x', ' ', 'a b', '2*3', '*', '**', '~', '_y_', '[k]', '(p)', '#', '- ', '1. ', ch(92), 'é', '`c`', ch(0xa0)]

/**
 * Random nested inline formatting (each format at most once on a path, like the editor's own DOM), saved and
 * reopened. Returns the cases where a character came back under different formats, or where saving the reopened
 * note changed it again. (The first save may still differ from the second in how a backslash is escaped — that
 * depends on how the text was split into DOM text nodes — but it shows the same and settles at once.)
 */
function formattedRoundTripFailures(seed: number, cases: number, tags: readonly FormatTag[], wordBoundaries: boolean, texts: readonly string[] = RUN_TEXTS): string[] {
  const rnd = makeRng(seed)
  const build = (parent: HTMLElement, depth: number, used: ReadonlySet<FormatTag>): void => {
    const n = 1 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) {
      if (wordBoundaries && i > 0) parent.appendChild(document.createTextNode(' '))
      const free = tags.filter((t) => !used.has(t))
      if (depth < 3 && free.length && rnd() < 0.55) {
        const tag = free[Math.floor(rnd() * free.length)]!
        const el = parent.appendChild(document.createElement(tag))
        if (tag === 'a') el.setAttribute('href', 'https://e.com/x')
        build(el, depth + 1, new Set([...used, tag]))
      } else {
        parent.appendChild(document.createTextNode(texts[Math.floor(rnd() * texts.length)]!))
      }
    }
  }
  const failures: string[] = []
  for (let i = 0; i < cases && failures.length < 5; i++) {
    const root = document.createElement('div')
    build(root.appendChild(document.createElement('div')), 0, new Set())
    const md = htmlToMd(root)
    const back = toDom(md)
    const md2 = htmlToMd(back)
    const want = visibleChars(root).join('|')
    const got = visibleChars(back).join('|')
    if (got !== want || save(md2) !== md2) {
      failures.push(`seed ${seed} case ${i} [${tags.join(',')}]: ${root.innerHTML}\n  md:  ${JSON.stringify(md)}\n  md2: ${JSON.stringify(md2)}\n  want ${want}\n  got  ${got}`)
    }
  }
  return failures
}

// The editor writes the WHOLE note on every edit, so a formatted run that does not survive save → reopen is
// silently rewritten: bold with italic inside reopened as literal `***`, and the next save escaped it for good.

test('any two inline formats other than bold+italic, nested or side by side, even mid-word, survive save/reopen character for character', () => {
  const failures: string[] = []
  FORMAT_TAGS.forEach((a, i) => FORMAT_TAGS.slice(i + 1).forEach((b) => {
    if (a === 'strong' && b === 'em') return
    failures.push(...formattedRoundTripFailures(31 + i, 600, [a, b], false))
  }))
  expect(failures.slice(0, 6).join(NL + NL)).toBe('')
})

// Bold and italic share the `*` marker, so a few glued shapes are ambiguous in markdown itself: an italic part
// touching a bold run's edge followed, with no space, by more italic inside it (`***a*b*c***`) reads its middle
// `*` as closing the outer run. CommonMark has the same limit. These are the mid-word shapes that do round-trip.
test.each([
  ['italic inside a bold word', '<div><strong>re<em>use</em>d</strong></div>'],
  ['bold inside an italic word', '<div><em>re<strong>use</strong>d</em></div>'],
  ['italic at the end of a bold word', '<div><strong>word<em>end</em></strong> x</div>'],
  ['italic at the start of a bold word', '<div><strong><em>start</em>word</strong> x</div>'],
  ['bold then italic, glued', '<div><strong>bold</strong><em>italic</em></div>'],
  ['italic then bold, glued', '<div><em>italic</em><strong>bold</strong></div>'],
  ['bold-italic then bold, glued', '<div><strong><em>both</em></strong><strong>bold</strong></div>'],
  ['bold-italic then italic, glued', '<div><strong><em>both</em></strong><em>italic</em></div>'],
])('mid-word bold/italic: %s', (_name, html) => {
  const root = document.createElement('div')
  root.innerHTML = html
  const md = htmlToMd(root)
  const back = toDom(md)
  expect(visibleChars(back).join('|'), md).toBe(visibleChars(root).join('|'))
  expect(save(htmlToMd(back))).toBe(htmlToMd(back))
})

test('all five inline formats together survive save/reopen when runs meet at word boundaries', () => {
  expect(formattedRoundTripFailures(2026, 3000, FORMAT_TAGS, true).join('\n\n')).toBe('')
})

test('rendered markup stays within the allowlist', () => {
  const seed = 777
  const rnd = makeRng(seed)
  for (let i = 0; i < 1500; i++) {
    const md = gen(rnd, 1 + Math.floor(rnd() * 30))
    for (const el of toDom(md).querySelectorAll('*')) {
      const where = `seed ${seed} case ${i}: ${JSON.stringify(md)}`
      expect(ALLOWED_TAGS.has(el.tagName), `${el.tagName} ${where}`).toBe(true)
      for (const a of Array.from(el.attributes)) {
        expect(/^on/i.test(a.name), `${a.name} ${where}`).toBe(false)
        if (a.name === 'href') expect(/^(https?:|mailto:)/i.test(a.value), `href ${a.value} ${where}`).toBe(true)
      }
    }
  }
})
