// src/core/font-size.ts — the font-size step ladder, extracted pure so both
// the prefs radio (src/ui/prefs.ts) and the Ctrl+wheel gesture wired in
// main.ts share one definition of "the five sizes, and what one step does".
// styles.css's html[data-size=…] holds the matching px values.
import type { Prefs } from './types'

export const FONT_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const

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
