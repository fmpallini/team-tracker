// src/ui/responsive.ts — auto-hides split-view, the sidebar, and the
// header's non-essential chrome on narrow windows, on top of (never instead
// of) their own persisted/manual state. See docs/superpowers/specs/
// 2026-07-21-shell-layout-export-help-fixes-design.md section 2.
// Edge-triggered: only fires when a threshold is actually crossed, so it
// never fights a manual toggle click made while the window happens to
// already be narrow/wide.
const SPLIT_HIDE_BELOW_PX = 900
const SIDEBAR_HIDE_BELOW_PX = 650
// The header's only two mandatory pieces are the close-file (🔒) and
// settings (⚙) buttons — everything else (sidebar collapse toggle, app
// name, search bar, the active-team indicator, the save-state pill,
// fullscreen, help) has a keyboard equivalent (Ctrl+S still saves with the
// pill hidden, Ctrl+K/Ctrl+F reopen the app-name/search actions) or simply
// isn't essential moment-to-moment. Below this width the two
// floored-but-not-shrinkable clusters either side of them (headerRight's
// icon buttons never shrink at all; headerLeft's app name/search bar bottom
// out at a fixed min-width) can no longer both fit without
// crowding/overlapping — so every optional piece is hidden at once instead,
// leaving only the mandatory two. One threshold, not one per element:
// hiding them piecemeal (search first, then the team indicator, then...)
// just moves the collision to a different narrower width instead of
// removing it, since the mandatory cluster alone is what actually needs
// guaranteed room. Comfortably above SIDEBAR_HIDE_BELOW_PX so a *manual*
// sidebar collapse (which reveals the team indicator) can't reopen the gap
// in the 650-820px band.
const HEADER_COMPACT_BELOW_PX = 820

export interface ResponsiveHooks {
  setSplitSpaceHidden(hidden: boolean): void
  setSidebarSpaceHidden(hidden: boolean): void
  setHeaderCompactSpaceHidden(hidden: boolean): void
}

/** Returns a disposer. No-ops (and returns a no-op disposer) where ResizeObserver isn't available — e.g. jsdom in tests — same graceful-degradation the app already applies to Web Locks/BroadcastChannel. */
export function setupResponsiveLayout(target: HTMLElement, hooks: ResponsiveHooks): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}

  let splitHidden = false
  let sidebarHidden = false
  let headerCompactHidden = false

  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? target.clientWidth
    const nextSplitHidden = width < SPLIT_HIDE_BELOW_PX
    const nextSidebarHidden = width < SIDEBAR_HIDE_BELOW_PX
    const nextHeaderCompactHidden = width < HEADER_COMPACT_BELOW_PX
    if (nextSplitHidden !== splitHidden) {
      splitHidden = nextSplitHidden
      hooks.setSplitSpaceHidden(splitHidden)
    }
    if (nextSidebarHidden !== sidebarHidden) {
      sidebarHidden = nextSidebarHidden
      hooks.setSidebarSpaceHidden(sidebarHidden)
    }
    if (nextHeaderCompactHidden !== headerCompactHidden) {
      headerCompactHidden = nextHeaderCompactHidden
      hooks.setHeaderCompactSpaceHidden(headerCompactHidden)
    }
  })
  observer.observe(target)
  return () => observer.disconnect()
}
