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
