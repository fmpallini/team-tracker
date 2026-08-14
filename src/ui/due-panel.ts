// src/ui/due-panel.ts — standalone renderer for the overdue/due-soon list
// modal. Takes pre-computed DueBuckets (sidebar.ts owns the today-keyed
// cache) and an onOpenItem callback instead of touching Store/PaneManager
// directly, so every caller (sidebar's global button, per-team badges, the
// header pill, the command palette) can reuse the exact same modal.
import type { DueBuckets, DueItem } from '../core/due'
import type { Loc } from '../core/types'
import { t, todayIso, formatDate, type Locale } from '../core/i18n'
import { diffDays } from '../core/date'
import { KIND_ICON } from '../core/search'
import { REF_KINDS } from '../core/refs'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'

export interface DuePanelOpts {
  locale: Locale
  buckets: DueBuckets
  /** Omit to show every team; set to scope the panel to one team. */
  teamId?: string
  /** Required when teamId is set — used in the modal title. */
  teamName?: string
  onOpenItem: (loc: Loc) => void
}

/** Pure, exported for unit testing without touching the DOM. */
export function filterBucketsByTeam(buckets: DueBuckets, teamId: string | undefined): DueBuckets {
  if (teamId === undefined) return buckets
  return {
    overdue: buckets.overdue.filter((it) => it.loc.teamId === teamId),
    dueSoon: buckets.dueSoon.filter((it) => it.loc.teamId === teamId),
  }
}

function relLabel(locale: Locale, dateIso: string): string {
  const today = todayIso()
  if (dateIso < today) return t(locale, 'due_overdue_by', { days: String(diffDays(today, dateIso)) })
  return t(locale, 'due_in_days', { days: String(diffDays(dateIso, today)) })
}

function renderDueRow(locale: Locale, item: DueItem, showTeam: boolean, onOpenItem: (loc: Loc) => void, closeModal: () => void): HTMLElement {
  const icon = KIND_ICON[REF_KINDS[item.kind].moduleKind]
  function activate(): void {
    closeModal()
    onOpenItem(item.loc)
  }
  const row = el(
    'div',
    {
      class: 'tt-due-row',
      tabindex: '0',
      onclick: activate,
    },
    el('span', { class: 'tt-due-row-icon' }, icon),
    el('span', { class: 'tt-due-row-title' }, item.title),
    // The team name only carries information when the panel spans multiple
    // teams — a team-scoped panel (teamId set) already says which team it's
    // for in the modal title, so repeating it on every row is just noise.
    ...(showTeam ? [el('span', { class: 'tt-due-row-team' }, item.teamName)] : []),
    el('span', { class: 'tt-due-row-date' }, `${formatDate(item.date, locale)} · ${relLabel(locale, item.date)}`)
  )
  // Guarded on e.target === row (mirrors risks.ts/milestones.ts's row nav):
  // Enter/Space activates the row, Up/Down moves focus to the next/previous
  // row so the whole list is walkable without a mouse.
  row.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent
    if (ev.target !== row) return
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      activate()
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const rows = Array.from(row.parentElement?.querySelectorAll<HTMLElement>('.tt-due-row') ?? [])
      const next = rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]
      if (!next) return
      ev.preventDefault()
      next.focus()
    }
  })
  return row
}

export function openDuePanel(opts: DuePanelOpts): void {
  const { locale, teamId, teamName, onOpenItem } = opts
  const buckets = filterBucketsByTeam(opts.buckets, teamId)
  let handle: ModalHandle | null = null
  const closeModal = (): void => { handle?.close() }
  const showTeam = teamId === undefined
  const sections: HTMLElement[] = []
  if (buckets.overdue.length + buckets.dueSoon.length === 0) {
    sections.push(el('p', { class: 'tt-modal-message' }, t(locale, 'due_empty')))
  } else {
    if (buckets.overdue.length > 0) {
      sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale, 'due_section_overdue')))
      sections.push(...buckets.overdue.map((it) => renderDueRow(locale, it, showTeam, onOpenItem, closeModal)))
    }
    if (buckets.dueSoon.length > 0) {
      sections.push(el('div', { class: 'tt-due-section-heading' }, t(locale, 'due_section_due_soon')))
      sections.push(...buckets.dueSoon.map((it) => renderDueRow(locale, it, showTeam, onOpenItem, closeModal)))
    }
  }
  const body = el('div', { class: 'tt-due-list' }, ...sections)
  const title = teamId !== undefined ? `${t(locale, 'due_panel_title')} · ${teamName}` : t(locale, 'due_panel_title')
  const closeBtn: ModalButton = { label: t(locale, 'ok'), primary: true, onClick: closeModal }
  handle = showModal({ title, body, buttons: [closeBtn] })
}
