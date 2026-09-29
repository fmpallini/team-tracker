// src/core/theme-color.ts — keeps the PWA's <meta name="theme-color"> in step
// with the active theme + palette. The installed window's titlebar (when not
// in window-controls-overlay mode) and the OS task switcher take their color
// from that tag, and the build bakes in one static value; without this, a
// dark theme or a non-default palette gets a light-blue titlebar over a dark
// header. The tag is injected only into the PWA build (scripts/build.mjs), so
// the standalone app.html variant and jsdom have nothing to update and this
// is a no-op there.
export function syncThemeColor(doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  // --panel is what .tt-header paints (styles.css), i.e. the strip the
  // titlebar visually joins. Read from the computed style so every
  // palette x theme pair resolves without a duplicated color table here.
  const panel = getComputedStyle(doc.documentElement).getPropertyValue('--panel').trim()
  if (panel) meta.content = panel
}
