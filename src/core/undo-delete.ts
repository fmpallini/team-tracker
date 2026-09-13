// src/core/undo-delete.ts — one-level undo for deletions.
//
// Every delete in the app is permanent the moment its confirm dialog is
// accepted; the daily backup mirror can be 24h stale, so it is not an undo.
// This gives each delete a short window in which the exact pre-delete state
// can be put back.
//
// Capture-and-restore rather than a hand-written inverse operation,
// deliberately: a delete does not only remove an entity. Most call sites also
// run `unlinkRefsInTeam()` (see core/refs.ts), which rewrites every
// @[label](kind:id) mention of the deleted item into plain text IN PLACE
// across the whole team — daily notes, generalNotes, person notes, action
// notes and assignee, milestone and risk followups. Person-delete also
// re-parents the deleted node's children and renumbers their siblings'
// `order`. An inverse would have to recompute and reverse all of that;
// restoring a deep copy gets it right by construction.
//
// Adding a new delete site: capture deep enough to include every in-place
// rewrite your delete performs, not just the array the deleted entity lived
// in — a shallow copy of that one array (e.g. `[...tm.risks]`) restores the
// entity but leaves unlinkRefsInTeam's rewrites (or any other in-place edit
// made alongside the removal) permanently applied, which is silent data loss
// wearing the shape of a correct restore. And a test that never plants an
// `@`-mention of the deleted item in a field unlinkRefsInTeam sweeps (a daily
// note, a person's notes, another item's notes/followup — see refs.ts) proves
// nothing either way: a too-shallow capture and a correct one produce
// byte-identical results on a fixture with no mentions to lose. Every
// existing site's own test happens to plant one for exactly this reason —
// match that when adding a new one.
import type { Doc } from './types'
import type { Store } from './store'
import type { ChangeScope } from './scope'

export interface UndoOffer {
  /** False once anything else has mutated the document, or the tab went read-only. */
  isAvailable(): boolean
  /** Restores the captured state. Returns false (and writes nothing) when unavailable. */
  undo(): boolean
}

/**
 * Runs `mutate` inside a single `store.update(fn, scope)` and returns an
 * offer to undo it.
 *
 * `mutate` captures whatever it needs, performs the delete, and returns a
 * closure that restores the capture — or `null` when it found nothing to
 * delete. Returns `null` when the update was blocked (read-only tab) or
 * `mutate` reported nothing deleted; callers then show a plain toast with no
 * action button.
 *
 * Staleness is guarded by `store.rev`, which is bumped by `update()`,
 * `updateNav()` AND `replaceDoc()` — so one comparison covers every way the
 * document can move on, a conflict-modal reload included. Restoring a capture
 * after some later edit would silently revert that edit; instead the offer
 * simply expires the moment the user does anything else.
 */
export function deleteWithUndo(
  store: Store,
  mutate: (d: Doc) => ((d: Doc) => void) | null,
  scope?: ChangeScope,
): UndoOffer | null {
  const revBefore = store.rev
  let restore: ((d: Doc) => void) | null = null
  store.update((d) => { restore = mutate(d) }, scope)
  // rev is unchanged when update() was blocked by read-only mode — it returns
  // silently rather than throwing, so this is the only way to detect it.
  if (store.rev === revBefore) return null
  const captured = restore as ((d: Doc) => void) | null
  if (!captured) return null
  const revAfter = store.rev

  const available = (): boolean => store.rev === revAfter && !store.readOnly

  return {
    isAvailable: available,
    undo(): boolean {
      if (!available()) return false
      store.update((d) => { captured(d) }, scope)
      return true
    },
  }
}
