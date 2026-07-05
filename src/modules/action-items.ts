// src/modules/action-items.ts — Task 20: action items module. A flat,
// orderable list of ActionItem per team (no parent/child nesting, unlike
// src/modules/people-tree.ts), so it reuses that module's disposal /
// store.subscribe discipline but trims the drag-and-drop helpers down to a
// simpler flat before/after variant (no 'child' drop position).
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { el } from '../ui/dom'

/** Per-container disposers — see the extensive comment on the same pattern in src/modules/daily-notes.ts. */
const disposers = new WeakMap<HTMLElement, () => void>()

// --- pure, unit-testable helpers -------------------------------------------

/** Open (not done) items, sorted by `order`. */
export function openItems(items: ActionItem[]): ActionItem[] {
  return items.filter((i) => !i.done).sort((a, b) => a.order - b.order)
}

/** Done items, sorted by `order`. */
export function doneItems(items: ActionItem[]): ActionItem[] {
  return items.filter((i) => i.done).sort((a, b) => a.order - b.order)
}

/** True when the item has a due date strictly before `today` and is not done. */
export function isOverdue(item: Pick<ActionItem, 'dueDate' | 'done'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && !item.done
}

/**
 * Maps a drop's vertical offset within the target row to before/after —
 * the flat-list equivalent of src/modules/people-tree.ts's
 * `computeDropPosition`, minus the 'child' outcome (action items have no
 * hierarchy, so there's nothing to nest under). Degrades to 'after' for a
 * non-positive `height` (rows not yet laid out, e.g. in a test without real
 * layout) rather than dividing by zero.
 */
export function computeFlatDropPosition(offsetY: number, height: number): 'before' | 'after' {
  if (height <= 0) return 'after'
  return offsetY < height / 2 ? 'before' : 'after'
}

/**
 * Moves `draggedId` to become a sibling (before/after `targetId`) within
 * `items`, renumbering `order` across the whole array so it stays a dense
 * 0..n-1 sequence. Mutates the ActionItem objects in place (the array itself
 * is not replaced) so it can run directly inside a `store.update` callback —
 * mirrors `moveInTree` from src/modules/people-tree.ts, flattened. No-ops
 * when dragging an item onto itself or when either id isn't present.
 */
export function moveActionItem(items: ActionItem[], draggedId: string, targetId: string, position: 'before' | 'after'): void {
  if (draggedId === targetId) return
  const sorted = [...items].sort((a, b) => a.order - b.order)
  const draggedIdx = sorted.findIndex((i) => i.id === draggedId)
  if (draggedIdx === -1) return
  const dragged = sorted.splice(draggedIdx, 1)[0]!
  const targetIdx = sorted.findIndex((i) => i.id === targetId)
  if (targetIdx === -1) return
  const insertAt = position === 'before' ? targetIdx : targetIdx + 1
  sorted.splice(insertAt, 0, dragged)
  sorted.forEach((it, i) => { it.order = i })
}

// --- renderer ---------------------------------------------------------------

export function renderActionItems(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'actions') return // registered only for 'actions'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale
  const datalistId = `tt-action-people-${Math.random().toString(36).slice(2)}`

  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function items(): ActionItem[] {
    return findTeam()?.actionItems ?? []
  }

  let draggedId: string | null = null
  let showDone = false
  let focusItemId: string | null = null

  function clearDropClasses(): void {
    listEl.querySelectorAll('.tt-action-row').forEach((n) => {
      n.classList.remove('tt-action-drop-before', 'tt-action-drop-after')
    })
  }

  function removeItem(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
    })
  }

  function openDeleteConfirm(item: ActionItem): void {
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'action_delete_confirm', { text: item.text }))
    let handle: ModalHandle
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'action_delete_btn'),
      primary: true,
      onClick: () => {
        removeItem(item.id)
        handle.close()
      },
    }
    handle = showModal({ title: t(lc, 'action_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function requestDelete(item: ActionItem): void {
    if (item.text.trim() === '') {
      removeItem(item.id) // empty items carry no meaningful content to lose — delete silently
      return
    }
    openDeleteConfirm(item)
  }

  function renderRow(item: ActionItem): HTMLElement {
    const doneCheckbox = el('input', {
      type: 'checkbox', class: 'tt-action-done', title: t(lc, 'action_done_title'), checked: item.done,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.actionItems.find((i) => i.id === item.id)
          if (found) found.done = checked
        })
      },
    })

    const textInput = el('input', {
      type: 'text', class: 'tt-action-text tt-input', placeholder: t(lc, 'action_text_placeholder'), value: item.text,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.actionItems.find((i) => i.id === item.id)
          if (found) found.text = value
        })
      },
    })

    const dueInput = el('input', {
      type: 'date', class: 'tt-action-due tt-input', value: item.dueDate ?? '',
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.actionItems.find((i) => i.id === item.id)
          if (found) found.dueDate = value === '' ? null : value
        })
      },
    })

    const assigneeInput = el('input', {
      type: 'text', class: 'tt-action-assignee tt-input', list: datalistId,
      placeholder: t(lc, 'action_assignee_placeholder'), value: item.assignee,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.actionItems.find((i) => i.id === item.id)
          if (found) found.assignee = value
        })
      },
    })

    const deleteBtn = el(
      'button',
      { class: 'tt-btn tt-action-delete-btn', type: 'button', title: t(lc, 'action_delete_title'), onclick: () => requestDelete(item) },
      '🗑'
    )

    const row = el(
      'div',
      { class: 'tt-action-row', draggable: item.done ? 'false' : 'true', 'data-item-id': item.id },
      doneCheckbox, textInput, dueInput, assigneeInput, deleteBtn
    )
    if (item.done) row.classList.add('tt-action-done-row')
    if (isOverdue(item, todayIso())) row.classList.add('overdue')

    if (!item.done) {
      row.addEventListener('dragstart', (e) => {
        draggedId = item.id
        const dt = (e as DragEvent).dataTransfer
        if (dt) { dt.setData('text/plain', item.id); dt.effectAllowed = 'move' }
      })
      row.addEventListener('dragover', (e) => {
        if (draggedId === null || draggedId === item.id) return
        e.preventDefault()
        const rect = row.getBoundingClientRect()
        const pos = computeFlatDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
        clearDropClasses()
        row.classList.add(`tt-action-drop-${pos}`)
      })
      row.addEventListener('dragleave', () => {
        row.classList.remove('tt-action-drop-before', 'tt-action-drop-after')
      })
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        clearDropClasses()
        const srcId = draggedId
        draggedId = null
        if (srcId === null || srcId === item.id) return
        const rect = row.getBoundingClientRect()
        const pos = computeFlatDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          moveActionItem(tm.actionItems, srcId, item.id, pos)
        })
      })
      row.addEventListener('dragend', () => {
        draggedId = null
        clearDropClasses()
      })
    }

    return row
  }

  const listEl = el('div', { class: 'tt-action-list' })
  const doneToggleBtn = el('button', {
    class: 'tt-btn tt-action-done-toggle', type: 'button',
    onclick: () => { showDone = !showDone; renderAll() },
  })
  const doneListEl = el('div', { class: 'tt-action-done-list' })
  const datalistEl = el('datalist', { id: datalistId })

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
    const open = openItems(items())
    const done = doneItems(items())

    listEl.innerHTML = ''
    if (open.length === 0 && done.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-action-empty' }, t(lc, 'action_empty')))
    } else {
      open.forEach((it) => listEl.appendChild(renderRow(it)))
    }

    doneToggleBtn.textContent = t(lc, showDone ? 'action_hide_done' : 'action_show_done', { count: String(done.length) })
    doneToggleBtn.style.display = done.length === 0 ? 'none' : ''
    doneListEl.style.display = showDone ? '' : 'none'
    doneListEl.innerHTML = ''
    done.forEach((it) => doneListEl.appendChild(renderRow(it)))

    if (focusItemId) {
      listEl.querySelector<HTMLInputElement>(`[data-item-id="${focusItemId}"] .tt-action-text`)?.focus()
      focusItemId = null
    }
  }
  renderAll()

  function addItem(): void {
    const newId = crypto.randomUUID()
    focusItemId = newId
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      const maxOrder = tm.actionItems.length === 0 ? -1 : Math.max(...tm.actionItems.map((i) => i.order))
      tm.actionItems.push({ id: newId, text: '', done: false, dueDate: null, assignee: '', order: maxOrder + 1 })
    })
  }

  const addBtn = el(
    'button',
    { class: 'tt-btn tt-action-add-btn', type: 'button', onclick: () => addItem() },
    t(lc, 'action_add_btn')
  )
  const toolbar = el('div', { class: 'tt-action-toolbar' }, addBtn)

  /**
   * True (and returns the focused element) only for the caret-sensitive
   * input types this module owns (text/date) — not the checkbox, which has
   * no caret and whose own 'change' handler needs its rebuild (moving the
   * row into/out of the done group) to happen immediately.
   */
  function focusedCaretInput(): HTMLInputElement | null {
    const active = document.activeElement
    if (active instanceof HTMLInputElement && container.contains(active) && (active.type === 'text' || active.type === 'date')) {
      return active
    }
    return null
  }

  // A full rebuild is the simplest correct way to keep row order/grouping/
  // overdue-status in sync with the store, but it would blow away an
  // in-progress edit's caret if some *other* change (a different row's
  // checkbox, an edit from the other split pane, etc.) fires while a
  // text/date input here is focused — text/date inputs only commit to the
  // store on 'change' (i.e. on their own blur), so at the moment such a
  // foreign update arrives the field's edit is still live and uncommitted.
  // Rather than diffing rows, we just skip that one rebuild and defer it to
  // the field's next blur — nothing is lost, since blur is exactly when this
  // field's own edit (if any) commits and would have triggered a rebuild anyway.
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretInput()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-actions' }, toolbar, listEl, doneToggleBtn, doneListEl, datalistEl))

  disposers.set(container, () => {
    unsubscribe()
  })
}
