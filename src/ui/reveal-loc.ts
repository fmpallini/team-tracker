// src/ui/reveal-loc.ts — "take me there" from outside any pane: a search
// result, a due item, a palette row. Each re-targets the focused pane, so each
// must first close a modeless card modal open in some pane (flushing its notes
// editor) and must stop if that card refuses to close (its required-name
// guard) — otherwise the pane under the card is torn down without its own
// close, or, when the team switch is the part that got refused, the pane opens
// another team's content under the old team. ui/atref.ts's navigateToLoc is
// the pane-relative sibling (an @ref click, which may route to the other pane).
import type { Store } from '../core/store'
import type { Loc } from '../core/types'
import type { PaneManager } from './panes'
import { dismissModelessModals } from './modal'
import { focusItemInPane } from './search-highlight'

export interface RevealLocDeps {
  store: Store
  pm: Pick<PaneManager, 'openInFocused'>
  /** main.ts's selectTeam: switches team, restoring both panes' last modules for it. */
  selectTeam(teamId: string): void
}

/**
 * Opens `loc` in the focused pane — switching to its team first when it is not
 * the active one — and brings its item (and any search `terms`) into view.
 * Returns false, having done nothing, when an open card refuses to close.
 */
export function revealLoc(deps: RevealLocDeps, loc: Loc, opts?: { terms?: readonly string[] }): boolean {
  if (!dismissModelessModals()) return false
  if (loc.teamId !== deps.store.doc.nav.activeTeamId) deps.selectTeam(loc.teamId)
  deps.pm.openInFocused(loc)
  const itemId = 'itemId' in loc.ref ? loc.ref.itemId : undefined
  focusItemInPane(deps.store.doc.nav.focusedPane, itemId, opts?.terms)
  return true
}
