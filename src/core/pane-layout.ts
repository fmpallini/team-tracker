// src/core/pane-layout.ts — the transient (never-persisted) half of pane
// layout state, extracted out of ui/panes.ts so navigation policy lives apart
// from DOM rendering. Nothing here touches the DOM.
import type { Store } from './store'
import type { PaneState } from './types'
import { currentLoc, latestReachableIndex, navigateHistory, steppable } from './nav'

function otherPaneIdx(idx: 0 | 1): 0 | 1 {
  return idx === 0 ? 1 : 0
}

export interface PaneLayout {
  /**
   * Applies one history step (back/forward) to pane `idx`, skipping any entry
   * that would conflict with the other pane's current Loc. Returns whether
   * the nav state actually changed.
   */
  stepHistory(idx: 0 | 1, dir: -1 | 1): boolean
  /**
   * Jumps pane `idx` straight to the most recent entry its history can reach
   * — repeated `stepHistory(idx, 1)` in one call, stopping where that would:
   * at the newest entry, or the newest one not conflicting with the other
   * pane's current Loc. Returns whether the nav state actually changed.
   */
  jumpToLatest(idx: 0 | 1): boolean
  /**
   * Jumps pane `idx` straight to history entry `target` (the history-list
   * menu's pick). Refuses — returns false — for an out-of-range or current
   * index, or an entry conflicting with the other pane's current Loc.
   */
  jumpToIndex(idx: 0 | 1, target: number): boolean
  /** Records that a real navigation landed in pane `idx` — invalidates the stash for idx 0. */
  noteRealNavigation(idx: 0 | 1): void
  /** Drops the stash outright (e.g. sidebar.ts's deleteTeam pruning histories directly). */
  invalidateStash(): void
  /**
   * Flips `nav.split` and maintains the un-split stash. `wasVisible` is the
   * *effective* (on-screen) split state before the toggle, which differs from
   * `nav.split` when the responsive layout has force-hidden the split view.
   */
  applyToggleSplit(wasVisible: boolean): void
  /**
   * Whether pane 1 is on screen: the persisted split AND not hidden for lack of
   * window width. Everything that asks "is the other pane visible?" — the
   * same-module guard, focus changes, swapping — goes through this, never the
   * raw `nav.split`, which stays true while a narrow window hides pane 1.
   */
  splitVisible(): boolean
  /** Whether the responsive layout is currently hiding pane 1 (transient, never persisted). */
  isSpaceHidden(): boolean
  /**
   * The responsive layout hiding (`true`) or revealing (`false`) pane 1. A
   * no-op if already in that state. Narrowing while pane 1 is the one being
   * worked in pulls its content into the visible pane 0 and moves focus there —
   * exactly what a manual "expand the right pane" does — so the pane in use stays
   * in view; widening puts pane 0's own content and focus back unless the user
   * navigated in pane 0 meanwhile. Returns whether the nav state changed (the
   * caller must re-render the bodies if so). `nav.split` is never touched.
   */
  setSpaceHidden(hidden: boolean): boolean
  /** The user explicitly opening the second pane ("open in other pane") while narrow: override the responsive hide. */
  showSplit(): void
}

export function createPaneLayout(store: Store): PaneLayout {
  // Holds pane 0's pre-pull PaneState so a later re-split can put it back on
  // the left instead of leaving both panes showing an identical duplicate.
  // Never persisted — losing it on reload is fine, it's a same-session UX
  // nicety, not app state.
  let unsplitStash: PaneState | null = null
  // Explicit rather than relying on object identity (which happens to hold
  // because updateNav mutates in place) — any real navigation while unsplit
  // invalidates the stash.
  let unsplitStashValid = false
  // Window too narrow for two panes — transient, like the stash.
  let spaceHidden = false
  // The stash currently held was taken by narrowing (not by a manual un-split),
  // so widening should put focus back on pane 1 along with pane 0's content.
  let pulledByResize = false

  return {
    stepHistory(idx, dir) {
      const nav = store.doc.nav
      const other = currentLoc(nav.panes[otherPaneIdx(idx)])
      const result = navigateHistory(nav.panes[idx], dir, other, nav.activeTeamId)
      if (!result) return false
      store.updateNav((d) => {
        d.nav.panes[idx] = result
        d.nav.focusedPane = idx
      })
      if (idx === 0) {
        unsplitStash = null
        unsplitStashValid = false
      }
      return true
    },
    jumpToLatest(idx) {
      const nav = store.doc.nav
      const other = currentLoc(nav.panes[otherPaneIdx(idx)])
      const pane = nav.panes[idx]
      // The newest reachable entry is just the last non-conflicting one in
      // the array — a single backward scan finds it directly, rather than
      // walking forward one navigateHistory() call (and one conflict-skip
      // scan) per reachable entry.
      const target = latestReachableIndex(pane, other, nav.activeTeamId)
      if (target === -1) return false
      store.updateNav((d) => {
        d.nav.panes[idx] = { history: pane.history, index: target }
        d.nav.focusedPane = idx
      })
      if (idx === 0) {
        unsplitStash = null
        unsplitStashValid = false
      }
      return true
    },
    jumpToIndex(idx, target) {
      const nav = store.doc.nav
      const pane = nav.panes[idx]
      const loc = pane.history[target]
      if (loc === undefined || target === pane.index || nav.activeTeamId === null) return false
      // Same admission rule as a step (team, not-where-I-am, not-the-other-pane).
      if (!steppable(loc, nav.activeTeamId, currentLoc(pane), currentLoc(nav.panes[otherPaneIdx(idx)]))) return false
      store.updateNav((d) => {
        d.nav.panes[idx] = { history: pane.history, index: target }
        d.nav.focusedPane = idx
      })
      if (idx === 0) {
        unsplitStash = null
        unsplitStashValid = false
      }
      return true
    },
    noteRealNavigation(idx) {
      if (idx !== 0) return
      unsplitStash = null
      unsplitStashValid = false
    },
    invalidateStash() {
      unsplitStash = null
      unsplitStashValid = false
    },
    splitVisible() {
      return store.doc.nav.split && !spaceHidden
    },
    isSpaceHidden() {
      return spaceHidden
    },
    showSplit() {
      spaceHidden = false
      pulledByResize = false
    },
    setSpaceHidden(hidden) {
      if (spaceHidden === hidden) return false
      spaceHidden = hidden
      const nav = store.doc.nav
      if (hidden) {
        pulledByResize = false
        if (!nav.split || nav.focusedPane !== 1) return false
        store.updateNav((d) => {
          unsplitStash = d.nav.panes[0]
          unsplitStashValid = true
          d.nav.panes[0] = d.nav.panes[1]
          d.nav.focusedPane = 0
        })
        pulledByResize = true
        return true
      }
      // Widening. A manual un-split made while narrow, or a real navigation in
      // pane 0 (which drops the stash), both mean the user has moved on: leave it.
      const stash = unsplitStash
      const restore = pulledByResize && unsplitStashValid && stash !== null && nav.split
      pulledByResize = false
      if (!restore) return false
      unsplitStash = null
      unsplitStashValid = false
      store.updateNav((d) => {
        d.nav.panes[0] = stash
        d.nav.focusedPane = 1
      })
      return true
    },
    applyToggleSplit(wasVisible) {
      // Showing the split — even "anyway" while narrow — is the user overriding the
      // responsive hide; and any manual toggle supersedes a resize-made stash.
      if (!wasVisible) spaceHidden = false
      pulledByResize = false
      store.updateNav((d) => {
        d.nav.split = !wasVisible
        // Un-splitting hides pane 1 (pane 0 is never hidden) — leaving focus
        // stuck there would silently misdirect every focused-pane action at a
        // pane the user can no longer see. If pane 1 was focused, pull its
        // content into pane 0 so closing split keeps what the user was
        // looking at, stashing pane 0's own content first.
        if (!d.nav.split) {
          if (d.nav.focusedPane === 1) {
            unsplitStash = d.nav.panes[0]
            unsplitStashValid = true
            d.nav.panes[0] = d.nav.panes[1]
          } else {
            unsplitStash = null
            unsplitStashValid = false
          }
          d.nav.focusedPane = 0
        } else if (unsplitStashValid && unsplitStash) {
          d.nav.panes[0] = unsplitStash
          unsplitStash = null
          unsplitStashValid = false
        }
        // Remembers this choice per team so switching back restores it.
        if (d.nav.activeTeamId) d.nav.teamSplit[d.nav.activeTeamId] = d.nav.split
      })
    },
  }
}
