// src/ui/card-context-menu.ts — the right-click menu shared by action items,
// milestones and risks: duplicate (same team) plus copy/move to another
// team when more than one team exists. Each caller supplies its own
// duplicate/transfer callbacks (backed by src/core/card-transfer.ts's
// per-kind functions) since the menu itself has no notion of which list a
// card belongs to.
import type { Team } from '../core/types'
import { t, type Locale } from '../core/i18n'
import { showContextMenu, type ContextMenuItem } from './context-menu'
import { openTeamPickerModal } from './team-picker-modal'
import type { ModuleCtx } from './panes'
import {
  duplicateActionItem, transferActionItem,
  duplicateMilestone, transferMilestone,
  duplicateRisk, transferRisk,
} from '../core/card-transfer'

export interface CardContextMenuActions {
  duplicate(itemId: string): void
  transfer(itemId: string, targetTeamId: string, mode: 'copy' | 'move'): void
  delete(itemId: string): void
}

function openTransferModal(
  locale: Locale, itemId: string, mode: 'copy' | 'move', otherTeams: Team[], actions: CardContextMenuActions
): void {
  openTeamPickerModal({
    title: t(locale, mode === 'copy' ? 'team_picker_copy_title' : 'team_picker_move_title'),
    confirmLabel: t(locale, 'team_picker_confirm_btn'),
    cancelLabel: t(locale, 'cancel'),
    teams: otherTeams,
    onConfirm: (targetTeamId) => actions.transfer(itemId, targetTeamId, mode),
  })
}

export function showCardContextMenu(
  locale: Locale, teamId: string, allTeams: Team[], itemId: string, x: number, y: number, actions: CardContextMenuActions
): void {
  const otherTeams = allTeams.filter((tm) => tm.id !== teamId)
  const menuItems: ContextMenuItem[] = [
    { label: t(locale, 'context_menu_duplicate'), onClick: () => actions.duplicate(itemId) },
  ]
  if (otherTeams.length > 0) {
    menuItems.push({ label: t(locale, 'context_menu_copy_to_team'), onClick: () => openTransferModal(locale, itemId, 'copy', otherTeams, actions) })
    menuItems.push({ label: t(locale, 'context_menu_move_to_team'), onClick: () => openTransferModal(locale, itemId, 'move', otherTeams, actions) })
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

const TRANSFER_FNS: Record<CardKind, (teams: Team[], itemId: string, fromTeamId: string, toTeamId: string, mode: 'copy' | 'move') => void> = {
  action: transferActionItem,
  milestone: transferMilestone,
  risk: transferRisk,
}

/** Wires showCardContextMenu's duplicate/transfer callbacks to the right per-kind core/card-transfer.ts function, so action-items.ts/milestones.ts/risks.ts don't each hand-roll the same store.update wrapper. `onDelete` is the caller's own confirm-then-remove flow (it already has the full item in scope for the confirmation message), invoked here rather than folded into DUPLICATE_FNS/TRANSFER_FNS since deletion needs a confirmation dialog, not a bare store mutation. */
export function openItemContextMenu(ctx: ModuleCtx, kind: CardKind, teamId: string, itemId: string, x: number, y: number, onDelete: () => void): void {
  showCardContextMenu(ctx.locale, teamId, ctx.store.doc.teams, itemId, x, y, {
    duplicate: (id) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (tm) DUPLICATE_FNS[kind](tm, id)
      })
    },
    transfer: (id, targetTeamId, mode) => {
      ctx.store.update((d) => {
        TRANSFER_FNS[kind](d.teams, id, teamId, targetTeamId, mode)
      })
    },
    delete: () => onDelete(),
  })
}
