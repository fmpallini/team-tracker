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
  // The cascade on <html>: `:root` always matches, so its tokens (the derived ones included) sit under the theme's and the palette's.
  const root = blocks.get(':root, [data-theme=light]')!
  const base = m[2] === 'dark' ? { ...root, ...blocks.get('[data-theme=dark]')! } : root
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

// The due badge of a team with nothing overdue is a solid --brass pill (.tt-team-due-badge.soon).
test.each(pairs)('$name: --on-brass reads on the --brass due-soon badge (AA 4.5:1)', ({ tokens }) => {
  expect(contrast(resolve(tokens, 'on-brass'), tokens.brass!)).toBeGreaterThanOrEqual(4.5)
})

// color-mix(in srgb, a p%, b): a channel-wise blend of the gamma-encoded values — what the stylesheet's recipes compute.
const mix = (a: string, b: string, p: number): string => {
  const rgb = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
  const [x, y] = [rgb(a), rgb(b)]
  return '#' + x.map((v, i) => Math.round(v * p + y[i]! * (1 - p)).toString(16).padStart(2, '0')).join('')
}
/** A token's color, evaluating the derived ones the stylesheet declares as `color-mix(in srgb, var(--a) P%, var(--b))`. */
const color = (t: Tokens, key: string): string => {
  const v = t[key]
  if (v === undefined) throw new Error(`no --${key}`)
  const m = /^color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--([\w-]+)\)\)$/.exec(v)
  if (m) return mix(color(t, m[1]!), color(t, m[3]!), Number(m[2]) / 100)
  const ref = /^var\(--([\w-]+)\)$/.exec(v)
  return ref ? color(t, ref[1]!) : v
}
const CARDS = ['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'] as const
// Every surface plain text lands on: the page, panels, and the kanban column wash (.tt-kanban-col).
const plainSurfaces = (t: Tokens): Record<string, string> => ({ bg: t.bg!, panel: t.panel!, column: mix(t.fg!, t.bg!, 0.05) })
// A task card's band: its color at 15% over --panel (.tt-kanban-card-band).
const band = (t: Tokens, c: (typeof CARDS)[number]): string => mix(t[`card-${c}`]!, t.panel!, 0.15)

test.each(pairs)('$name: --muted and --accent read as text on every plain surface (AA 4.5:1)', ({ tokens }) => {
  for (const [name, surface] of Object.entries(plainSurfaces(tokens))) {
    expect(contrast(tokens.muted!, surface), `--muted on ${name}`).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens.accent!, surface), `--accent on ${name}`).toBeGreaterThanOrEqual(4.5)
  }
})

// Status colors set as text go through --brass-text / --danger-text / --ok-text: on plain surfaces, and on the tints
// they head (the save pill's states, the error box, the risk close button's hover wash).
test.each(pairs)('$name: the status text tokens read on plain surfaces and on their own tints (AA 4.5:1)', ({ tokens }) => {
  const tints: Record<string, number[]> = { brass: [0.14], danger: [0.14, 0.1], ok: [0.12, 0.14] }
  for (const [tok, shares] of Object.entries(tints)) {
    const text = color(tokens, `${tok}-text`)
    for (const [name, surface] of Object.entries(plainSurfaces(tokens))) {
      expect(contrast(text, surface), `--${tok}-text on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
    for (const share of shares) {
      expect(contrast(text, mix(tokens[tok]!, tokens.panel!, share)), `--${tok}-text on its ${share * 100}% tint`).toBeGreaterThanOrEqual(4.5)
    }
  }
})

// Icons carrying meaning (module kinds, due/flag marks, mention glyphs): 3:1 on plain surfaces (WCAG 1.4.11).
test.each(pairs)('$name: status and card icon colors read on plain surfaces (3:1)', ({ tokens }) => {
  for (const tok of ['brass-icon', 'card-brass-icon', 'card-sage-icon', 'danger', 'ok', 'accent', 'card-slate', 'card-plum']) {
    for (const [name, surface] of Object.entries(plainSurfaces(tokens))) {
      expect(contrast(color(tokens, tok), surface), `--${tok} on ${name}`).toBeGreaterThanOrEqual(3)
    }
  }
})

// The band's own text is --muted pulled 20% toward --fg; its tag is the card color at 55% with --fg (styles.css,
// .tt-kanban-card-band / .tt-kanban-card-tag — rules, not tokens, so the shares are mirrored here).
test.each(pairs)("$name: a task card band's text and tag read on its tint, in every card color (AA 4.5:1)", ({ tokens }) => {
  for (const c of CARDS) {
    expect(contrast(mix(tokens.muted!, tokens.fg!, 0.8), band(tokens, c)), `band text on ${c}`).toBeGreaterThanOrEqual(4.5)
    expect(contrast(mix(tokens[`card-${c}`]!, tokens.fg!, 0.55), band(tokens, c)), `tag on ${c}`).toBeGreaterThanOrEqual(4.5)
  }
})

test('covers the default plus all 11 palettes, both themes', () => {
  expect(pairs.length).toBe(24)
})
