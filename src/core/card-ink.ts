// src/core/card-ink.ts — the tag chips' colors. A chip is a label on a solid
// card color, and the six --card-* colors are mid-tones in most light
// palettes: no one text color reaches WCAG AA on all six (white on light
// brass was ~3.5:1). Flipping the text per chip read as inconsistent, so the
// text stays one color per theme — white on a light page, the page color on a
// dark one — and only a fill that cannot carry it moves: darkened (light) or
// lightened (dark) in its own hue, by the smallest step that reaches 4.5:1.
// Read from the computed style, like theme-color.ts, so every palette x theme
// pair resolves without a copied table. The cards' own tint keeps the raw color.

export const CARD_COLORS = ['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'] as const

const AA = 4.5

function parseHex(color: string): [number, number, number] | null {
  const digits = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (!digits) return null
  const n = parseInt(digits, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * channel(r / 255) + 0.7152 * channel(g / 255) + 0.0722 * channel(b / 255)
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const toHex = (rgb: number[]): string => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/**
 * `fill`, or the nearest shade of it (mixed toward black under a light ink, toward white under a dark one, in 1%
 * steps) that `ink` reads on at AA. Null when either is not a 6-digit hex.
 */
export function chipFill(fill: string, ink: string): string | null {
  const f = parseHex(fill)
  const i = parseHex(ink)
  if (!f || !i) return null
  const toward = luminance(i) > 0.5 ? 0 : 255
  for (let p = 0; p <= 100; p++) {
    const shade = f.map((v) => v + (toward - v) * (p / 100)) as [number, number, number]
    const rounded = shade.map(Math.round) as [number, number, number]
    if (contrast(i, rounded) >= AA) return toHex(rounded)
  }
  return toHex([toward, toward, toward])
}

/** Sets `--on-chip` and each `--chip-<color>` on the root for the active palette x theme; values the stylesheet does not define keep its defaults. */
export function syncCardInk(doc: Document = document): void {
  const root = doc.documentElement
  const style = getComputedStyle(root)
  const bg = parseHex(style.getPropertyValue('--bg'))
  if (!bg) {
    root.style.removeProperty('--on-chip')
    for (const c of CARD_COLORS) root.style.removeProperty(`--chip-${c}`)
    return
  }
  const ink = luminance(bg) > 0.5 ? '#ffffff' : toHex(bg)
  root.style.setProperty('--on-chip', ink)
  for (const c of CARD_COLORS) {
    const fill = chipFill(style.getPropertyValue(`--card-${c}`), ink)
    if (fill) root.style.setProperty(`--chip-${c}`, fill)
    else root.style.removeProperty(`--chip-${c}`)
  }
}
