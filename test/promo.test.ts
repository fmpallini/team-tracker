import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initInstallCapture,
  promoStartCard,
  promoHeaderButton,
  resetPromoStateForTests,
} from '../src/ui/promo'

const LOCALE = 'en-US' as const
const URL = 'https://example.test/app/'

function firePrompt(): { prompt: ReturnType<typeof vi.fn> } {
  const ev = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void> }
  const prompt = vi.fn(async () => {})
  ev.prompt = prompt
  window.dispatchEvent(ev)
  return { prompt }
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetPromoStateForTests()
})

describe('local variant (hosted invite)', () => {
  it('renders invite card with link action', () => {
    const card = promoStartCard(LOCALE, { pwa: false, pagesUrl: URL })
    expect(card).not.toBeNull()
    expect(card!.classList.contains('tt-promo-card')).toBe(true)
    expect(card!.textContent).toContain('Try the installable version')
    expect(card!.textContent).toContain('install automatically')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    card!.querySelector<HTMLButtonElement>('.tt-promo-action')!.click()
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener')
    open.mockRestore()
  })

  it('renders header button that opens the hosted URL', () => {
    const btn = promoHeaderButton(LOCALE, { pwa: false, pagesUrl: URL })
    expect(btn).not.toBeNull()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    btn!.click()
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener')
    open.mockRestore()
  })

  it('renders nothing when pagesUrl is empty', () => {
    expect(promoStartCard(LOCALE, { pwa: false, pagesUrl: '' })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: false, pagesUrl: '' })).toBeNull()
  })
})

describe('PWA variant (install offer)', () => {
  it('renders install card and header button', () => {
    const card = promoStartCard(LOCALE, { pwa: true })
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Install as an app')
    expect(promoHeaderButton(LOCALE, { pwa: true })).not.toBeNull()
  })

  it('calls prompt() on the captured beforeinstallprompt event', () => {
    initInstallCapture()
    const { prompt } = firePrompt()
    const card = promoStartCard(LOCALE, { pwa: true })!
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.tt-promo-action')!.click()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('captured event is single-use: second click opens the instructions modal', () => {
    initInstallCapture()
    firePrompt()
    const card = promoStartCard(LOCALE, { pwa: true })!
    document.body.appendChild(card)
    const action = card.querySelector<HTMLButtonElement>('.tt-promo-action')!
    action.click()
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
    action.click()
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    expect(document.body.textContent).toContain('Install the app')
  })

  it('opens instructions modal when no event was captured', () => {
    const card = promoStartCard(LOCALE, { pwa: true })!
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.tt-promo-action')!.click()
    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    expect(document.body.textContent).toContain('address bar')
  })

  it('appinstalled removes live promo UI and blocks new renders', () => {
    initInstallCapture()
    const card = promoStartCard(LOCALE, { pwa: true })!
    const btn = promoHeaderButton(LOCALE, { pwa: true })!
    document.body.append(card, btn)
    window.dispatchEvent(new Event('appinstalled'))
    expect(document.querySelector('.tt-promo-card')).toBeNull()
    expect(document.querySelector('.tt-btn-promo')).toBeNull()
    expect(promoStartCard(LOCALE, { pwa: true })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: true })).toBeNull()
  })

  describe('getInstalledRelatedApps (already installed, viewed in a plain tab)', () => {
    afterEach(() => {
      delete (navigator as unknown as { getInstalledRelatedApps?: unknown }).getInstalledRelatedApps
    })

    // Real browsers throw "Illegal invocation" if a WebIDL Navigator method is
    // torn off its receiver and called bare (e.g. `const f = navigator.foo; f()`).
    // A plain vi.fn() doesn't enforce that, so it can't catch promo.ts calling
    // the API without `navigator` as the receiver — this mock mimics the
    // native receiver check so the test fails the way production actually did.
    function receiverCheckedGira<T>(result: T): () => Promise<T> {
      return function (this: unknown) {
        if (this !== navigator) return Promise.reject(new TypeError('Illegal invocation'))
        return Promise.resolve(result)
      }
    }

    it('a non-empty result removes live promo UI and blocks new renders', async () => {
      const gira = vi.fn(receiverCheckedGira([{ platform: 'webapp', url: 'https://example.test/manifest.json' }]))
      ;(navigator as unknown as { getInstalledRelatedApps: typeof gira }).getInstalledRelatedApps = gira
      const card = promoStartCard(LOCALE, { pwa: true })!
      const btn = promoHeaderButton(LOCALE, { pwa: true })!
      document.body.append(card, btn)

      initInstallCapture()

      await vi.waitFor(() => {
        expect(document.querySelector('.tt-promo-card')).toBeNull()
        expect(document.querySelector('.tt-btn-promo')).toBeNull()
      })
      expect(promoStartCard(LOCALE, { pwa: true })).toBeNull()
      expect(promoHeaderButton(LOCALE, { pwa: true })).toBeNull()
    })

    it('an empty result leaves the promo UI in place', async () => {
      const gira = vi.fn().mockResolvedValue([])
      ;(navigator as unknown as { getInstalledRelatedApps: typeof gira }).getInstalledRelatedApps = gira

      initInstallCapture()
      await vi.waitFor(() => expect(gira).toHaveBeenCalledTimes(1))

      expect(promoStartCard(LOCALE, { pwa: true })).not.toBeNull()
    })

    it('does nothing when the API is unsupported (no getInstalledRelatedApps on navigator)', () => {
      expect(() => initInstallCapture()).not.toThrow()
      expect(promoStartCard(LOCALE, { pwa: true })).not.toBeNull()
    })
  })
})

describe('dismissal and standalone', () => {
  it('dismiss removes card, persists, header button unaffected', () => {
    const card = promoStartCard(LOCALE, { pwa: false, pagesUrl: URL })!
    document.body.appendChild(card)
    card.querySelector<HTMLButtonElement>('.tt-promo-dismiss')!.click()
    expect(document.querySelector('.tt-promo-card')).toBeNull()
    expect(localStorage.getItem('tt-promo-dismissed')).toBe('1')
    expect(promoStartCard(LOCALE, { pwa: false, pagesUrl: URL })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: false, pagesUrl: URL })).not.toBeNull()
  })

  it('renders nothing when running standalone', () => {
    const orig = window.matchMedia
    window.matchMedia = ((q: string) =>
      ({ matches: q === '(display-mode: standalone)', addEventListener: () => {}, removeEventListener: () => {} })) as never
    expect(promoStartCard(LOCALE, { pwa: true })).toBeNull()
    expect(promoHeaderButton(LOCALE, { pwa: true })).toBeNull()
    window.matchMedia = orig
  })
})
