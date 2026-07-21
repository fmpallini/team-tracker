// src/ui/team-picker-modal.ts — single-team picker used by the card
// copy/move-to-team context menu actions (action items, milestones, risks)
// to choose the destination team. Locale-agnostic: callers pass already-
// translated labels, same convention as ui/modal.ts's ModalButton.
import type { Team } from '../core/types'
import { showModal, type ModalButton } from './modal'
import { el } from './dom'

export function openTeamPickerModal(opts: {
  title: string
  confirmLabel: string
  cancelLabel: string
  teams: Team[]
  onConfirm: (targetTeamId: string) => void
}): void {
  const select = el('select', { class: 'tt-input' }) as HTMLSelectElement
  for (const team of opts.teams) {
    select.appendChild(el('option', { value: team.id }, `${team.emoji} ${team.name}`))
  }
  const body = el('div', { class: 'tt-prefs-field' }, select)

  const cancelBtn: ModalButton = { label: opts.cancelLabel, onClick: () => handle.close() }
  const confirmBtn: ModalButton = {
    label: opts.confirmLabel,
    primary: true,
    onClick: () => {
      const targetId = select.value
      handle.close()
      if (targetId) opts.onConfirm(targetId)
    },
  }
  const handle = showModal({ title: opts.title, body, buttons: [cancelBtn, confirmBtn] })
}
