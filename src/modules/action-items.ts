// src/modules/action-items.ts — kanban board (To Do / WIP / Done+Cancelled)
// for a team's action items. Cards are edited exclusively through a modal
// (openEditModal below); the board itself has no live inputs, so a full
// rebuild on every store change (like src/modules/people-tree.ts's
// renderAll) is simplest and correct — unlike the old flat-list version,
// there's no in-progress inline edit whose caret needs preserving across a
// foreign store update.
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { el } from '../ui/dom'

/** Per-container disposers — see the extensive comment on the same pattern in src/modules/daily-notes.ts. */
const disposers = new WeakMap<HTMLElement, () => void>()

const COLORS: ActionItem['color'][] = ['slate', 'brass', 'sage', 'rust', 'plum', 'ledger']
const COLOR_KEYS: Record<ActionItem['color'], 'kanban_color_slate' | 'kanban_color_brass' | 'kanban_color_sage' | 'kanban_color_rust' | 'kanban_color_plum' | 'kanban_color_ledger'> = {
  slate: 'kanban_color_slate', brass: 'kanban_color_brass', sage: 'kanban_color_sage',
  rust: 'kanban_color_rust', plum: 'kanban_color_plum', ledger: 'kanban_color_ledger',
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}
function nowHHMM(): string {
  const now = new Date()
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

// --- pure, unit-testable helpers -------------------------------------------

/** Items in `status`, sorted by `order`. */
export function itemsByStatus(items: ActionItem[], status: ActionItem['status']): ActionItem[] {
  return items.filter((i) => i.status === status).sort((a, b) => a.order - b.order)
}

/** True when the item has a due date strictly before `today` and is still active (not done/cancelled). */
export function isOverdue(item: Pick<ActionItem, 'dueDate' | 'status'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && item.status !== 'done' && item.status !== 'cancelled'
}

/** Maps a drop's vertical offset within the target card to before/after. Degenerates to 'after' for a non-positive `height` (cards not yet laid out, e.g. in a test without real layout) rather than dividing by zero. */
export function computeDropPosition(offsetY: number, height: number): 'before' | 'after' {
  if (height <= 0) return 'after'
  return offsetY < height / 2 ? 'before' : 'after'
}

/**
 * Moves `draggedId` to `status`, positioned before/after `targetId` within
 * that status group (or appended at the end when `targetId` is null or not
 * found in the group — e.g. dropped on empty column space). Renumbers
 * `order` densely within both the destination group and, if the status
 * changed, the now-shrunk source group. Mutates `items` in place so it can
 * run directly inside a `store.update` callback. No-op when `draggedId`
 * doesn't exist, or when it's dropped onto itself without a status change.
 */
export function moveCard(items: ActionItem[], draggedId: string, status: ActionItem['status'], targetId: string | null, position: 'before' | 'after'): void {
  const dragged = items.find((i) => i.id === draggedId)
  if (!dragged) return
  if (dragged.status === status && draggedId === targetId) return
  const oldStatus = dragged.status
  dragged.status = status
  const destGroup = items.filter((i) => i.status === status && i.id !== draggedId).sort((a, b) => a.order - b.order)
  const targetIdx = targetId === null ? -1 : destGroup.findIndex((i) => i.id === targetId)
  const insertAt = targetIdx === -1 ? destGroup.length : (position === 'before' ? targetIdx : targetIdx + 1)
  destGroup.splice(insertAt, 0, dragged)
  destGroup.forEach((i, idx) => { i.order = idx })
  if (oldStatus !== status) {
    const oldGroup = items.filter((i) => i.status === oldStatus).sort((a, b) => a.order - b.order)
    oldGroup.forEach((i, idx) => { i.order = idx })
  }
}

// --- renderer ---------------------------------------------------------------

export function renderActionItems(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'actions') return // registered only for 'actions'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale
  const datalistId = `tt-kanban-people-${Math.random().toString(36).slice(2)}`

  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function items(): ActionItem[] {
    return findTeam()?.actionItems ?? []
  }

  let draggedId: string | null = null

  function clearDropClasses(): void {
    boardEl.querySelectorAll('.tt-kanban-card').forEach((n) => {
      n.classList.remove('tt-kanban-drop-before', 'tt-kanban-drop-after')
    })
  }

  function getPeople(): AtPerson[] {
    const tm = findTeam()
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  function removeItem(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
    })
  }

  function openDeleteConfirm(item: ActionItem): void {
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'kanban_delete_confirm', { summary: item.summary }))
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'kanban_delete_btn'),
      danger: true,
      onClick: () => {
        removeItem(item.id)
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function requestDelete(item: ActionItem): void {
    if (item.summary.trim() === '') {
      removeItem(item.id) // empty cards carry no meaningful content to lose — delete silently
      return
    }
    openDeleteConfirm(item)
  }

  function clearZone(status: ActionItem['status']): void {
    const count = itemsByStatus(items(), status).length
    if (count === 0) return
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'kanban_clear_zone_confirm', { count: String(count) }))
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'kanban_clear_zone_btn'),
      danger: true,
      onClick: () => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_clear_zone_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  interface ModalBundle { editor: Editor; atHandle: AtAutocompleteHandle; tplHandle: TemplatePickerHandle }
  let openBundle: ModalBundle | null = null

  /** Full CRUD modal: `existing === null` creates a new card in `defaultStatus`; otherwise edits/deletes `existing`. Mirrors src/modules/people-tree.ts's openPersonModal shape, plus a rich-text notes editor (created on open, destroyed on close) wired exactly like the old inline renderNotesRow (@ref autocomplete + '/' template picker). */
  function openEditModal(existing: ActionItem | null, defaultStatus: 'todo' | 'wip' = 'todo'): void {
    const summaryInput = el('input', { type: 'text', class: 'tt-input', value: existing?.summary ?? '' }) as HTMLInputElement
    const dueInput = el('input', { type: 'date', class: 'tt-input', value: existing?.dueDate ?? '' }) as HTMLInputElement
    const assigneeInput = el('input', { type: 'text', class: 'tt-input', list: datalistId, value: existing?.assignee ?? '' }) as HTMLInputElement
    let selectedColor: ActionItem['color'] = existing?.color ?? 'ledger'
    const errorEl = el('div', { class: 'tt-field-error' })

    const editor: Editor = createEditor(
      { onChange() {}, onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId), onAtTrigger() {}, onSlashTrigger() {} },
      lc
    )
    editor.setMd(existing?.notes ?? '')
    const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
    const tplHandle = attachTemplatePicker(editor, {
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getCtx: () => ({ dateIso: todayIso(), time: nowHHMM(), teamName: findTeam()?.name, locale: lc }),
      locale: lc,
    })
    openBundle = { editor, atHandle, tplHandle }

    const colorRow = el('div', { class: 'tt-kanban-color-row' })
    function paintSelectedColor(): void {
      colorRow.querySelectorAll('.tt-kanban-color-chip').forEach((chip) => {
        chip.classList.toggle('selected', chip.getAttribute('data-color') === selectedColor)
      })
    }
    for (const c of COLORS) {
      colorRow.appendChild(
        el('button', {
          type: 'button', class: `tt-kanban-color-chip color-${c}`, 'data-color': c, title: t(lc, COLOR_KEYS[c]),
          onclick: () => { selectedColor = c; paintSelectedColor() },
        })
      )
    }
    paintSelectedColor()

    const body = el(
      'div',
      { class: 'tt-kanban-form' },
      el('label', { class: 'tt-field' }, t(lc, 'kanban_summary_label'), summaryInput),
      el('div', { class: 'tt-field' }, t(lc, 'kanban_notes_label'), editor.root),
      el(
        'div',
        { class: 'tt-kanban-form-row' },
        el('label', { class: 'tt-field' }, t(lc, 'kanban_due_label'), dueInput),
        el('label', { class: 'tt-field' }, t(lc, 'kanban_assignee_label'), assigneeInput)
      ),
      el('div', { class: 'tt-field' }, t(lc, 'kanban_color_label'), colorRow),
      errorEl
    )

    function closeModal(): void {
      handle.close()
    }

    function save(): void {
      const summary = summaryInput.value.trim()
      if (summary === '') {
        errorEl.textContent = t(lc, 'kanban_summary_required')
        return
      }
      const dueDate = dueInput.value === '' ? null : dueInput.value
      const assignee = assigneeInput.value
      const notes = editor.getMd()
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        if (existing === null) {
          const group = itemsByStatus(tm.actionItems, defaultStatus)
          tm.actionItems.push({
            id: crypto.randomUUID(), summary, notes, status: defaultStatus,
            dueDate, assignee, color: selectedColor, order: group.length,
          })
        } else {
          const found = tm.actionItems.find((i) => i.id === existing.id)
          if (!found) return
          found.summary = summary
          found.notes = notes
          found.dueDate = dueDate
          found.assignee = assignee
          found.color = selectedColor
        }
      })
      closeModal()
    }

    const buttons: ModalButton[] = []
    if (existing !== null) {
      buttons.push({ label: t(lc, 'kanban_delete_btn'), danger: true, left: true, onClick: () => { closeModal(); requestDelete(existing) } })
    }
    buttons.push({ label: t(lc, 'cancel'), onClick: () => closeModal() })
    buttons.push({ label: t(lc, 'kanban_save_btn'), primary: true, onClick: () => save() })

    const handle: ModalHandle = showModal({
      title: t(lc, existing === null ? 'kanban_add_title' : 'kanban_edit_title'),
      body,
      buttons,
      onClose: () => {
        openBundle?.atHandle.dispose()
        openBundle?.tplHandle.dispose()
        openBundle?.editor.destroy()
        openBundle = null
      },
    })
    summaryInput.focus()
  }

  function emptyEl(): HTMLElement {
    return el('div', { class: 'tt-kanban-empty' }, t(lc, 'kanban_empty'))
  }

  function renderCard(item: ActionItem): HTMLElement {
    const editBtn = el(
      'button',
      { class: 'tt-btn tt-kanban-edit-btn', type: 'button', tabindex: '-1', title: t(lc, 'kanban_edit_hint'), onclick: (e: Event) => { e.stopPropagation(); openEditModal(item) } },
      '✎'
    )
    const titleEl = el('div', { class: 'tt-kanban-card-title' }, item.summary)
    const metaChildren: (Node | string)[] = []
    if (item.dueDate) {
      metaChildren.push(el('span', { class: 'tt-kanban-card-due' + (isOverdue(item, todayIso()) ? ' overdue' : '') }, formatDate(item.dueDate, lc)))
    }
    if (item.assignee) metaChildren.push(el('span', { class: 'tt-kanban-card-assignee' }, item.assignee))
    const metaEl = el('div', { class: 'tt-kanban-card-meta' }, ...metaChildren)

    const card = el(
      'div',
      { class: `tt-kanban-card color-${item.color} status-${item.status}`, draggable: 'true', 'data-item-id': item.id },
      editBtn, titleEl, metaEl
    )
    card.addEventListener('dblclick', () => openEditModal(item))

    card.addEventListener('dragstart', (e) => {
      draggedId = item.id
      trashEl.classList.add('active')
      const dt = (e as DragEvent).dataTransfer
      if (dt) { dt.setData('text/plain', item.id); dt.effectAllowed = 'move' }
    })
    card.addEventListener('dragover', (e) => {
      if (draggedId === null || draggedId === item.id) return
      e.preventDefault()
      const rect = card.getBoundingClientRect()
      const pos = computeDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
      clearDropClasses()
      card.classList.add(`tt-kanban-drop-${pos}`)
    })
    card.addEventListener('dragleave', () => {
      card.classList.remove('tt-kanban-drop-before', 'tt-kanban-drop-after')
    })
    card.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      clearDropClasses()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      const rect = card.getBoundingClientRect()
      const pos = computeDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        moveCard(tm.actionItems, srcId, item.status, item.id, pos)
      })
    })
    card.addEventListener('dragend', () => {
      draggedId = null
      clearDropClasses()
      trashEl.classList.remove('active', 'drag-over')
    })

    return card
  }

  const todoBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const wipBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const doneBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const cancelledBodyEl = el('div', { class: 'tt-kanban-col-body' })
  const doneCountEl = el('span', {})
  const cancelledCountEl = el('span', {})

  const todoColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' },
      el('span', {}, t(lc, 'kanban_col_todo')),
      el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, 'todo') }, t(lc, 'kanban_add_card'))
    ),
    todoBodyEl
  )
  const wipColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' },
      el('span', {}, t(lc, 'kanban_col_wip')),
      el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, 'wip') }, t(lc, 'kanban_add_card'))
    ),
    wipBodyEl
  )
  const doneCancelColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' }, el('span', {}, t(lc, 'kanban_col_done_cancelled'))),
    el('div', { class: 'tt-kanban-zone-label' }, doneCountEl,
      el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('done') }, '🗑')),
    doneBodyEl,
    el('div', { class: 'tt-kanban-divider' }),
    el('div', { class: 'tt-kanban-zone-label' }, cancelledCountEl,
      el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('cancelled') }, '🗑')),
    cancelledBodyEl
  )

  const boardEl = el('div', { class: 'tt-kanban-board' }, todoColEl, wipColEl, doneCancelColEl)
  const datalistEl = el('datalist', { id: datalistId })

  // Drop target for deleting a card by dragging it off the board — shown
  // only while dragging (see dragstart above), same rationale as
  // src/modules/people-tree.ts's rootDropEl: revealing it must not reflow
  // the board mid-dragstart, or Chrome cancels the drag.
  const trashEl = el('div', { class: 'tt-kanban-trash' }, '🗑 ', t(lc, 'kanban_trash_hint'))
  trashEl.addEventListener('dragover', (e) => {
    if (draggedId === null) return
    e.preventDefault()
    trashEl.classList.add('drag-over')
  })
  trashEl.addEventListener('dragleave', () => {
    trashEl.classList.remove('drag-over')
  })
  trashEl.addEventListener('drop', (e) => {
    e.preventDefault()
    trashEl.classList.remove('active', 'drag-over')
    const srcId = draggedId
    draggedId = null
    if (srcId === null) return
    const found = items().find((i) => i.id === srcId)
    if (found) requestDelete(found)
  })

  /** Catches a drop onto empty column space (below the last card, or an empty column) — the case moveCard's `targetId === null` append handles. Card-level drop handlers already stopPropagation() so this never double-fires for a drop that landed on a specific card. */
  function wireColumnDrop(bodyEl: HTMLElement, status: ActionItem['status']): void {
    bodyEl.addEventListener('dragover', (e) => {
      if (draggedId === null) return
      e.preventDefault()
    })
    bodyEl.addEventListener('drop', (e) => {
      e.preventDefault()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        moveCard(tm.actionItems, srcId, status, null, 'after')
      })
    })
  }
  wireColumnDrop(todoBodyEl, 'todo')
  wireColumnDrop(wipBodyEl, 'wip')
  wireColumnDrop(doneBodyEl, 'done')
  wireColumnDrop(cancelledBodyEl, 'cancelled')

  function updateDatalist(): void {
    datalistEl.innerHTML = ''
    const tm = findTeam()
    const names = tm ? [...tm.stakeholders, ...tm.members].map((p) => p.name) : []
    for (const name of Array.from(new Set(names))) {
      datalistEl.appendChild(el('option', { value: name }))
    }
  }

  function renderAll(): void {
    updateDatalist()
    const todo = itemsByStatus(items(), 'todo')
    const wip = itemsByStatus(items(), 'wip')
    const done = itemsByStatus(items(), 'done')
    const cancelled = itemsByStatus(items(), 'cancelled')

    todoBodyEl.innerHTML = ''
    if (todo.length === 0) todoBodyEl.appendChild(emptyEl())
    else todo.forEach((it) => todoBodyEl.appendChild(renderCard(it)))

    wipBodyEl.innerHTML = ''
    if (wip.length === 0) wipBodyEl.appendChild(emptyEl())
    else wip.forEach((it) => wipBodyEl.appendChild(renderCard(it)))

    doneBodyEl.innerHTML = ''
    if (done.length === 0) doneBodyEl.appendChild(emptyEl())
    else done.forEach((it) => doneBodyEl.appendChild(renderCard(it)))

    cancelledBodyEl.innerHTML = ''
    if (cancelled.length === 0) cancelledBodyEl.appendChild(emptyEl())
    else cancelled.forEach((it) => cancelledBodyEl.appendChild(renderCard(it)))

    doneCountEl.textContent = t(lc, 'kanban_done_heading', { count: String(done.length) })
    cancelledCountEl.textContent = t(lc, 'kanban_cancelled_heading', { count: String(cancelled.length) })
  }
  renderAll()

  const unsubscribe = ctx.store.subscribe(() => {
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-kanban' }, boardEl, trashEl, datalistEl))

  disposers.set(container, () => {
    unsubscribe()
    openBundle?.atHandle.dispose()
    openBundle?.tplHandle.dispose()
    openBundle?.editor.destroy()
    openBundle = null
  })
}
