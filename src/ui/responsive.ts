// src/ui/responsive.ts — auto-hides split-view and the sidebar on narrow
// windows, on top of (never instead of) their own persisted/manual state.
// See docs/superpowers/specs/2026-07-21-shell-layout-export-help-fixes-
// design.md section 2. Edge-triggered: only fires when a threshold is
// actually crossed, so it never fights a manual toggle click made while the
// window happens to already be narrow/wide.
const SPLIT_HIDE_BELOW_PX = 900
const SIDEBAR_HIDE_BELOW_PX = 650

export interface ResponsiveHooks {
  setSplitSpaceHidden(hidden: boolean): void
  setSidebarSpaceHidden(hidden: boolean): void
}

/** Returns a disposer. No-ops (and returns a no-op disposer) where ResizeObserver isn't available — e.g. jsdom in tests — same graceful-degradation the app already applies to Web Locks/BroadcastChannel. */
export function setupResponsiveLayout(target: HTMLElement, hooks: ResponsiveHooks): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}

  let splitHidden = false
  let sidebarHidden = false

  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? target.clientWidth
    const nextSplitHidden = width < SPLIT_HIDE_BELOW_PX
    const nextSidebarHidden = width < SIDEBAR_HIDE_BELOW_PX
    if (nextSplitHidden !== splitHidden) {
      splitHidden = nextSplitHidden
      hooks.setSplitSpaceHidden(splitHidden)
    }
    if (nextSidebarHidden !== sidebarHidden) {
      sidebarHidden = nextSidebarHidden
      hooks.setSidebarSpaceHidden(sidebarHidden)
    }
  })
  observer.observe(target)
  return () => observer.disconnect()
}
