// src/core/app-badge.ts — mirrors the sidebar's overdue+due-soon total
// (src/ui/sidebar.ts's renderDueBadge) onto the OS-level Badging API, so an
// installed PWA's taskbar/dock/launcher icon shows the count without the
// window being focused. `BadgeNav` (not the real Navigator type) keeps this
// testable: jsdom has no setAppBadge/clearAppBadge, and Safari/Firefox lack
// them too, so every call site must feature-detect rather than assume.
export interface BadgeNav {
  setAppBadge?(count?: number): Promise<void>
  clearAppBadge?(): Promise<void>
}

export function updateAppBadge(count: number, nav: BadgeNav = navigator): void {
  if (typeof nav.setAppBadge !== 'function' || typeof nav.clearAppBadge !== 'function') return
  const result = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()
  result.catch((e: unknown) => console.error(e))
}
