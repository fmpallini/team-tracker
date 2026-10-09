// src/modules/entity-delete.ts — the delete flow shared by the card-style
// modules (action items, milestones, risks): confirm → delete with undo, or a
// silent delete for blank rows. Each module used to carry its own copy of
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
//   draft dropped on blur, an empty-title delete click). deleteWithUndo's
//   structuredClone(team) is only worth paying for after an explicit,
//   confirmed user action (see core/undo-delete.ts's header), so a silent
//   delete skips the capture entirely rather than cloning a potentially
//   multi-MB team for nothing.
import type { Team } from '../core/types'
import { findTeam as docFindTeam } from '../core/document'
import { t, type MsgKey } from '../core/i18n'
import { unlinkRefsInTeam, type IdRefKind } from '../core/refs'
import { deleteWithUndo, type UndoOffer } from '../core/undo-delete'
import type { TeamItemCollection } from '../core/team-items'
import { confirmDelete } from '../ui/modal'
import { offerUndoToast } from '../ui/undo-toast'
import type { ModuleCtx } from '../ui/panes'

export interface EntityDeleteConfig<K extends TeamItemCollection> {
  ctx: ModuleCtx
  teamId: string
  /** The Team array this module's entities live in. */
  collection: K
  /** The @mention kind whose references get flattened to plain text on delete. */
  refKind: IdRefKind
  /** The label shown in the confirm/toast and used to unlink mentions (a title or summary). */
  labelOf: (entity: Team[K][number]) => string
  /** Name of the `{param}` the three messages below interpolate the label into. */
  labelParam: string
  messages: { title: MsgKey; confirm: MsgKey; button: MsgKey; toast: MsgKey }
  /** 'danger' for the one module (action items) that styles its confirm button that way. */
  variant?: 'danger' | 'primary'
  /**
   * Local UI state that must flip BEFORE store.update fires the synchronous
   * subscriber — e.g. collapsing an expanded follow-up editor so the rebuild
   * doesn't mount one for a row that's about to vanish.
   */
  beforeRemove?: (id: string) => void
}

export interface EntityDelete<E> {
  /** Deletes with a deep capture; returns the undo offer (null if blocked or nothing found). */
  remove: (id: string) => UndoOffer | null
  /** Deletes with no capture and no undo — see the header for when that's right. */
  removeSilently: (id: string) => void
  /** Blank label → silent delete; otherwise confirm dialog, then `remove` + undo toast. */
  requestDelete: (entity: E, onDeleting?: () => void) => void
}

export function createEntityDelete<K extends TeamItemCollection>(cfg: EntityDeleteConfig<K>): EntityDelete<Team[K][number]> {
  type Entity = Team[K][number]
  const { ctx, teamId, collection, refKind, labelOf, labelParam, messages, variant, beforeRemove } = cfg
  const locale = ctx.locale

  // Team's collections are all `{ id: string }[]`; K only narrows which one.
  const listOf = (tm: Team): (Entity & { id: string })[] => tm[collection] as (Entity & { id: string })[]
  const dropFrom = (tm: Team, removed: Entity & { id: string }): void => {
    unlinkRefsInTeam(tm, refKind, new Map([[removed.id, labelOf(removed)]]))
    ;(tm as unknown as Record<string, unknown>)[collection] = listOf(tm).filter((e) => e.id !== removed.id)
  }

  function remove(id: string): UndoOffer | null {
    beforeRemove?.(id)
    return deleteWithUndo(ctx.store, (d) => {
      const tm = docFindTeam(d, teamId)
      if (!tm) return null
      const removed = listOf(tm).find((e) => e.id === id)
      if (!removed) return null
      const before = structuredClone(tm)
      dropFrom(tm, removed)
      return (d2) => {
        const i = d2.teams.findIndex((t2) => t2.id === teamId)
        if (i !== -1) d2.teams[i] = before
      }
    }, { teamId })
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

  // `onDeleting` runs only once the delete is certain (right before the removal,
  // after the confirm is accepted), never on Cancel — so a caller that has an
  // editor open on the entity (the action-item card) can keep it up behind the
  // confirm and close it only if the user goes through with it.
  function requestDelete(entity: Entity, onDeleting?: () => void): void {
    const label = labelOf(entity)
    const id = (entity as Entity & { id: string }).id
    if (label.trim() === '') {
      onDeleting?.()
      removeSilently(id) // an empty label carries no meaningful content to lose
      return
    }
    confirmDelete(locale, {
      title: t(locale, messages.title),
      message: t(locale, messages.confirm, { [labelParam]: label }),
      confirmLabel: t(locale, messages.button),
      ...(variant ? { variant } : {}),
      onConfirm: () => {
        onDeleting?.()
        const offer = remove(id)
        offerUndoToast(ctx.store, locale, t(locale, messages.toast, { [labelParam]: label }), offer)
      },
    })
  }

  return { remove, removeSilently, requestDelete }
}
