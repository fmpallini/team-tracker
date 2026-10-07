// src/ui/responsive.ts — auto-hides split-view, the sidebar, and the
// header's non-essential chrome on narrow windows, on top of (never instead
// of) their own persisted/manual state. See docs/superpowers/specs/
// 2026-07-21-shell-layout-export-help-fixes-design.md section 2.
// Edge-triggered: only fires when a threshold is actually crossed, so it
// never fights a manual toggle click made while the window happens to
// already be narrow/wide.
import { fontScale } from '../core/font-size'
import type { Prefs } from '../core/types'

const SPLIT_HIDE_BELOW_PX = 900
const SIDEBAR_HIDE_BELOW_PX = 650
// The header's mandatory pieces are the save-state pill (unsaved work must
// stay visible; it shrinks with an ellipsis if it has to) and the close-file
// (🔒) and settings (⚙) buttons — everything else (sidebar collapse toggle,
// app name, search bar, the active-team indicator, the install/promo button,
// fullscreen, help) has a keyboard equivalent (Ctrl+Shift+K/Ctrl+F reopen the
// app-name/search actions) or simply isn't essential moment-to-moment. Below this width the two
// floored-but-not-shrinkable clusters either side of them (headerRight's
// icon buttons never shrink at all; headerLeft's app name/search bar bottom
// out at a fixed min-width) can no longer both fit without
// crowding/overlapping — so every optional piece is hidden at once instead,
// leaving only the mandatory ones. One threshold, not one per element:
// hiding them piecemeal (search first, then the team indicator, then...)
// just moves the collision to a different narrower width instead of
// removing it, since the mandatory cluster alone is what actually needs
// guaranteed room. Comfortably above SIDEBAR_HIDE_BELOW_PX so a *manual*
// sidebar collapse (which reveals the team indicator) can't reopen the gap
// in the 650-840px band.
//
// Tuned at the M text size (15px root). The header's clusters are sized in rem,
// so they grow with the text-size setting while the window width doesn't: at XL
// the same 840px no longer fits them (the promo button then overlaps the
// search box). The threshold is therefore multiplied by the current size's
// scale (core/font-size.ts's fontScale; never below 1), and re-evaluated when the size
// changes. 820 → 840 when the header favorites ★ joined the right cluster: at M
// (pt-BR, dirty save pill) the search box and promo button then overlapped up to 830px.
const HEADER_COMPACT_BELOW_PX = 840
// The centred team indicator only gets what the side clusters leave over (see
// .tt-header-center in styles.css: 100vw − 220px − 47rem). Below this width
// that is under ~7rem — a stub that shows a caret and half a letter — so the
// slot is dropped outright instead. The two constants are that formula solved
// for 7rem; keep them in step with it. rem part scales with the text size on
// its own (root px), the 220px part does not.
const TEAM_SLOT_FIXED_PX = 220
const TEAM_SLOT_REM = 47 + 7
const TEAM_SLOT_BASE_ROOT_PX = 15
// Below this, a single daily-notes pane no longer has room for both the
// ~240px calendar column and a usable note width, so the calendar is folded
// away on top of (never instead of) the user's own nav.calendarCollapsed —
// it springs back to whatever they last chose once the window widens again.
// Under the sidebar threshold: the sidebar is the bigger space win and
// should go first.
const CALENDAR_HIDE_BELOW_PX = 560

/**
 * Width the installed PWA's window-controls overlay (min/max/close) takes out
 * of the header's row — styles.css pads .tt-header by the same amount. 0
 * everywhere else, including the standalone build and browsers without the API.
 */
export function wcoReservedWidth(): number {
  const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay
  if (!wco?.visible) return 0
  return Math.max(0, window.innerWidth - wco.getTitlebarAreaRect().width)
}

export interface ResponsiveOpts {
  /** Horizontal space the header cannot use (window-controls overlay). Subtracted from the observed width for the header thresholds only. */
  reservedWidth?: () => number
}

export interface ResponsiveHooks {
  setSplitSpaceHidden(hidden: boolean): void
  setSidebarSpaceHidden(hidden: boolean): void
  setHeaderCompactSpaceHidden(hidden: boolean): void
  /** Optional: the team-indicator slot has shrunk below a usable width. */
  setHeaderTeamSpaceHidden?(hidden: boolean): void
  setCalendarSpaceHidden(hidden: boolean): void
}

/** Returns a disposer. No-ops (and returns a no-op disposer) where ResizeObserver isn't available — e.g. jsdom in tests — same graceful-degradation the app already applies to Web Locks/BroadcastChannel. */
export function setupResponsiveLayout(target: HTMLElement, hooks: ResponsiveHooks, opts: ResponsiveOpts = {}): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}

  let splitHidden = false
  let sidebarHidden = false
  let headerCompactHidden = false
  let calendarHidden = false
  let teamHidden = false

  let lastWidth: number | null = null

  const evaluate = (width: number): void => {
    lastWidth = width
    // Only ever raised: below M the header just gets roomier, and lowering the
    // threshold would eat into the gap above SIDEBAR_HIDE_BELOW_PX.
    const textScale = Math.max(1, fontScale(document.documentElement.dataset.size as Prefs['fontSize'] | undefined))
    const nextSplitHidden = width < SPLIT_HIDE_BELOW_PX
    const nextSidebarHidden = width < SIDEBAR_HIDE_BELOW_PX
    // The header row is narrower than the window by whatever the OS draws over it.
    const headerWidth = width - (opts.reservedWidth?.() ?? 0)
    const nextHeaderCompactHidden = headerWidth < HEADER_COMPACT_BELOW_PX * textScale
    const rootPx = TEAM_SLOT_BASE_ROOT_PX * fontScale(document.documentElement.dataset.size as Prefs['fontSize'] | undefined)
    const nextTeamHidden = headerWidth < TEAM_SLOT_FIXED_PX + TEAM_SLOT_REM * rootPx
    const nextCalendarHidden = width < CALENDAR_HIDE_BELOW_PX
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
    if (nextTeamHidden !== teamHidden) {
      teamHidden = nextTeamHidden
      hooks.setHeaderTeamSpaceHidden?.(teamHidden)
    }
    if (nextCalendarHidden !== calendarHidden) {
      calendarHidden = nextCalendarHidden
      hooks.setCalendarSpaceHidden(calendarHidden)
    }
  }

  const observer = new ResizeObserver((entries) => {
    evaluate(entries[0]?.contentRect.width ?? target.clientWidth)
  })
  observer.observe(target)
  // A text-size change moves the header's threshold without resizing the window,
  // so the ResizeObserver stays silent — re-run against the last known width.
  const sizeWatch = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
    if (lastWidth !== null) evaluate(lastWidth)
  })
  sizeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-size'] })
  return () => {
    observer.disconnect()
    sizeWatch?.disconnect()
  }
}
