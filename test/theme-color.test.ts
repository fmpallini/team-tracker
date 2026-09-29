import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { syncThemeColor } from '../src/core/theme-color'

function addMeta(content: string): HTMLMetaElement {
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = content
  document.head.appendChild(meta)
  return meta
}

describe('syncThemeColor', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--panel')
  })
  afterEach(() => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
    document.documentElement.style.removeProperty('--panel')
  })

  it('copies the active --panel color into the theme-color meta tag', () => {
    const meta = addMeta('#3b5a6b')
    document.documentElement.style.setProperty('--panel', ' #26231a ')
    syncThemeColor()
    expect(meta.content).toBe('#26231a')
  })

  it('follows a later change of --panel', () => {
    const meta = addMeta('#3b5a6b')
    document.documentElement.style.setProperty('--panel', '#26231a')
    syncThemeColor()
    document.documentElement.style.setProperty('--panel', '#f5efe1')
    syncThemeColor()
    expect(meta.content).toBe('#f5efe1')
  })

  it('leaves the tag alone when --panel is not defined', () => {
    const meta = addMeta('#3b5a6b')
    syncThemeColor()
    expect(meta.content).toBe('#3b5a6b')
  })

  it('does nothing when there is no theme-color tag (the standalone app.html build)', () => {
    document.documentElement.style.setProperty('--panel', '#26231a')
    expect(() => syncThemeColor()).not.toThrow()
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull()
  })
})
