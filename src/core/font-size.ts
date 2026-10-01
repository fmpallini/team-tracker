// src/core/font-size.ts — the font-size step ladder, extracted pure so both
// the prefs radio (src/ui/prefs.ts) and the Ctrl+wheel gesture wired in
// main.ts share one definition of "the five sizes, and what one step does".
// styles.css's html[data-size=…] holds the matching px values.
import type { Prefs } from './types'

export const FONT_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const

/**
 * Each size's root font-size relative to M (15px) — the same ratio styles.css
 * publishes as --tt-fs-k, for geometry computed in JS (the milestone
 * timeline's label spacing) that has to keep pace with text the CSS scales.
 */
export const FONT_SIZE_SCALE: Record<Prefs['fontSize'], number> = { XS: 0.8, S: 0.9, M: 1, L: 1.1, XL: 1.2 }

export function fontScale(size: Prefs['fontSize'] | undefined): number {
  return (size && FONT_SIZE_SCALE[size]) || 1
}

/**
 * The size one step from `current` in `dir` (+1 larger, -1 smaller), clamped
 * at the ends — stepping past the last size returns that same size, so a
 * caller can treat "no change" as "already at the limit".
 */
export function stepFontSize(current: Prefs['fontSize'], dir: -1 | 1): Prefs['fontSize'] {
  const i = FONT_SIZES.indexOf(current)
  const next = Math.min(FONT_SIZES.length - 1, Math.max(0, i + dir))
  return FONT_SIZES[next]!
}
