// src/modules/action-items.ts — kanban board (To Do / WIP / Done+Cancelled)
// for a team's action items. Cards are edited exclusively through a modal
// (openEditModal below); the board itself has no live inputs, so a full
// rebuild on every store change (like src/modules/people-tree.ts's
// renderAll) is simplest and correct — unlike the old flat-list version,
// there's no in-progress inline edit whose caret needs preserving across a
// foreign store update.
import type { ActionItem, Loc, Team } from '../core/types'
import { t, todayIso, formatDate, type MsgKey } from '../core/i18n'
import { teamRefCandidates } from '../core/search'
import { unlinkRefsInTeam } from '../core/refs'
import { isOverdue } from '../core/due'
import { nowHHMM } from '../core/date'
import { SUGGESTED_TAG_NAME_KEYS } from '../core/document'
import { duplicateActionItem, transferActionItem } from '../core/card-transfer'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, makeRefLabelResolver, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { createDatePicker, type DatePickerHandle } from '../ui/date-picker'
import { showCardContextMenu } from '../ui/card-context-menu'
import { el } from '../ui/dom'

/** Per-container disposers — see the extensive comment on the same pattern in src/modules/daily-notes.ts. */
const disposers = new WeakMap<HTMLElement, () => void>()

// Display order: red, yellow, blue (the three with a suggested default name
// — see core/document.ts's SUGGESTED_TAG_NAME_KEYS/createEmptyTeam), then
// the rest.
const COLORS: ActionItem['color'][] = ['rust', 'brass', 'slate', 'sage', 'plum', 'ledger']
const COLOR_KEYS: Record<ActionItem['color'], 'kanban_color_slate' | 'kanban_color_brass' | 'kanban_color_sage' | 'kanban_color_rust' | 'kanban_color_plum' | 'kanban_color_ledger'> = {
  slate: 'kanban_color_slate', brass: 'kanban_color_brass', sage: 'kanban_color_sage',
  rust: 'kanban_color_rust', plum: 'kanban_color_plum', ledger: 'kanban_color_ledger',
}
// --- pure, unit-testable helpers -------------------------------------------

/** Items in `status`, sorted by `order`. */
export function itemsByStatus(items: ActionItem[], status: ActionItem['status']): ActionItem[] {
  return items.filter((i) => i.status === status).sort((a, b) => a.order - b.order)
}

// The overdue rule lives in core/due.ts (shared with the sidebar due badge);
// re-exported here so board code and tests keep one import site.
export { isOverdue }

/** Maps a drop's vertical offset within the target card to before/after. Degenerates to 'after' for a non-positive `height` (cards not yet laid out, e.g. in a test without real layout) rather than dividing by zero. "Flat" to distinguish it from people-tree.ts's tree-aware computeDropPosition, which adds a 'child' band. */
export function computeFlatDropPosition(offsetY: number, height: number): 'before' | 'after' {
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

  let activeTagFilter: ActionItem['color'] | null = null

  /** The team's custom name for `color`, or `null` if none has been assigned yet (see showColorNamer in openEditModal). Unnamed colors render as a bare swatch — no generic fallback text. */
  function customTagName(color: ActionItem['color']): string | null {
    return findTeam()?.actionTagNames?.[color] ?? null
  }

  /** A starter-name hint for an unnamed color (see SUGGESTED_TAG_NAME_KEYS), falling back to the plain color name — used for placeholders/aria-labels, never stored. */
  function suggestedTagName(color: ActionItem['color']): string {
    const key = SUGGESTED_TAG_NAME_KEYS[color]
    return t(lc, key ?? COLOR_KEYS[color])
  }

  const tagChipsEl = el('div', { class: 'tt-kanban-tag-chips' })
  function renderTagChips(tagNames: Partial<Record<ActionItem['color'], string>>): void {
    tagChipsEl.innerHTML = ''
    for (const c of COLORS) {
      const custom = tagNames[c] ?? null
      const chip = el(
        'button',
        {
          type: 'button',
          // Same square swatch pattern as the color picker in the card modal
          // (.tt-kanban-color-chip) — blank until named, name shown inside once it is.
          class: `tt-kanban-color-chip tt-kanban-tag-chip color-${c}` + (activeTagFilter === c ? ' selected' : ''),
          'aria-label': custom ?? suggestedTagName(c),
          onclick: () => {
            activeTagFilter = activeTagFilter === c ? null : c
            renderAll()
          },
        },
        custom
      )
      tagChipsEl.appendChild(chip)
    }
  }

  function clearDropClasses(): void {
    boardEl.querySelectorAll('.tt-kanban-card').forEach((n) => {
      n.classList.remove('tt-kanban-drop-before', 'tt-kanban-drop-after')
    })
  }

  function removeItem(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      unlinkRefsInTeam(tm, 'action', [id])
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
          const removedIds = tm.actionItems.filter((i) => i.status === status).map((i) => i.id)
          unlinkRefsInTeam(tm, 'action', removedIds)
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_clear_zone_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  interface ModalBundle { editor: Editor; atHandle: AtAutocompleteHandle; tplHandle: TemplatePickerHandle; datePicker: DatePickerHandle }
  let openBundle: ModalBundle | null = null

  /** Single teardown for the edit modal's editor bundle — called from both the modal's onClose and the container disposer, so the two can't drift. Idempotent. */
  function disposeOpenBundle(): void {
    if (!openBundle) return
    openBundle.atHandle.dispose()
    openBundle.tplHandle.dispose()
    openBundle.editor.destroy()
    openBundle.datePicker.destroy()
    openBundle = null
  }

  /** Full CRUD modal: `existing === null` creates a new card in `defaultStatus`; otherwise edits/deletes `existing`. Mirrors src/modules/people-tree.ts's openPersonModal shape, plus a rich-text notes editor (created on open, destroyed on close) wired exactly like the old inline renderNotesRow (@ref autocomplete + '/' template picker). */
  function openEditModal(existing: ActionItem | null, defaultStatus: 'todo' | 'wip' = 'todo'): void {
    const summaryInput = el('input', { type: 'text', class: 'tt-input', value: existing?.summary ?? '' }) as HTMLInputElement
    const datePicker = createDatePicker({ value: existing?.dueDate ?? '', locale: lc, allowClear: true, onChange: () => {} })
    const assigneeInput = el('input', { type: 'text', class: 'tt-input', list: datalistId, value: existing?.assignee ?? '' }) as HTMLInputElement
    let selectedColor: ActionItem['color'] = existing?.color ?? 'ledger'
    const errorEl = el('div', { class: 'tt-field-error' })

    const editor: Editor = createEditor(
      {
        onChange() {},
        onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
        onAtTrigger() {},
        onSlashTrigger() {},
        resolveRefLabel: makeRefLabelResolver(ctx.store, teamId),
      },
      lc
    )
    editor.setMd(existing?.notes ?? '')
    const atHandle = attachAtAutocomplete(editor, { getRefCandidates: () => teamRefCandidates(findTeam()), locale: lc, onPick: () => {} })
    const tplHandle = attachTemplatePicker(editor, {
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
      locale: lc,
    })
    openBundle = { editor, atHandle, tplHandle, datePicker }

    const colorRow = el('div', { class: 'tt-kanban-color-row' })
    function paintSelectedColor(): void {
      colorRow.querySelectorAll('.tt-kanban-color-chip').forEach((chip) => {
        chip.classList.toggle('selected', chip.getAttribute('data-color') === selectedColor)
      })
    }
    function renderColorChips(): void {
      colorRow.innerHTML = ''
      for (const c of COLORS) {
        const custom = customTagName(c)
        colorRow.appendChild(
          el('button', {
            type: 'button', class: `tt-kanban-color-chip color-${c}`, 'data-color': c, 'aria-label': custom ?? suggestedTagName(c),
            onclick: () => { selectedColor = c; paintSelectedColor() },
          }, custom)
        )
      }
      paintSelectedColor()
    }

    renderColorChips()

    const body = el(
      'div',
      { class: 'tt-kanban-form' },
      el('label', { class: 'tt-field' }, t(lc, 'kanban_summary_label'), summaryInput),
      el('div', { class: 'tt-field' }, t(lc, 'kanban_notes_label'), editor.root),
      el(
        'div',
        { class: 'tt-kanban-form-row' },
        el('label', { class: 'tt-field' }, t(lc, 'kanban_due_label'), datePicker.root),
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
      const dueDate = datePicker.getValue() === '' ? null : datePicker.getValue()
      const assignee = assigneeInput.value
      const notes = editor.getMd()
      // A new card whose color the active filter would hide is invisible the
      // instant it's created — clear the filter first so store.update()'s
      // synchronous renderAll() (see src/core/store.ts) picks it up already
      // showing everything, rather than needing a second click to find it.
      if (existing === null && activeTagFilter !== null && activeTagFilter !== selectedColor) {
        activeTagFilter = null
      }
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
      onClose: () => disposeOpenBundle(),
    })
    summaryInput.focus()
  }

  function openEditTagsModal(): void {
    const tm = findTeam()
    if (!tm) return
    const inputs = new Map<ActionItem['color'], HTMLInputElement>()
    const rows = COLORS.map((c) => {
      const input = el('input', {
        type: 'text', class: 'tt-input tt-kanban-color-name-input',
        value: tm.actionTagNames?.[c] ?? '', placeholder: suggestedTagName(c),
      }) as HTMLInputElement
      inputs.set(c, input)
      return el('div', { class: 'tt-kanban-color-name-row' }, el('span', { class: `tt-kanban-color-chip color-${c}` }), input)
    })
    const body = el('div', { class: 'tt-kanban-color-name-rows' }, ...rows)
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const saveBtn: ModalButton = {
      label: t(lc, 'kanban_save_btn'),
      primary: true,
      onClick: () => {
        ctx.store.update((d) => {
          const target = d.teams.find((t2) => t2.id === teamId)
          if (!target) return
          const nextTags: Partial<Record<ActionItem['color'], string>> = { ...target.actionTagNames }
          for (const c of COLORS) {
            const value = inputs.get(c)!.value.trim()
            if (value === '') delete nextTags[c]
            else nextTags[c] = value
          }
          target.actionTagNames = nextTags
        })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_edit_tags_title'), body, buttons: [cancelBtn, saveBtn] })
  }

  function emptyEl(): HTMLElement {
    return el('div', { class: 'tt-kanban-empty' }, t(lc, 'kanban_empty'))
  }

  function openCardContextMenu(itemId: string, x: number, y: number): void {
    showCardContextMenu(lc, teamId, ctx.store.doc.teams, itemId, x, y, {
      duplicate: (id) => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (tm) duplicateActionItem(tm, id)
        })
      },
      transfer: (id, targetTeamId, mode) => {
        ctx.store.update((d) => {
          transferActionItem(d.teams, id, teamId, targetTeamId, mode)
        })
      },
    })
  }

  function renderCard(item: ActionItem, today: string, tagNames: Partial<Record<ActionItem['color'], string>>): HTMLElement {
    const editBtn = el(
      'button',
      { class: 'tt-btn tt-kanban-edit-btn', type: 'button', tabindex: '-1', title: t(lc, 'kanban_edit_hint'), onclick: (e: Event) => { e.stopPropagation(); openEditModal(item) } },
      '✎'
    )
    const titleEl = el('div', { class: 'tt-kanban-card-title' }, item.summary)
    const metaChildren: (Node | string)[] = []
    if (item.dueDate) {
      metaChildren.push(el('span', { class: 'tt-kanban-card-due' + (isOverdue(item, today) ? ' overdue' : '') }, formatDate(item.dueDate, lc)))
    }
    if (item.assignee) metaChildren.push(el('span', { class: 'tt-kanban-card-assignee' }, item.assignee))
    const customName = tagNames[item.color] ?? null
    if (customName) metaChildren.push(el('span', { class: 'tt-kanban-card-tag' }, customName))
    const metaEl = el('div', { class: 'tt-kanban-card-meta' }, ...metaChildren)

    const card = el(
      'div',
      { class: `tt-kanban-card color-${item.color} status-${item.status}`, draggable: 'true', 'data-item-id': item.id },
      editBtn, titleEl, metaEl
    )
    card.addEventListener('dblclick', () => openEditModal(item))
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openCardContextMenu(item.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })

    card.addEventListener('dragstart', (e) => {
      draggedId = item.id
      trashEl.classList.add('active')
      showDropZones()
      const dt = (e as DragEvent).dataTransfer
      if (dt) { dt.setData('text/plain', item.id); dt.effectAllowed = 'move' }
    })
    card.addEventListener('dragover', (e) => {
      if (draggedId === null || draggedId === item.id) return
      e.preventDefault()
      const rect = card.getBoundingClientRect()
      const pos = computeFlatDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
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
      // Hide eagerly (mirrors src/modules/people-tree.ts's rootDropEl drop
      // handler): the store update below triggers a full renderAll(), which
      // can detach this drag source before its own `dragend` — the usual
      // hider — ever fires, leaving the trash zone stuck visible.
      trashEl.classList.remove('active', 'drag-over')
      hideDropZones()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      const rect = card.getBoundingClientRect()
      const pos = computeFlatDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
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
      hideDropZones()
    })

    return card
  }

  const STATUSES = ['todo', 'wip', 'done', 'cancelled'] as const
  const doneCountEl = el('span', {})
  const cancelledCountEl = el('span', {})

  // Drop-zone highlight overlays — one per status body, mirroring
  // src/modules/people-tree.ts's rootDropEl. Each lives in its own
  // `tt-kanban-col-body-wrap` (position: relative), a sibling of the body
  // rather than a child of it, because renderAll() wipes each body's
  // innerHTML on every store change; a child here would be destroyed along
  // with the cards. Absolutely positioned so toggling it never reflows the
  // body's flex-laid-out cards (see wireColumnDrop / renderCard dragstart).
  function bodyWrap(bodyEl: HTMLElement, zoneEl: HTMLElement): HTMLElement {
    return el('div', { class: 'tt-kanban-col-body-wrap' }, bodyEl, zoneEl)
  }
  const colParts = (): { bodyEl: HTMLElement; zoneEl: HTMLElement } => ({
    bodyEl: el('div', { class: 'tt-kanban-col-body' }),
    zoneEl: el('div', { class: 'tt-kanban-dropzone' }),
  })
  const cols: Record<ActionItem['status'], { bodyEl: HTMLElement; zoneEl: HTMLElement }> = {
    todo: colParts(), wip: colParts(), done: colParts(), cancelled: colParts(),
  }
  function showDropZones(): void {
    STATUSES.forEach((s) => cols[s].zoneEl.classList.add('active'))
    // Lets the CSS shrink each column drop-zone's bottom edge, clearing
    // space for the full-width trash bar (see .tt-kanban-trash) so the two
    // never overlap. Also out-of-flow (see the drop-zone comment above), so
    // this doesn't reflow anything mid-dragstart either.
    kanbanRootEl.classList.add('dragging')
  }
  function hideDropZones(): void {
    STATUSES.forEach((s) => cols[s].zoneEl.classList.remove('active', 'drag-over'))
    kanbanRootEl.classList.remove('dragging')
  }

  /** The two columns cards can be added to directly — identical apart from status and heading. */
  function addableCol(status: 'todo' | 'wip', headingKey: MsgKey): HTMLElement {
    return el(
      'div', { class: 'tt-kanban-col' },
      el('div', { class: 'tt-kanban-col-head' },
        el('span', {}, t(lc, headingKey)),
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, status) }, t(lc, 'kanban_add_card'))
      ),
      bodyWrap(cols[status].bodyEl, cols[status].zoneEl)
    )
  }
  const doneCancelColEl = el(
    'div', { class: 'tt-kanban-col' },
    el('div', { class: 'tt-kanban-col-head' }, el('span', {}, t(lc, 'kanban_col_done_cancelled'))),
    el('div', { class: 'tt-kanban-zone-label' }, doneCountEl,
      el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('done') }, '🗑')),
    bodyWrap(cols.done.bodyEl, cols.done.zoneEl),
    el('div', { class: 'tt-kanban-divider' }),
    el('div', { class: 'tt-kanban-zone-label' }, cancelledCountEl,
      el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('cancelled') }, '🗑')),
    bodyWrap(cols.cancelled.bodyEl, cols.cancelled.zoneEl)
  )

  const boardEl = el('div', { class: 'tt-kanban-board' }, addableCol('todo', 'kanban_col_todo'), addableCol('wip', 'kanban_col_wip'), doneCancelColEl)
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
    hideDropZones()
    const srcId = draggedId
    draggedId = null
    if (srcId === null) return
    const found = items().find((i) => i.id === srcId)
    if (found) requestDelete(found)
  })

  /** Catches a drop onto empty column space (below the last card, or an empty column) — the case moveCard's `targetId === null` append handles. Card-level drop handlers already stopPropagation() so this never double-fires for a drop that landed on a specific card. */
  function wireColumnDrop(bodyEl: HTMLElement, status: ActionItem['status'], zoneEl: HTMLElement): void {
    bodyEl.addEventListener('dragover', (e) => {
      if (draggedId === null) return
      e.preventDefault()
      zoneEl.classList.add('drag-over')
    })
    // A dragover on a child card bubbles here too (cards don't stopPropagation
    // on dragover), so a dragleave fired while moving between child cards
    // would otherwise flicker the highlight off and back on — ignore it
    // unless the pointer actually left the body's subtree.
    bodyEl.addEventListener('dragleave', (e) => {
      const related = (e as DragEvent).relatedTarget as Node | null
      if (related && bodyEl.contains(related)) return
      zoneEl.classList.remove('drag-over')
    })
    bodyEl.addEventListener('drop', (e) => {
      e.preventDefault()
      // Hide eagerly — see the identical comment on the card-level drop
      // handler above.
      trashEl.classList.remove('active', 'drag-over')
      hideDropZones()
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
  STATUSES.forEach((s) => wireColumnDrop(cols[s].bodyEl, s, cols[s].zoneEl))

  function updateDatalist(tm: Team | undefined): void {
    datalistEl.innerHTML = ''
    const names = tm ? [...tm.stakeholders, ...tm.members].map((p) => p.name) : []
    for (const name of Array.from(new Set(names))) {
      datalistEl.appendChild(el('option', { value: name }))
    }
  }

  // Runs on every store change (the subscribe below) — the team lookup,
  // today's date, and the tag-name map are computed once here and threaded
  // through, and the items are bucketed in a single pass, instead of a
  // findTeam()/todayIso() per column and per card.
  function renderAll(): void {
    const tm = findTeam()
    const today = todayIso()
    const tagNames = tm?.actionTagNames ?? {}
    updateDatalist(tm)
    renderTagChips(tagNames)
    const byStatus: Record<ActionItem['status'], ActionItem[]> = { todo: [], wip: [], done: [], cancelled: [] }
    for (const it of tm?.actionItems ?? []) byStatus[it.status].push(it)
    for (const s of STATUSES) {
      const group = byStatus[s].sort((a, b) => a.order - b.order)
      const visible = activeTagFilter === null ? group : group.filter((i) => i.color === activeTagFilter)
      const bodyEl = cols[s].bodyEl
      bodyEl.innerHTML = ''
      if (visible.length === 0) bodyEl.appendChild(emptyEl())
      else visible.forEach((it) => bodyEl.appendChild(renderCard(it, today, tagNames)))
    }
    doneCountEl.textContent = t(lc, 'kanban_done_heading', { count: String(byStatus.done.length) })
    cancelledCountEl.textContent = t(lc, 'kanban_cancelled_heading', { count: String(byStatus.cancelled.length) })
  }
  renderAll()

  const unsubscribe = ctx.store.subscribe(() => {
    renderAll()
  })

  const filterLabelEl = el('span', { class: 'tt-kanban-filter-label' }, t(lc, 'kanban_filter_label'))
  const editTagsBtn = el(
    'button',
    { class: 'tt-btn tt-kanban-edit-tags-btn', type: 'button', onclick: () => openEditTagsModal() },
    t(lc, 'kanban_edit_tags_btn')
  )
  const toolbarEl = el('div', { class: 'tt-kanban-toolbar' }, filterLabelEl, tagChipsEl, editTagsBtn)

  const kanbanRootEl = el('div', { class: 'tt-kanban' }, toolbarEl, boardEl, trashEl, datalistEl)
  container.appendChild(kanbanRootEl)

  disposers.set(container, () => {
    unsubscribe()
    disposeOpenBundle()
  })
}
