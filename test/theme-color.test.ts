import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { syncThemeColor } from '../src/core/theme-color'

function addMeta(content: string): HTMLMetaElement {
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = content
  document.head.appendChild(meta)
  return meta
}

function setVars(bg?: string, border?: string): void {
  const root = document.documentElement.style
  if (bg === undefined) root.removeProperty('--bg')
  else root.setProperty('--bg', bg)
  if (border === undefined) root.removeProperty('--border')
  else root.setProperty('--border', border)
}

describe('syncThemeColor', () => {
  beforeEach(() => setVars())
  afterEach(() => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
    setVars()
  })

  it('blends --bg and --border so the titlebar differs from the header (--panel)', () => {
    const meta = addMeta('#3b5a6b')
    setVars(' #eee7d6 ', '#c3b596')
    syncThemeColor()
    expect(meta.content).toBe('#dbd1b9')
    expect(meta.content).not.toBe('#f5efe1')
  })

  it('lightens a dark theme instead of matching its darker header', () => {
    const meta = addMeta('#3b5a6b')
    setVars('#1c1a14', '#4a4530')
    syncThemeColor()
    expect(meta.content).toBe('#312d21')
  })

  it('follows a later change of the theme', () => {
    const meta = addMeta('#3b5a6b')
    setVars('#1c1a14', '#4a4530')
    syncThemeColor()
    setVars('#eee7d6', '#c3b596')
    syncThemeColor()
    expect(meta.content).toBe('#dbd1b9')
  })

  it('falls back to --bg when the colors are not plain hex', () => {
    const meta = addMeta('#3b5a6b')
    setVars('rgb(1, 2, 3)', '#4a4530')
    syncThemeColor()
    expect(meta.content).toBe('rgb(1, 2, 3)')
  })

  it('leaves the tag alone when the theme vars are not defined', () => {
    const meta = addMeta('#3b5a6b')
    syncThemeColor()
    expect(meta.content).toBe('#3b5a6b')
  })

  it('does nothing when there is no theme-color tag (the standalone app.html build)', () => {
    setVars('#1c1a14', '#4a4530')
    expect(() => syncThemeColor()).not.toThrow()
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull()
  })
})
