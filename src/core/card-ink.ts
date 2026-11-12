// src/core/card-ink.ts — text color for labels drawn on a solid card color
// (the task tag chips). The six --card-* colors are mid-tones in most light
// palettes: brass wants dark text and slate wants white, so no single ink per
// palette reaches WCAG AA on all six (white on brass was ~3.5:1 in most light
// palettes, with a text-shadow as the only crutch). Each fill instead gets
// whichever of pure white or pure black contrasts more with it — for any color
// that is at least ~4.58:1. Read from the computed style, like
// theme-color.ts, so every palette x theme pair resolves without a copied table.

export const CARD_COLORS = ['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'] as const

const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

/** `#ffffff` or `#000000`, whichever contrasts more with `fill` (a 6-digit hex); null when `fill` is not one. */
export function inkFor(fill: string): '#ffffff' | '#000000' | null {
  const digits = /^#([0-9a-f]{6})$/i.exec(fill.trim())?.[1]
  if (!digits) return null
  const n = parseInt(digits, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => channel(v / 255)) as [number, number, number]
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // Contrast with white is 1.05 / (lum + .05), with black (lum + .05) / .05: white wins below their crossover.
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#ffffff' : '#000000'
}

/** Sets `--on-card-<color>` on the root for the active palette x theme; colors the stylesheet does not define keep its default. */
export function syncCardInk(doc: Document = document): void {
  const root = doc.documentElement
  const style = getComputedStyle(root)
  for (const c of CARD_COLORS) {
    const ink = inkFor(style.getPropertyValue(`--card-${c}`))
    if (ink) root.style.setProperty(`--on-card-${c}`, ink)
    else root.style.removeProperty(`--on-card-${c}`)
  }
}
