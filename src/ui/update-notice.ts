// src/ui/update-notice.ts
// Notifies the user a newer release exists (spec:
// docs/superpowers/specs/2026-07-21-update-check-design.md). PWA build
// (__PWA__): offers a reload that the caller wires to a save-then-verify
// flow (this module never touches save-controller.ts or location.reload()
// itself — see onReload). Standalone build: links to the GitHub releases
// page, since a static file:// build can't self-update.
import { t, type Locale } from '../core/i18n'
import { el } from './dom'

export interface UpdateNoticeOpts {
  pwa?: boolean
  repo?: string
}

function resolve(opts?: UpdateNoticeOpts): { pwa: boolean; repo: string } {
  return { pwa: opts?.pwa ?? __PWA__, repo: opts?.repo ?? __REPO__ }
}

export function showUpdateNotice(
  locale: Locale,
  latestVersion: string,
  onReload: () => Promise<void>,
  onDismiss: (version: string) => void,
  opts?: UpdateNoticeOpts
): HTMLElement {
  const { pwa, repo } = resolve(opts)
  document.querySelector('.tt-update-banner')?.remove()

  function dismiss(): void {
    banner.remove()
    onDismiss(latestVersion)
  }

  const actionBtn: HTMLButtonElement = pwa
    ? el(
        'button',
        {
          class: 'tt-btn tt-update-banner-action',
          type: 'button',
          onclick: () => {
            actionBtn.disabled = true
            void onReload().finally(() => {
              // Only reachable if onReload resolved without navigating away
              // (the save failed and the caller aborted the reload).
              actionBtn.disabled = false
            })
          },
        },
        t(locale, 'update_notice_reload')
      )
    : el(
        'button',
        {
          class: 'tt-btn tt-update-banner-action',
          type: 'button',
          onclick: () => {
            window.open(`https://github.com/${repo}/releases/latest`, '_blank', 'noopener')
            dismiss()
          },
        },
        t(locale, 'update_notice_view_release')
      )

  const dismissBtn = el(
    'button',
    {
      class: 'tt-update-banner-dismiss',
      type: 'button',
      title: t(locale, 'update_notice_dismiss_title'),
      onclick: () => dismiss(),
    },
    '×'
  )

  const row = el(
    'div',
    { class: 'tt-update-banner-row' },
    el('span', { class: 'tt-update-banner-text' }, t(locale, 'update_notice_title', { version: latestVersion })),
    actionBtn,
    dismissBtn
  )

  const banner = el(
    'div',
    { class: 'tt-update-banner' },
    row,
    // Standalone build only: a static file:// build can't self-update, so
    // this points the user at the PWA build instead of leaving them to
    // guess why "Reload now" isn't offered here.
    pwa ? null : el('p', { class: 'tt-update-banner-hint' }, t(locale, 'update_notice_standalone_hint'))
  )
  return banner
}
