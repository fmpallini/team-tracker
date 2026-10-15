import css from '../styles.css?raw'

// Text on a solid --accent / --danger fill (primary button, due badge, selected
// calendar day) uses --on-accent / --on-danger. White failed WCAG AA on every
// dark theme's bright accent, so this guards each palette+theme pair.

type Tokens = Record<string, string>
const blocks = new Map<string, Tokens>()
for (const m of css.matchAll(/^((?::root, )?\[data-(?:theme|palette)[^{]*)\{([^}]*)\}/gm)) {
  const tokens: Tokens = {}
  for (const d of m[2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[d[1]!] = d[2]!.trim()
  blocks.set(m[1]!.trim(), tokens)
}

const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (color: string): number => {
  const hex = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const pairs: { name: string; tokens: Tokens }[] = []
for (const [sel, tokens] of blocks) {
  const m = sel.match(/data-palette=(\w+)\]\[data-theme=(light|dark)/)
  if (!m) continue
  const base = blocks.get(m[2] === 'dark' ? '[data-theme=dark]' : ':root, [data-theme=light]')!
  pairs.push({ name: `${m[1]} ${m[2]}`, tokens: { ...base, ...tokens } })
}
pairs.push({ name: 'ledger light', tokens: blocks.get(':root, [data-theme=light]')! })
pairs.push({ name: 'ledger dark', tokens: { ...blocks.get(':root, [data-theme=light]')!, ...blocks.get('[data-theme=dark]')! } })

const resolve = (t: Tokens, key: string): string => {
  const v = t[key]!
  const ref = v.match(/^var\(--([\w-]+)\)$/)
  return ref ? t[ref[1]!]! : v
}

test.each(pairs)('$name: --on-accent and --on-danger read on their fills (AA 4.5:1)', ({ tokens }) => {
  expect(contrast(resolve(tokens, 'on-accent'), tokens.accent!)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(resolve(tokens, 'on-danger'), tokens.danger!)).toBeGreaterThanOrEqual(4.5)
})

test('covers the default plus all 11 palettes, both themes', () => {
  expect(pairs.length).toBe(24)
})
