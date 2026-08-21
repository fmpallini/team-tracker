// src/ui/team-picker-modal.ts — single-team picker used by the card
// copy/move-to-team context menu actions (action items, milestones, risks)
// to choose the destination team. Locale-agnostic: callers pass already-
// translated labels, same convention as ui/modal.ts's ModalButton.
import type { Team } from '../core/types'
import { showModal, type ModalButton, type ModalHandle } from './modal'
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
    select.appendChild(el('option', { value: team.id }, team.emoji ? `${team.emoji} ${team.name}` : team.name))
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

export function openTeamColumnPickerModal(opts: {
  title: string
  confirmLabel: string
  cancelLabel: string
  columnLabel: string
  teams: Team[]
  getColumns: (team: Team) => { id: string; label: string }[]
  onConfirm: (targetTeamId: string, targetStatus: string) => void
}): void {
  const teamSelect = el('select', { class: 'tt-input' }) as HTMLSelectElement
  for (const team of opts.teams) {
    teamSelect.appendChild(el('option', { value: team.id }, team.emoji ? `${team.emoji} ${team.name}` : team.name))
  }
  const columnSelect = el('select', { class: 'tt-input' }) as HTMLSelectElement
  function populateColumns(team: Team): void {
    columnSelect.innerHTML = ''
    for (const c of opts.getColumns(team)) columnSelect.appendChild(el('option', { value: c.id }, c.label))
  }
  populateColumns(opts.teams[0]!)
  teamSelect.addEventListener('change', () => {
    const team = opts.teams.find((t) => t.id === teamSelect.value)
    if (team) populateColumns(team)
  })
  const body = el(
    'div', { class: 'tt-prefs-field' },
    teamSelect,
    el('label', { class: 'tt-field' }, opts.columnLabel, columnSelect)
  )

  const cancelBtn: ModalButton = { label: opts.cancelLabel, onClick: () => handle.close() }
  const confirmBtn: ModalButton = {
    label: opts.confirmLabel,
    primary: true,
    onClick: () => {
      const targetTeamId = teamSelect.value
      const targetStatus = columnSelect.value
      handle.close()
      if (targetTeamId && targetStatus) opts.onConfirm(targetTeamId, targetStatus)
    },
  }
  const handle: ModalHandle = showModal({ title: opts.title, body, buttons: [cancelBtn, confirmBtn] })
}
