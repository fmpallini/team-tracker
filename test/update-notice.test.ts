import { describe, it, expect, vi, beforeEach } from 'vitest'
import { showUpdateNotice } from '../src/ui/update-notice'

const LOCALE = 'en-US' as const
const REPO = 'fmpallini/team-tracker'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PWA variant', () => {
  it('renders a reload button that calls onReload', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined)
    const onDismiss = vi.fn()
    const banner = showUpdateNotice(LOCALE, '9.9.9', onReload, onDismiss, { pwa: true })
    document.body.appendChild(banner)
    expect(banner.textContent).toContain('9.9.9')
    const btn = banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!
    expect(btn.textContent).toBe('Reload now')
    btn.click()
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('does not render the standalone hint', () => {
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), vi.fn(), { pwa: true })
    expect(banner.querySelector('.tt-update-banner-hint')).toBeNull()
  })

  it('disables the reload button while onReload is pending and re-enables if it resolves without navigating', async () => {
    let resolvePending: () => void
    const pending = new Promise<void>((r) => { resolvePending = r })
    const onReload = vi.fn().mockReturnValue(pending)
    const banner = showUpdateNotice(LOCALE, '9.9.9', onReload, vi.fn(), { pwa: true })
    document.body.appendChild(banner)
    const btn = banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!
    btn.click()
    expect(btn.disabled).toBe(true)
    resolvePending!()
    await pending
    await Promise.resolve()
    expect(btn.disabled).toBe(false)
  })
})

describe('standalone variant', () => {
  it('renders a "view release" action that opens the releases page', () => {
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), vi.fn(), { pwa: false, repo: REPO })
    document.body.appendChild(banner)
    const btn = banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!
    expect(btn.textContent).toBe('View release')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    btn.click()
    expect(open).toHaveBeenCalledWith(`https://github.com/${REPO}/releases/latest`, '_blank', 'noopener')
    open.mockRestore()
  })

  it('dismisses the banner when "view release" is clicked', () => {
    const onDismiss = vi.fn()
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), onDismiss, { pwa: false, repo: REPO })
    document.body.appendChild(banner)
    vi.spyOn(window, 'open').mockReturnValue(null)
    banner.querySelector<HTMLButtonElement>('.tt-update-banner-action')!.click()
    expect(banner.isConnected).toBe(false)
    expect(onDismiss).toHaveBeenCalledWith('9.9.9')
  })

  it('renders a hint pointing at the installable PWA version', () => {
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), vi.fn(), { pwa: false, repo: REPO })
    expect(banner.querySelector('.tt-update-banner-hint')).not.toBeNull()
    expect(banner.textContent).toContain('download the new file')
  })
})

describe('dismiss', () => {
  it('removes the banner and reports the dismissed version', () => {
    const onDismiss = vi.fn()
    const banner = showUpdateNotice(LOCALE, '9.9.9', vi.fn(), onDismiss, { pwa: true })
    document.body.appendChild(banner)
    banner.querySelector<HTMLButtonElement>('.tt-update-banner-dismiss')!.click()
    expect(banner.isConnected).toBe(false)
    expect(onDismiss).toHaveBeenCalledWith('9.9.9')
  })
})

describe('replacing an existing banner', () => {
  it('removes any prior .tt-update-banner before appending itself', () => {
    const first = showUpdateNotice(LOCALE, '1.0.0', vi.fn(), vi.fn(), { pwa: true })
    document.body.appendChild(first)
    const second = showUpdateNotice(LOCALE, '2.0.0', vi.fn(), vi.fn(), { pwa: true })
    document.body.appendChild(second)
    expect(document.querySelectorAll('.tt-update-banner').length).toBe(1)
    expect(document.body.textContent).toContain('2.0.0')
  })
})
