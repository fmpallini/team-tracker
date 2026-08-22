import { describe, it, expect, vi } from 'vitest'
import { updateAppBadge, type BadgeNav } from '../src/core/app-badge'

function fakeNav(): BadgeNav & { setAppBadge: ReturnType<typeof vi.fn>; clearAppBadge: ReturnType<typeof vi.fn> } {
  return {
    setAppBadge: vi.fn().mockResolvedValue(undefined),
    clearAppBadge: vi.fn().mockResolvedValue(undefined),
  }
}

describe('updateAppBadge', () => {
  it('sets the badge with the count when positive', () => {
    const nav = fakeNav()
    updateAppBadge(3, nav)
    expect(nav.setAppBadge).toHaveBeenCalledWith(3)
    expect(nav.clearAppBadge).not.toHaveBeenCalled()
  })

  it('clears the badge when the count is zero', () => {
    const nav = fakeNav()
    updateAppBadge(0, nav)
    expect(nav.clearAppBadge).toHaveBeenCalled()
    expect(nav.setAppBadge).not.toHaveBeenCalled()
  })

  it('does nothing when the Badging API is unsupported (e.g. jsdom, Safari, Firefox)', () => {
    expect(() => updateAppBadge(5, {})).not.toThrow()
  })

  it('logs but does not throw if the browser rejects the call', async () => {
    const nav = fakeNav()
    nav.setAppBadge.mockRejectedValue(new Error('nope'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateAppBadge(1, nav)
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
