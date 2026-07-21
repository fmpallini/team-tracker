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

export interface CardContextMenuActions {
  duplicate(itemId: string): void
  transfer(itemId: string, targetTeamId: string, mode: 'copy' | 'move'): void
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
  showContextMenu(x, y, menuItems)
}
