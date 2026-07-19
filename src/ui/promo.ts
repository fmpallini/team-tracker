// src/ui/promo.ts
// Cross-promotion between the two build variants (spec:
// docs/superpowers/specs/2026-07-13-pwa-install-promo-design.md).
// PWA build (__PWA__): offer "install as app" — native prompt on Chromium,
// manual-instructions modal elsewhere. Local file:// build: invite to the
// hosted PWA at __PAGES_URL__. The two variants never coexist at runtime;
// PromoOpts exists so tests can exercise both from a single vitest define.
import { t, type Locale } from '../core/i18n'
import { el } from './dom'
import { showModal, type ModalHandle } from './modal'

/**
 * Test seam only — production callers (main.ts, start.ts) never pass it and
 * always get the build-time defines. It exists because a single jsdom process
 * can't swap esbuild defines per test, so tests inject both variants here.
 */
export interface PromoOpts {
  pwa?: boolean
  pagesUrl?: string
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

const DISMISS_KEY = 'tt-promo-dismissed'

// The captured event is single-use: Chromium blocks re-prompting after the
// user dismisses the native dialog, so triggerInstall() clears it and later
// clicks fall through to the instructions modal.
let deferredPrompt: BeforeInstallPromptEvent | null = null
let installed = false

// Test-only export like PromoOpts: unreferenced from main.ts, so esbuild
// tree-shakes it out of both shipped bundles.
export function resetPromoStateForTests(): void {
  deferredPrompt = null
  installed = false
}

function hidePromoUi(): void {
  installed = true
  deferredPrompt = null
  document.querySelectorAll('.tt-promo-card, .tt-btn-promo').forEach((n) => n.remove())
}

/**
 * Chromium-only, self-installed-PWA detection via the manifest's
 * `related_applications` "webapp" entry (pwa/manifest.json) — catches the
 * case appinstalled/isStandalone miss: the app was installed in a past
 * session, and the user is now viewing the hosted page in a plain browser
 * tab rather than the installed app window. Feature-detected: unsupported
 * browsers (Firefox, Safari, and Chromium without the flag) just no-op and
 * fall back to the existing appinstalled/isStandalone checks.
 */
async function checkRelatedAppsInstalled(): Promise<void> {
  // Call through navigator.* directly rather than tearing the method off into
  // a local binding: WebIDL methods on Navigator require `this === navigator`
  // and throw "Illegal invocation" otherwise, which the catch below would
  // silently swallow as "unsupported".
  if (typeof navigator.getInstalledRelatedApps !== 'function') return
  try {
    const apps = await navigator.getInstalledRelatedApps()
    if (apps.length > 0) hidePromoUi()
  } catch {
    // Denied/unsupported at runtime despite the feature check — leave the
    // existing appinstalled/isStandalone detection as the fallback.
  }
}

/**
 * Must run as early as possible in main.ts (PWA build only):
 * `beforeinstallprompt` fires before the UI mounts, and a listener added
 * later simply misses it — losing the native-prompt path for the session.
 */
export function initInstallCapture(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', hidePromoUi)
  void checkRelatedAppsInstalled()
}

function isStandalone(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  )
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function setDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // Strict privacy modes: dismissal just doesn't persist.
  }
}

function resolve(opts?: PromoOpts): { pwa: boolean; pagesUrl: string } {
  return { pwa: opts?.pwa ?? __PWA__, pagesUrl: opts?.pagesUrl ?? __PAGES_URL__ }
}

function showInstallInstructions(locale: Locale): void {
  const body = el(
    'div',
    { class: 'tt-promo-instructions' },
    el('p', {}, t(locale, 'promo_instr_chrome')),
    el('p', {}, t(locale, 'promo_instr_safari')),
    el('p', {}, t(locale, 'promo_instr_firefox'))
  )
  const handle: ModalHandle = showModal({
    title: t(locale, 'promo_instr_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
}

function triggerInstall(locale: Locale): void {
  const ev = deferredPrompt
  if (ev) {
    deferredPrompt = null
    ev.prompt().catch(() => showInstallInstructions(locale))
  } else {
    showInstallInstructions(locale)
  }
}

function openHosted(pagesUrl: string): void {
  window.open(pagesUrl, '_blank', 'noopener')
}

function hiddenEverywhere(pwa: boolean, pagesUrl: string): boolean {
  return installed || isStandalone() || (!pwa && !pagesUrl)
}

// Shared by the card's action button and the header button: install flow in
// the PWA build, open-hosted in the local build.
function promoAction(locale: Locale, pwa: boolean, pagesUrl: string): void {
  if (pwa) triggerInstall(locale)
  else openHosted(pagesUrl)
}

export function promoStartCard(locale: Locale, opts?: PromoOpts): HTMLElement | null {
  const { pwa, pagesUrl } = resolve(opts)
  if (hiddenEverywhere(pwa, pagesUrl) || isDismissed()) return null

  const action = el(
    'button',
    {
      class: 'tt-btn tt-btn-primary tt-promo-action',
      type: 'button',
      onclick: () => promoAction(locale, pwa, pagesUrl),
    },
    t(locale, pwa ? 'promo_action_install' : 'promo_action_open_hosted')
  )
  const dismiss = el(
    'button',
    {
      class: 'tt-promo-dismiss',
      type: 'button',
      title: t(locale, 'promo_dismiss_title'),
      onclick: () => {
        setDismissed()
        card.remove()
      },
    },
    '×'
  )
  const card = el(
    'div',
    { class: 'tt-promo-card' },
    dismiss,
    el('h2', { class: 'tt-promo-title' }, t(locale, pwa ? 'promo_card_title_install' : 'promo_card_title_hosted')),
    el(
      'ul',
      { class: 'tt-promo-advantages' },
      el('li', {}, t(locale, 'promo_adv_updates')),
      el('li', {}, t(locale, 'promo_adv_app'))
    ),
    pwa ? null : el('p', { class: 'tt-promo-note' }, t(locale, 'promo_hosted_note')),
    action
  )
  return card
}

export function promoHeaderButton(locale: Locale, opts?: PromoOpts): HTMLElement | null {
  const { pwa, pagesUrl } = resolve(opts)
  if (hiddenEverywhere(pwa, pagesUrl)) return null
  return el(
    'button',
    {
      class: 'tt-btn tt-btn-promo',
      type: 'button',
      title: t(locale, pwa ? 'promo_header_install_title' : 'promo_header_hosted_title'),
      onclick: () => promoAction(locale, pwa, pagesUrl),
    },
    pwa ? '⬇' : '🌐'
  )
}

/** Re-stamps the header button's locale-sensitive tooltip — called from main.ts's onLocaleChanged wiring so the title doesn't stay stale after a locale switch. */
export function refreshPromoHeaderButton(btn: HTMLElement, locale: Locale, opts?: PromoOpts): void {
  const { pwa } = resolve(opts)
  btn.title = t(locale, pwa ? 'promo_header_install_title' : 'promo_header_hosted_title')
}
