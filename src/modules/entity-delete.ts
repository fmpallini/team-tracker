// src/modules/entity-delete.ts — the delete flow shared by the card-style
// modules (action items, milestones, risks): delete with an undo
// toast, or a silent delete for blank rows. Each module used to carry its own copy of
// these three functions; they differ only in which team collection they touch,
// which @mention kind they unlink, and which strings they show.
//
// Invariants every caller inherits (each is pinned by that module's tests):
//
// - `remove` captures a DEEP copy of the whole team before running
//   `unlinkRefsInTeam`: that call rewrites @mentions in place across every
//   content-bearing section of the team (notes, people, actions, milestones,
//   risks — see core/refs.ts), so a shallow capture of just this collection
//   would restore the entity but leave every mention of it flattened.
// - Both variants write with scope `{ teamId }` and NO `sections`, for the same
//   reason: team-only is the narrowest scope that's still correct, and it
//   won't rot if unlinkRefsInTeam's reach changes (refs never cross teams).
// - `removeSilently` is for paths with no confirm dialog and no undo (a blank
//   draft dropped on blur, an empty-title delete click). deleteInTeamWithUndo's
//   structuredClone(team) is only worth paying for after an explicit,
//   confirmed user action (see core/undo-delete.ts's header), so a silent
//   delete skips the capture entirely rather than cloning a potentially
//   multi-MB team for nothing.
import type { Team } from '../core/types'
import { findTeam as docFindTeam } from '../core/document'
import { t, type MsgKey } from '../core/i18n'
import { unlinkRefsInTeam, type IdRefKind } from '../core/refs'
import { deleteInTeamWithUndo, type UndoOffer } from '../core/undo-delete'
import type { TeamItemCollection } from '../core/team-items'
import { offerUndoToast } from '../ui/undo-toast'
import type { ModuleCtx } from '../ui/panes'

export interface EntityDeleteConfig<K extends TeamItemCollection> {
  ctx: ModuleCtx
  teamId: string
  /** The Team array this module's entities live in. */
  collection: K
  /** The @mention kind whose references get flattened to plain text on delete. */
  refKind: IdRefKind
  /** The label shown in the toast and used to unlink mentions (a title or summary). */
  labelOf: (entity: Team[K][number]) => string
  /** Name of the `{param}` the toast message interpolates the label into. */
  labelParam: string
  /** The toast that follows a delete; the Undo button rides on it. */
  toast: MsgKey
  /**
   * Local UI state that must flip BEFORE store.update fires the synchronous
   * subscriber — e.g. collapsing an expanded follow-up editor so the rebuild
   * doesn't mount one for a row that's about to vanish.
   */
  beforeRemove?: (id: string) => void
  /**
   * Whether an entity is an untouched draft — nothing worth an undo
   * toast. Defaults to "its label is blank", which is only right for modules
   * whose label is the entity's only content; a risk, milestone or card with
   * no title can still carry a plan, follow-up, notes or an assignee, and
   * deleting THAT silently (no undo) is data loss.
   */
  isBlank?: (entity: Team[K][number]) => boolean
}

export interface EntityDelete<E> {
  /** Deletes with a deep capture; returns the undo offer (null if blocked or nothing found). */
  remove: (id: string) => UndoOffer | null
  /** Deletes with no capture and no undo — see the header for when that's right. */
  removeSilently: (id: string) => void
  /** Blank label → silent delete; otherwise `remove` + undo toast. No confirm: the Undo is the guard for a single item. */
  requestDelete: (entity: E, onDeleting?: () => void) => void
}

export function createEntityDelete<K extends TeamItemCollection>(cfg: EntityDeleteConfig<K>): EntityDelete<Team[K][number]> {
  type Entity = Team[K][number]
  const { ctx, teamId, collection, refKind, labelOf, labelParam, toast, beforeRemove, isBlank } = cfg
  const locale = ctx.locale

  // Team's collections are all `{ id: string }[]`; K only narrows which one.
  const listOf = (tm: Team): (Entity & { id: string })[] => tm[collection] as (Entity & { id: string })[]
  const dropFrom = (tm: Team, removed: Entity & { id: string }): void => {
    unlinkRefsInTeam(tm, refKind, new Map([[removed.id, labelOf(removed)]]))
    ;(tm as unknown as Record<string, unknown>)[collection] = listOf(tm).filter((e) => e.id !== removed.id)
  }

  function remove(id: string): UndoOffer | null {
    beforeRemove?.(id)
    return deleteInTeamWithUndo(ctx.store, teamId,
      (tm) => listOf(tm).some((e) => e.id === id),
      (tm) => { dropFrom(tm, listOf(tm).find((e) => e.id === id)!) },
      { teamId })
  }

  function removeSilently(id: string): void {
    beforeRemove?.(id)
    ctx.store.update((d) => {
      const tm = docFindTeam(d, teamId)
      if (!tm) return
      const removed = listOf(tm).find((e) => e.id === id)
      if (!removed) return
      dropFrom(tm, removed)
    }, { teamId })
  }

  // `onDeleting` runs right before the removal, so a caller that has an editor
  // open on the entity (the action-item card) can close it only once the
  // delete is certain.
  function requestDelete(entity: Entity, onDeleting?: () => void): void {
    const rawLabel = labelOf(entity)
    const id = (entity as Entity & { id: string }).id
    onDeleting?.()
    // A titled item is undoable; an untitled one is silent only if it is also an untouched draft.
    if (rawLabel.trim() === '' && (isBlank ? isBlank(entity) : true)) {
      removeSilently(id) // nothing meaningful to lose
      return
    }
    // Only reachable with a blank label when `isBlank` says there IS content.
    const label = rawLabel.trim() === '' ? t(locale, 'untitled_item') : rawLabel
    const offer = remove(id)
    offerUndoToast(ctx.store, locale, t(locale, toast, { [labelParam]: label }), offer)
  }

  return { remove, removeSilently, requestDelete }
}
