// src/core/theme-color.ts — keeps the PWA's <meta name="theme-color"> in step
// with the active theme + palette. The installed window's titlebar (when not
// in window-controls-overlay mode) and the OS task switcher take their color
// from that tag, and the build bakes in one static value; without this, a
// dark theme or a non-default palette gets a light-blue titlebar over a dark
// header. The tag is injected only into the PWA build (scripts/build.mjs), so
// the standalone app.html variant and jsdom have nothing to update and this
// is a no-op there.
//
// The color is deliberately NOT --panel (what .tt-header paints): identical
// colors made the OS titlebar and the app header read as one strip, so users
// couldn't tell where the window chrome ended and the app began. It's a
// bg/border blend instead — a distinct band in every palette x theme pair,
// still clearly from the same family.

// Share of --border in the blend. Enough to separate from both --panel and
// --bg in light and dark themes without turning the titlebar into a heavy bar.
const BORDER_WEIGHT = 0.45

function parseHex(color: string): [number, number, number] | null {
  const digits = /^#([0-9a-f]{6})$/i.exec(color)?.[1]
  if (!digits) return null
  const n = parseInt(digits, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function blend(bg: string, border: string): string | null {
  const a = parseHex(bg)
  const b = parseHex(border)
  if (!a || !b) return null
  const hex = a.map((v, i) => Math.round(v * (1 - BORDER_WEIGHT) + (b[i] ?? 0) * BORDER_WEIGHT).toString(16).padStart(2, '0'))
  return `#${hex.join('')}`
}

export function syncThemeColor(doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  // Read from the computed style so every palette x theme pair resolves
  // without a duplicated color table here.
  const style = getComputedStyle(doc.documentElement)
  const bg = style.getPropertyValue('--bg').trim()
  const border = style.getPropertyValue('--border').trim()
  const color = blend(bg, border) ?? bg
  if (color) meta.content = color
}
