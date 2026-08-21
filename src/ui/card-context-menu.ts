// src/ui/card-context-menu.ts — the right-click menu shared by action items,
// milestones and risks: duplicate (same team) plus copy/move to another
// team when more than one team exists. Each caller supplies its own
// duplicate/transfer callbacks (backed by src/core/card-transfer.ts's
// per-kind functions) since the menu itself has no notion of which list a
// card belongs to.
import type { Team } from '../core/types'
import { t, type Locale } from '../core/i18n'
import { showContextMenu, type ContextMenuItem } from './context-menu'
import { openTeamPickerModal, openTeamColumnPickerModal } from './team-picker-modal'
import type { ModuleCtx } from './panes'
import {
  duplicateActionItem, transferActionItem,
  duplicateMilestone, transferMilestone,
  duplicateRisk, transferRisk,
} from '../core/card-transfer'

export interface CardContextMenuActions {
  duplicate(itemId: string): void
  transfer(itemId: string, targetTeamId: string, mode: 'copy' | 'move', targetStatus?: string): void
  delete(itemId: string): void
}

function openTransferModal(
  locale: Locale, itemId: string, mode: 'copy' | 'move', otherTeams: Team[], actions: CardContextMenuActions,
  getColumnsForTeam?: (team: Team) => { id: string; label: string }[]
): void {
  const title = t(locale, mode === 'copy' ? 'team_picker_copy_title' : 'team_picker_move_title')
  if (getColumnsForTeam) {
    openTeamColumnPickerModal({
      title, confirmLabel: t(locale, 'team_picker_confirm_btn'), cancelLabel: t(locale, 'cancel'),
      columnLabel: t(locale, 'kanban_transfer_column_label'),
      teams: otherTeams, getColumns: getColumnsForTeam,
      onConfirm: (targetTeamId, targetStatus) => actions.transfer(itemId, targetTeamId, mode, targetStatus),
    })
    return
  }
  openTeamPickerModal({
    title, confirmLabel: t(locale, 'team_picker_confirm_btn'), cancelLabel: t(locale, 'cancel'),
    teams: otherTeams,
    onConfirm: (targetTeamId) => actions.transfer(itemId, targetTeamId, mode),
  })
}

export function showCardContextMenu(
  locale: Locale, teamId: string, allTeams: Team[], itemId: string, x: number, y: number, actions: CardContextMenuActions,
  getColumnsForTeam?: (team: Team) => { id: string; label: string }[]
): void {
  const otherTeams = allTeams.filter((tm) => tm.id !== teamId)
  const menuItems: ContextMenuItem[] = [
    { label: t(locale, 'context_menu_duplicate'), onClick: () => actions.duplicate(itemId) },
  ]
  if (otherTeams.length > 0) {
    menuItems.push({ label: t(locale, 'context_menu_copy_to_team'), onClick: () => openTransferModal(locale, itemId, 'copy', otherTeams, actions, getColumnsForTeam) })
    menuItems.push({ label: t(locale, 'context_menu_move_to_team'), onClick: () => openTransferModal(locale, itemId, 'move', otherTeams, actions, getColumnsForTeam) })
  }
  menuItems.push({ label: t(locale, 'context_menu_delete'), danger: true, onClick: () => actions.delete(itemId) })
  showContextMenu(x, y, menuItems)
}

export type CardKind = 'action' | 'milestone' | 'risk'

const DUPLICATE_FNS: Record<CardKind, (team: Team, itemId: string) => void> = {
  action: duplicateActionItem,
  milestone: duplicateMilestone,
  risk: duplicateRisk,
}

const TRANSFER_FNS: Record<CardKind, (teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move', targetStatus?: string) => void> = {
  action: transferActionItem,
  milestone: transferMilestone,
  risk: transferRisk,
}

/** Wires showCardContextMenu's duplicate/transfer callbacks to the right per-kind core/card-transfer.ts function, so action-items.ts/milestones.ts/risks.ts don't each hand-roll the same store.update wrapper. `onDelete` is the caller's own confirm-then-remove flow (it already has the full item in scope for the confirmation message), invoked here rather than folded into DUPLICATE_FNS/TRANSFER_FNS since deletion needs a confirmation dialog, not a bare store mutation. `getColumnsForTeam` is only supplied for the 'action' kind, so cross-team copy/move for action items opens the combined team+column picker (Task 10) instead of the plain team-only one — milestones/risks have no kanban columns, so they keep the original picker. */
export function openItemContextMenu(ctx: ModuleCtx, kind: CardKind, teamId: string, itemId: string, x: number, y: number, onDelete: () => void): void {
  const getColumnsForTeam = kind === 'action'
    ? (team: Team) => [
        { id: 'todo', label: t(ctx.locale, 'kanban_status_todo') },
        ...[...(team.actionColumns ?? [])].sort((a, b) => a.order - b.order).map((c) => ({ id: c.id, label: c.name })),
        { id: 'done', label: t(ctx.locale, 'kanban_status_done') },
        { id: 'cancelled', label: t(ctx.locale, 'kanban_status_cancelled') },
      ]
    : undefined
  showCardContextMenu(ctx.locale, teamId, ctx.store.doc.teams, itemId, x, y, {
    duplicate: (id) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (tm) DUPLICATE_FNS[kind](tm, id)
      })
    },
    transfer: (id, targetTeamId, mode, targetStatus) => {
      ctx.store.update((d) => {
        TRANSFER_FNS[kind](d.teams, id, teamId, targetTeamId, mode, targetStatus)
      })
    },
    delete: () => onDelete(),
  }, getColumnsForTeam)
}
