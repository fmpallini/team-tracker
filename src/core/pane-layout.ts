// src/core/pane-layout.ts — the transient (never-persisted) half of pane
// layout state, extracted out of ui/panes.ts so navigation policy lives apart
// from DOM rendering. Nothing here touches the DOM.
import type { Store } from './store'
import type { PaneState } from './types'
import { currentLoc, navigateHistory } from './nav'

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

  return {
    stepHistory(idx, dir) {
      const nav = store.doc.nav
      const other = currentLoc(nav.panes[otherPaneIdx(idx)])
      const result = navigateHistory(nav.panes[idx], dir, other)
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
    noteRealNavigation(idx) {
      if (idx !== 0) return
      unsplitStash = null
      unsplitStashValid = false
    },
    invalidateStash() {
      unsplitStash = null
      unsplitStashValid = false
    },
    applyToggleSplit(wasVisible) {
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
