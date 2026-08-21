// src/modules/action-items.ts — kanban board (fixed To Do start, the team's
// own custom middle columns, fixed Done+Cancelled end) for a team's action
// items. Cards are edited exclusively through a modal
// (openEditModal below), so a full rebuild on every store change (like
// src/modules/people-tree.ts's renderAll) is simplest and correct there.
// The one live input the board itself owns is a middle column's inline
// rename field (see focusedRenameInput/deferredRebuild below) — a foreign
// store update while it's focused defers the rebuild to the input's next
// blur instead of wiping the in-progress edit.
import type { ActionColumn, ActionItem, ActionItemColor, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import { unlinkRefsInTeam } from '../core/refs'
import { isOverdue } from '../core/due'
import { nowHHMM } from '../core/date'
import { SUGGESTED_TAG_NAME_KEYS, findTeam as docFindTeam } from '../core/document'
import { installArrowFallbackFocus, type ModuleCtx } from '../ui/panes'
import { scopeAffects, type Section } from '../core/scope'
import { showModal, confirmDelete, type ModalButton, type ModalHandle } from '../ui/modal'
import { createRichEditorBundle, type RichEditorBundle } from '../ui/rich-editor'
import { createDatePicker, type DatePickerHandle } from '../ui/date-picker'
import { openItemContextMenu } from '../ui/card-context-menu'
import { el, blurOnEnter, createDeferredRebuild } from '../ui/dom'
import { BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'
import { withDisposal } from './lifecycle'

// Display order: red, yellow, blue (the three with a suggested default name
// — see core/document.ts's SUGGESTED_TAG_NAME_KEYS/createEmptyTeam), then
// the rest.
const COLORS: ActionItemColor[] = ['rust', 'brass', 'slate', 'sage', 'plum', 'ledger']
const COLOR_KEYS: Record<ActionItemColor, 'kanban_color_slate' | 'kanban_color_brass' | 'kanban_color_sage' | 'kanban_color_rust' | 'kanban_color_plum' | 'kanban_color_ledger'> = {
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

/**
 * Reorders `columns` (a team's custom middle columns) by moving `draggedId`
 * to before/after `targetId`, densely renumbering `order`. Single flat list
 * (no status-group split like moveCard's), so this is simpler: one splice,
 * one renumber pass.
 */
export function moveColumn(columns: ActionColumn[], draggedId: string, targetId: string | null, position: 'before' | 'after'): void {
  const dragged = columns.find((c) => c.id === draggedId)
  if (!dragged) return
  if (draggedId === targetId) return
  const rest = columns.filter((c) => c.id !== draggedId).sort((a, b) => a.order - b.order)
  const targetIdx = targetId === null ? -1 : rest.findIndex((c) => c.id === targetId)
  const insertAt = targetIdx === -1 ? rest.length : (position === 'before' ? targetIdx : targetIdx + 1)
  rest.splice(insertAt, 0, dragged)
  rest.forEach((c, idx) => { c.order = idx })
}

// --- renderer ---------------------------------------------------------------

export const renderActionItems = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'actions') return // registered only for 'actions'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale
  const datalistId = `tt-kanban-people-${Math.random().toString(36).slice(2)}`

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }
  function items(): ActionItem[] {
    return findTeam()?.actionItems ?? []
  }

  let draggedId: string | null = null
  let draggedColumnId: string | null = null
  let pendingColumnFocusId: string | null = null

  let activeTagFilter: ActionItemColor | null = null

  /** The team's custom name for `color`, or `null` if none has been assigned yet (see showColorNamer in openEditModal). Unnamed colors render as a bare swatch — no generic fallback text. */
  function customTagName(color: ActionItemColor): string | null {
    return findTeam()?.actionTagNames?.[color] ?? null
  }

  /** A starter-name hint for an unnamed color (see SUGGESTED_TAG_NAME_KEYS), falling back to the plain color name — used for placeholders/aria-labels, never stored. */
  function suggestedTagName(color: ActionItemColor): string {
    const key = SUGGESTED_TAG_NAME_KEYS[color]
    return t(lc, key ?? COLOR_KEYS[color])
  }

  const tagChipsEl = el('div', { class: 'tt-kanban-tag-chips' })
  function renderTagChips(tagNames: Partial<Record<ActionItemColor, string>>, counts: Record<ActionItemColor, number>): void {
    tagChipsEl.innerHTML = ''
    // Marks the whole strip while a filter is on, so the CSS can dim the
    // chips that aren't the active one — the selected chip alone carrying a
    // border was easy to miss on a board that looks half-empty as a result.
    tagChipsEl.classList.toggle('filtering', activeTagFilter !== null)
    for (const c of COLORS) {
      const custom = tagNames[c] ?? null
      // Every chip filters, named or not — an unnamed color is still a
      // perfectly good thing to filter by, identified by the swatch itself.
      // Naming happens in one place only: the "Edit tags" button. (A previous
      // pass made unnamed chips open that modal instead of filtering; it cost
      // the filter and was reverted.) Unnamed chips stay bare swatches with
      // the suggested name in `aria-label`.
      const children: (Node | string)[] = custom !== null ? [custom] : []
      // Every chip carries how many open cards it would filter to, named or
      // not — the count is what makes the strip worth its row of vertical
      // space, and an unnamed color needs it most: the swatch alone says
      // nothing about whether clicking it is worth the trip.
      if (counts[c] > 0) {
        children.push(el('span', { class: 'tt-kanban-tag-chip-count' }, String(counts[c])))
      }
      const chip = el(
        'button',
        {
          type: 'button',
          // Same square swatch pattern as the color picker in the card modal
          // (.tt-kanban-color-chip) — blank until named, name shown inside once it is.
          class: `tt-kanban-color-chip tt-kanban-tag-chip color-${c}` + (activeTagFilter === c ? ' selected' : ''),
          'aria-label': custom ?? suggestedTagName(c),
          'aria-pressed': activeTagFilter === c ? 'true' : 'false',
          onclick: () => {
            activeTagFilter = activeTagFilter === c ? null : c
            renderAll()
          },
        },
        ...children
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
      const removed = tm.actionItems.find((i) => i.id === id)
      unlinkRefsInTeam(tm, 'action', removed ? new Map([[id, removed.summary]]) : new Map())
      tm.actionItems = tm.actionItems.filter((i) => i.id !== id)
      // No `sections`: unlinkRefsInTeam rewrites @mentions across every
      // content-bearing section of this team (notes, people, milestones,
      // risks — see refs.ts), not just 'actions'. Team-only scoping is the
      // narrowest scope that's still correct, and it won't rot if
      // unlinkRefsInTeam's reach changes later — refs never cross teams
      // (see refs.ts's own header comment), so `{ teamId }` alone is safe.
    }, { teamId })
  }

  function addColumn(): void {
    const newId = crypto.randomUUID()
    // Set before store.update(), not after: store.update() notifies
    // subscribe() synchronously (see core/store.ts), which for this module
    // runs straight into renderAll() -> rebuildBoard() before update()
    // returns. rebuildBoard()'s pendingColumnFocusId check (below) has to see
    // the new id during that same synchronous pass, or the just-added column
    // never gets its auto-focus.
    pendingColumnFocusId = newId
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      const existing = tm.actionColumns ?? []
      const maxOrder = existing.length === 0 ? -1 : Math.max(...existing.map((c) => c.order))
      tm.actionColumns = [...existing, { id: newId, name: t(lc, 'kanban_new_column_default_name'), order: maxOrder + 1 }]
    }, { teamId, sections: ['actions'] })
  }

  function renameColumn(columnId: string, name: string): void {
    ctx.store.update((d) => {
      const col = d.teams.find((t2) => t2.id === teamId)?.actionColumns?.find((c) => c.id === columnId)
      if (col) col.name = name
    }, { teamId, sections: ['actions'] })
  }

  function requestDelete(item: ActionItem): void {
    if (item.summary.trim() === '') {
      removeItem(item.id) // empty cards carry no meaningful content to lose — delete silently
      return
    }
    confirmDelete(lc, {
      title: t(lc, 'kanban_delete_title'),
      message: t(lc, 'kanban_delete_confirm', { summary: item.summary }),
      confirmLabel: t(lc, 'kanban_delete_btn'),
      variant: 'danger',
      onConfirm: () => removeItem(item.id),
    })
  }

  function clearZone(status: ActionItem['status']): void {
    const count = itemsByStatus(items(), status).length
    if (count === 0) return
    confirmDelete(lc, {
      title: t(lc, 'kanban_clear_zone_title'),
      message: t(lc, 'kanban_clear_zone_confirm', { count: String(count) }),
      confirmLabel: t(lc, 'kanban_clear_zone_btn'),
      variant: 'danger',
      onConfirm: () => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          const removedTitles = new Map(tm.actionItems.filter((i) => i.status === status).map((i) => [i.id, i.summary]))
          unlinkRefsInTeam(tm, 'action', removedTitles)
          tm.actionItems = tm.actionItems.filter((i) => i.status !== status)
          // No `sections` — same unlinkRefsInTeam cross-section rationale as
          // removeItem() above.
        }, { teamId })
      },
    })
  }

  interface ModalBundle { richBundle: RichEditorBundle; datePicker: DatePickerHandle; unsubscribeSaveStatus: () => void }
  let openBundle: ModalBundle | null = null

  /** Single teardown for the edit modal's editor bundle (plus its header save-state subscription) — called from both the modal's onClose and the container disposer, so the two can't drift. Idempotent. */
  function disposeOpenBundle(): void {
    if (!openBundle) return
    openBundle.richBundle.dispose()
    openBundle.datePicker.destroy()
    openBundle.unsubscribeSaveStatus()
    openBundle = null
  }

  /**
   * Full CRUD modal: `existing === null` creates a new card in
   * `defaultStatus`; otherwise edits/deletes `existing`. Mirrors
   * src/modules/people-tree.ts's openPersonModal shape, plus a rich-text
   * notes editor (created on open, destroyed on close) wired exactly like the
   * old inline renderNotesRow (@ref autocomplete + '/' template picker).
   *
   * No Save/Cancel: every field commits to the store as it's edited, same as
   * risks.ts/milestones.ts's rows — the only "commit" left is closing, and
   * even that isn't one, it just stops editing. A new card is inserted into
   * the store immediately (empty summary, same as risks.ts's addRisk), so
   * every field — including the very first one touched, whichever it is —
   * has something real to attach to.
   */
  function openEditModal(existing: ActionItem | null, defaultStatus: string = 'todo'): void {
    let itemId: string
    if (existing === null) {
      itemId = crypto.randomUUID()
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        const group = itemsByStatus(tm.actionItems, defaultStatus)
        // Not `group.length`: a prior delete can leave a gap in `order`
        // (removeItem/clearZone never renumber survivors), so the next
        // slot has to be past the highest existing value, not the count.
        const nextOrder = group.length === 0 ? 0 : Math.max(...group.map((i) => i.order)) + 1
        tm.actionItems.push({
          id: itemId, summary: '', notes: '', status: defaultStatus,
          dueDate: null, assignee: '', color: null, order: nextOrder,
        })
      }, { teamId, sections: ['actions'] })
    } else {
      itemId = existing.id
    }

    /** Every field's commit path funnels through here — finds this card by `itemId` (never stale: re-looked-up on every call) and mutates it in place inside a single store.update. `sections` defaults to unscoped (everything changed) for `summary`, since it's also the @mention label; every other field narrows to `['actions']`. */
    function patch(mutate: (item: ActionItem) => void, sections?: Section[]): void {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        const found = tm?.actionItems.find((i) => i.id === itemId)
        if (found) mutate(found)
      }, sections ? { teamId, sections } : { teamId })
    }

    const summaryInput = el('input', {
      type: 'text', class: 'tt-input', value: existing?.summary ?? '',
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        // Unscoped beyond the team: `summary` is the label @[…](action:id)
        // mentions resolve through live — see the note at people-tree.ts's
        // rename site.
        patch((item) => { item.summary = value })
      },
    }) as HTMLInputElement

    const datePicker = createDatePicker({
      value: existing?.dueDate ?? '', locale: lc, allowClear: true,
      onChange: () => {
        const dueDate = datePicker.getValue() === '' ? null : datePicker.getValue()
        patch((item) => { item.dueDate = dueDate }, ['actions'])
      },
    })
    const assigneeInput = el('input', {
      type: 'text', class: 'tt-input', list: datalistId, value: existing?.assignee ?? '',
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        patch((item) => { item.assignee = value }, ['actions'])
      },
    }) as HTMLInputElement
    // New cards start with no color chosen — the color tag is optional, and
    // an existing card's color can be unset the same way (see
    // renderColorChips' onclick toggle below).
    let selectedColor: ActionItemColor | null = existing?.color ?? null
    // Which card's keyboard selection to restore once the modal closes — the
    // DOM query in onClose below naturally finds nothing if this card ended
    // up deleted (empty summary), so no separate null/abandoned tracking is
    // needed the way the old Save-gated flow required.
    const focusItemIdOnClose = itemId

    const richBundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: existing?.notes ?? '',
      onChange: (md) => {
        patch((item) => { item.notes = md.trim() === '' ? '' : md }, ['actions'])
      },
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    const editor = richBundle.editor

    // --- expand-mode toggle + its mirrored save-state pill (header) -------
    // `handle` (assigned once showModal() returns, below) is only read
    // inside these onclick callbacks, which never fire before that — same
    // deferred-reference pattern closeModal() already relies on.
    let expanded = false
    const savePillMiniText = el('span', { class: 'tt-save-pill-text' })
    // Hidden until expanded: the real header pill already covers this while
    // collapsed, so a second always-visible pill in the card modal would
    // just be noise. See shell.ts's SaveStatusInfo for why this never needs
    // its own copy of the label/tooltip formatting rules.
    //
    // Reuses the header pill's own `.tt-save-pill` class for the free visual
    // match — but that class sets `display: inline-flex` unconditionally, so
    // the plain `hidden` attribute (a low-specificity UA rule) can't actually
    // hide it; `style.display` is set directly instead, which always wins.
    const savePillMini = el('span', {
      class: 'tt-save-pill',
      onclick: () => ctx.saveStatus.requestSaveNow(),
    }, savePillMiniText)
    savePillMini.style.display = 'none'
    const unsubscribeSaveStatus = ctx.saveStatus.subscribeSaveState((info) => {
      savePillMiniText.textContent = info.label
      savePillMini.title = info.title
      savePillMini.dataset.state = info.state
      savePillMini.classList.toggle(
        'tt-save-pill-clickable',
        info.state === 'dirty' || info.state === 'error' || info.state === 'permission'
      )
    })
    const expandBtn = el(
      'button',
      {
        class: 'tt-btn tt-kanban-expand-btn', type: 'button', title: t(lc, 'kanban_expand_title'),
        onclick: () => {
          expanded = !expanded
          handle.dialogEl.classList.toggle('tt-kanban-expanded', expanded)
          savePillMini.style.display = expanded ? '' : 'none'
          expandBtn.title = t(lc, expanded ? 'kanban_collapse_title' : 'kanban_expand_title')
        },
      },
      '⛶'
    )
    const headerExtra = el('div', { class: 'tt-kanban-modal-header-extra' }, savePillMini, expandBtn)

    openBundle = { richBundle, datePicker, unsubscribeSaveStatus }

    const colorRow = el('div', { class: 'tt-kanban-color-row tt-kanban-tag-chips filtering' })
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
            type: 'button', class: `tt-kanban-color-chip tt-kanban-tag-chip color-${c}`, 'data-color': c, 'aria-label': custom ?? suggestedTagName(c),
            // Clicking the already-selected chip again unsets it — the only
            // way to clear a color back to "none" once one's been picked.
            onclick: () => {
              selectedColor = selectedColor === c ? null : c
              paintSelectedColor()
              patch((item) => { item.color = selectedColor }, ['actions'])
            },
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
      el('div', { class: 'tt-field tt-kanban-notes-field' }, t(lc, 'kanban_notes_label'), editor.root),
      el(
        'div',
        { class: 'tt-kanban-form-row' },
        el('label', { class: 'tt-field' }, t(lc, 'kanban_due_label'), datePicker.root),
        el('label', { class: 'tt-field' }, t(lc, 'kanban_assignee_label'), assigneeInput)
      ),
      el('div', { class: 'tt-field' }, t(lc, 'kanban_color_label'), colorRow)
    )

    function closeModal(): void {
      handle.close()
    }

    const buttons: ModalButton[] = []
    if (existing !== null) {
      buttons.push({ label: t(lc, 'kanban_delete_btn'), danger: true, left: true, onClick: () => { closeModal(); requestDelete(existing) } })
    }
    buttons.push({ label: t(lc, 'kanban_close_btn'), onClick: () => closeModal() })

    const handle: ModalHandle = showModal({
      title: t(lc, existing === null ? 'kanban_add_title' : 'kanban_edit_title'),
      body,
      buttons,
      headerExtra,
      onClose: () => {
        disposeOpenBundle()
        // Empty summary carries no meaningful content to lose — delete
        // silently on close, same rule requestDelete() already applies to an
        // explicit delete. Covers both a "+ Card" draft nothing was ever
        // typed into and an existing card edited back down to blank.
        const current = items().find((i) => i.id === itemId)
        if (current && current.summary.trim() === '') {
          removeItem(itemId)
        } else if (current && existing === null && activeTagFilter !== null && activeTagFilter !== current.color) {
          // A new card whose final color the active filter would hide is
          // invisible the moment the modal closes — clear the filter so the
          // board's next render shows it without a second click. Only for a
          // genuinely new card: editing an existing card's color while a
          // filter is active is left alone, filtering it out is the point.
          activeTagFilter = null
          renderAll()
        }
        // Runs after showModal's close() has already removed the overlay
        // (see modal.ts), so this card, if still around, is free to take
        // focus back rather than leaving it stranded on document.body. If
        // the card above was just deleted, the query below finds nothing —
        // store.update() (both here and inside patch()) notifies subscribe()
        // synchronously, so renderAll() has already dropped it from the DOM
        // by the time this runs.
        //
        // The .focus() call itself is deferred a tick: closing via Escape
        // (focus was on the Summary <input>) vs. the Close *button* showed
        // different real-Chrome behavior — confirmed live by patching
        // HTMLElement.prototype.blur (never called) and probing
        // document.activeElement right after Escape (correctly the card) vs.
        // one macrotask later (reverted to <body>). No app code blurs it, so
        // that's Chrome's own "focused element got removed" unfocus step
        // running *after* this callback for an <input>, silently overriding
        // a synchronous .focus() here — but not for a <button>, which is why
        // Close never showed the bug. Scheduling after it instead of racing
        // it makes this the last word regardless of which path closed.
        setTimeout(() => {
          boardEl.querySelector<HTMLElement>(`[data-item-id="${focusItemIdOnClose}"]`)?.focus()
        }, 0)
      },
    })
    summaryInput.focus()
  }

  function openEditTagsModal(): void {
    const tm = findTeam()
    if (!tm) return
    const inputs = new Map<ActionItemColor, HTMLInputElement>()
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
          const nextTags: Partial<Record<ActionItemColor, string>> = { ...target.actionTagNames }
          for (const c of COLORS) {
            const value = inputs.get(c)!.value.trim()
            if (value === '') delete nextTags[c]
            else nextTags[c] = value
          }
          target.actionTagNames = nextTags
        }, { teamId, sections: ['actions'] })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_edit_tags_title'), body, buttons: [cancelBtn, saveBtn] })
  }

  function deleteColumn(columnId: string): void {
    const count = items().filter((i) => i.status === columnId).length
    if (count === 0) {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (tm?.actionColumns) tm.actionColumns = tm.actionColumns.filter((c) => c.id !== columnId)
      }, { teamId, sections: ['actions'] })
      return
    }
    openDeleteColumnModal(columnId, count)
  }

  function openDeleteColumnModal(columnId: string, count: number): void {
    const tm = findTeam()
    const targets = STATUSES.filter((s) => s !== columnId)
    const select = el('select', { class: 'tt-input tt-kanban-column-landing-select' }) as HTMLSelectElement
    for (const s of targets) select.appendChild(el('option', { value: s }, statusLabel(s, tm)))
    const body = el(
      'div', { class: 'tt-prefs-field' },
      el('p', { class: 'tt-modal-message' }, t(lc, 'kanban_delete_column_confirm', { count: String(count) })),
      el('label', { class: 'tt-field' }, t(lc, 'kanban_column_landing_label'), select)
    )
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'kanban_delete_column_btn'),
      danger: true,
      onClick: () => {
        const targetStatus = select.value
        ctx.store.update((d) => {
          const team2 = d.teams.find((t2) => t2.id === teamId)
          if (!team2) return
          const moving = team2.actionItems.filter((i) => i.status === columnId).sort((a, b) => a.order - b.order)
          const destGroup = team2.actionItems.filter((i) => i.status === targetStatus)
          let nextOrder = destGroup.length === 0 ? 0 : Math.max(...destGroup.map((i) => i.order)) + 1
          for (const i of moving) { i.status = targetStatus; i.order = nextOrder++ }
          if (team2.actionColumns) team2.actionColumns = team2.actionColumns.filter((c) => c.id !== columnId)
        }, { teamId, sections: ['actions'] })
        handle.close()
      },
    }
    const handle: ModalHandle = showModal({ title: t(lc, 'kanban_delete_column_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function emptyEl(): HTMLElement {
    return el('div', { class: 'tt-kanban-empty' }, t(lc, 'kanban_empty'))
  }

  function openCardContextMenu(itemId: string, x: number, y: number): void {
    const it = items().find((i) => i.id === itemId)
    if (!it) return
    openItemContextMenu(ctx, 'action', teamId, itemId, x, y, () => requestDelete(it))
  }

  /** Visible (post-filter) cards currently rendered in a status column, in on-screen order. */
  function cardsInColumn(status: string): HTMLElement[] {
    return Array.from(cols.get(status)!.bodyEl.querySelectorAll<HTMLElement>('.tt-kanban-card'))
  }

  /**
   * Grid-style arrow navigation for the board: Up/Down step within the
   * current card's column; Left/Right cross into the nearest non-empty
   * column in that direction (To Do, then each of the team's custom middle
   * columns in order, then Done, then Cancelled — Done and Cancelled share
   * one visual column but are separate stops here), landing on whichever
   * card in the target column is closest by vertical position to the card
   * the user came from. Returns null at a board edge or when every column
   * in that direction is empty.
   */
  function findAdjacentCard(item: ActionItem, key: string): HTMLElement | null {
    const column = cardsInColumn(item.status)
    const idx = column.findIndex((c) => c.getAttribute('data-item-id') === item.id)
    if (idx === -1) return null
    if (key === 'ArrowUp') return column[idx - 1] ?? null
    if (key === 'ArrowDown') return column[idx + 1] ?? null
    const dir = key === 'ArrowLeft' ? -1 : 1
    const curTop = column[idx]!.getBoundingClientRect().top
    for (let p = STATUSES.indexOf(item.status) + dir; p >= 0 && p < STATUSES.length; p += dir) {
      const candidates = cardsInColumn(STATUSES[p]!)
      if (candidates.length === 0) continue
      return candidates.reduce((best, c) =>
        Math.abs(c.getBoundingClientRect().top - curTop) < Math.abs(best.getBoundingClientRect().top - curTop) ? c : best
      )
    }
    return null
  }

  function renderCard(item: ActionItem, today: string, tagNames: Partial<Record<ActionItemColor, string>>): HTMLElement {
    const editBtn = el(
      'button',
      { class: 'tt-btn tt-kanban-edit-btn', type: 'button', tabindex: '-1', title: t(lc, 'kanban_edit_hint'), onclick: (e: Event) => { e.stopPropagation(); openEditModal(item) } },
      '✎'
    )
    // The title is clamped to two lines (styles.css) so cards stay dense in a
    // split pane; its own tooltip carries the untruncated summary.
    const titleEl = el('div', { class: 'tt-kanban-card-title', title: item.summary }, item.summary)
    const metaChildren: (Node | string)[] = []
    if (item.dueDate) {
      metaChildren.push(el('span', { class: 'tt-kanban-card-due' + (isOverdue(item, today) ? ' overdue' : '') }, formatDate(item.dueDate, lc)))
    }
    if (item.assignee) metaChildren.push(el('span', { class: 'tt-kanban-card-assignee' }, item.assignee))
    const customName = item.color !== null ? (tagNames[item.color] ?? null) : null
    if (customName) metaChildren.push(el('span', { class: 'tt-kanban-card-tag' }, customName))
    const backlinks = ctx.searchIndex.backlinks(teamId, 'action', item.id)
    const chip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) metaChildren.push(chip)
    const metaEl = el('div', { class: 'tt-kanban-card-meta' }, ...metaChildren)

    const card = el(
      'div',
      {
        // No color-X class when uncategorized — the card falls back to the
        // base neutral border (styles.css's .tt-kanban-card default).
        class: `tt-kanban-card status-${item.status}` + (item.color !== null ? ` color-${item.color}` : ''),
        draggable: 'true',
        tabindex: '0',
        'data-item-id': item.id,
        title: t(lc, 'kanban_card_context_hint'),
      },
      editBtn, titleEl, metaEl
    )
    card.addEventListener('dblclick', () => openEditModal(item))
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openCardContextMenu(item.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })
    // Guarded on `e.target === card` so a keypress on the edit button (a
    // child) isn't hijacked. Mirrors src/modules/risks.ts and milestones.ts's
    // row-level handler, plus grid arrow navigation across the board.
    card.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent
      if (ev.target !== card) return
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        const next = findAdjacentCard(item, ev.key)
        if (!next) return
        ev.preventDefault()
        next.focus()
        return
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        openEditModal(item)
        return
      }
      if (ev.key !== ' ') return
      // Keyboard equivalent of the right-click menu.
      ev.preventDefault()
      const rect = card.getBoundingClientRect()
      openCardContextMenu(item.id, rect.left + 16, rect.bottom)
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
      }, { teamId, sections: ['actions'] })
    })
    card.addEventListener('dragend', () => {
      draggedId = null
      clearDropClasses()
      trashEl.classList.remove('active', 'drag-over')
      hideDropZones()
    })

    return card
  }

  /** The two ends, never renamed/removed/reordered. */
  function isFixedStatus(status: string): boolean {
    return status === 'todo' || status === 'done' || status === 'cancelled'
  }

  // Unused within Task 5 itself, when this was added as part of that task's
  // declared skeleton interface — first used by Task 7's delete-column
  // landing-picker labels (openDeleteColumnModal, above).
  function statusLabel(status: string, tm: Team | undefined): string {
    if (status === 'todo') return t(lc, 'kanban_status_todo')
    if (status === 'done') return t(lc, 'kanban_status_done')
    if (status === 'cancelled') return t(lc, 'kanban_status_cancelled')
    return tm?.actionColumns?.find((c) => c.id === status)?.name ?? ''
  }

  /** Column ids in board order: fixed 'todo', the team's custom columns sorted by order, fixed 'done'/'cancelled'. */
  function statusesFor(tm: Team | undefined): string[] {
    const middle = [...(tm?.actionColumns ?? [])].sort((a, b) => a.order - b.order).map((c) => c.id)
    return ['todo', ...middle, 'done', 'cancelled']
  }

  // Reassigned on every rebuildBoard() call (see below) — read by
  // cardsInColumn/findAdjacentCard above, and by showDropZones/hideDropZones
  // and wireColumnDrop below, always as the latest board shape.
  let STATUSES: string[] = ['todo', 'done', 'cancelled']
  let cols = new Map<string, { bodyEl: HTMLElement; zoneEl: HTMLElement }>()
  // Middle-column header name spans, keyed by column id — populated fresh in
  // rebuildBoard() (like `cols` above) and read back in renderAll()'s
  // per-status loop below to append the item count, the same way
  // todoTitleEl/doneCancelTitleEl get their counts refreshed every render.
  // The column *name* is user data, so it's interpolated inline rather than
  // routed through an i18n `{count}`-placeholder key like kanban_col_todo.
  let middleNameSpans = new Map<string, HTMLElement>()

  const doneCountEl = el('span', {})
  const cancelledCountEl = el('span', {})
  // Column-title counts — always the column's full item count, unaffected by
  // activeTagFilter (see the "Counts feed the filter chips" comment in
  // renderAll below). The middle-column live count (middleNameSpans, set in
  // renderAll) follows this same rule.
  const todoTitleEl = el('span', {})
  const doneCancelTitleEl = el('span', {})

  function showDropZones(): void {
    STATUSES.forEach((s) => cols.get(s)!.zoneEl.classList.add('active'))
    // Lets the CSS shrink each column drop-zone's bottom edge, clearing
    // space for the full-width trash bar (see .tt-kanban-trash) so the two
    // never overlap. Also out-of-flow (see the drop-zone comment on `cols`
    // above), so this doesn't reflow anything mid-dragstart either.
    kanbanRootEl.classList.add('dragging')
  }
  function hideDropZones(): void {
    STATUSES.forEach((s) => cols.get(s)!.zoneEl.classList.remove('active', 'drag-over'))
    kanbanRootEl.classList.remove('dragging')
  }

  /** Catches a drop onto empty column space (below the last card, or an empty column) — the case moveCard's `targetId === null` append handles. Card-level drop handlers already stopPropagation() so this never double-fires for a drop that landed on a specific card. */
  function wireColumnDrop(bodyEl: HTMLElement, status: string, zoneEl: HTMLElement): void {
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
      trashEl.classList.remove('active', 'drag-over')
      hideDropZones()
      const srcId = draggedId
      draggedId = null
      if (srcId === null) return
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        moveCard(tm.actionItems, srcId, status, null, 'after')
      }, { teamId, sections: ['actions'] })
    })
  }

  /** Makes a middle column's header draggable, reordering `Team.actionColumns` on drop. Only called for middle-column heads (see rebuildBoard below) — the fixed Todo/Done+Cancelled headers never call this, so they're never `draggable` and never gain listeners, naturally excluding them as both a drag source and a drop target. `draggedColumnId === status` also guards a column being dropped onto itself. */
  function wireColumnHeaderDrag(headEl: HTMLElement, status: string): void {
    headEl.draggable = true
    headEl.addEventListener('dragstart', (e) => {
      draggedColumnId = status
      ;(e as DragEvent).dataTransfer?.setData('text/plain', status)
    })
    // A card drag and a column-header drag are mutually exclusive: bail out
    // of the header's own handlers whenever a card drag is in flight, so
    // stale `draggedColumnId` state (see dragend below) can never be misread
    // as "a column drop is in progress" while the user is actually mid-way
    // through dragging a card.
    headEl.addEventListener('dragover', (e) => {
      if (draggedId !== null) return
      if (draggedColumnId === null || draggedColumnId === status) return
      e.preventDefault()
    })
    headEl.addEventListener('drop', (e) => {
      if (draggedId !== null) return
      e.preventDefault()
      const srcId = draggedColumnId
      draggedColumnId = null
      if (srcId === null || srcId === status) return
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm?.actionColumns) return
        moveColumn(tm.actionColumns, srcId, status, 'before')
      }, { teamId, sections: ['actions'] })
    })
    // Cards clear their own drag state on `dragend` (see the card-level
    // handler in renderCard above); a column header needs the same guard.
    // Without it, releasing a column drag anywhere that isn't a valid
    // column-header drop target (empty board space, the trash bar, a card,
    // Escape) leaves `draggedColumnId` set forever — and a later CARD drag
    // dropped on a different column's header would then be misread as a
    // pending column reorder by the checks above.
    headEl.addEventListener('dragend', () => { draggedColumnId = null })
  }

  /** Rebuilds the whole board (column headers + bodies, drop zones, add/rename/delete affordances) from the team's current actionColumns. Same "full rebuild is simplest and correct" convention as people-tree.ts's tree — called at the top of renderAll(), below, before that function repopulates each column's cards. */
  function rebuildBoard(): void {
    const tm = findTeam()
    STATUSES = statusesFor(tm)
    // Drop-zone highlight overlays — one per status body, mirroring
    // src/modules/people-tree.ts's rootDropEl. Each `zoneEl` is attached as a
    // sibling of its `bodyEl` (in the `tt-kanban-col-body-wrap` built below),
    // not a child of it, so it's absolutely positioned outside `bodyEl`'s
    // flex-laid-out card flow — toggling it (showDropZones/hideDropZones)
    // never reflows the cards. (This whole map is thrown away and rebuilt
    // fresh on every renderAll() call regardless, so — unlike the pre-custom-
    // columns version of this board — sibling placement is no longer about
    // surviving `bodyEl.innerHTML = ''`; both elements get recreated
    // together either way.)
    cols = new Map(STATUSES.map((s) => [s, {
      bodyEl: el('div', { class: 'tt-kanban-col-body' }),
      zoneEl: el('div', { class: 'tt-kanban-dropzone' }),
    }]))

    const todoColEl = el(
      'div', { class: 'tt-kanban-col' },
      el('div', { class: 'tt-kanban-col-head' }, todoTitleEl,
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, 'todo') }, t(lc, 'kanban_add_card'))),
      el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get('todo')!.bodyEl, cols.get('todo')!.zoneEl)
    )

    middleNameSpans = new Map()
    // Set inside the map() below when a just-added column's id matches
    // pendingColumnFocusId, then invoked once, after boardEl.append() below —
    // not from inside the map() callback itself, since the column's head
    // isn't attached to the document yet at that point and .focus() on a
    // detached element is a no-op. A plain `let` reassigned only inside the
    // .map() callback below hits a TS 6 control-flow narrowing quirk (the
    // read after .map() infers `never` instead of the declared type) — the
    // object-wrapper indirection sidesteps it.
    const focusAfterAttach: { run: (() => void) | null } = { run: null }
    const middleColEls = STATUSES.filter((s) => !isFixedStatus(s)).map((id) => {
      const name = tm?.actionColumns?.find((c) => c.id === id)?.name ?? ''
      const nameSpan = el('span', { class: 'tt-kanban-col-name', title: t(lc, 'kanban_rename_column_hint') }, name)
      middleNameSpans.set(id, nameSpan)
      const nameInput = el('input', {
        type: 'text', class: 'tt-input tt-kanban-col-rename-input', value: name, style: 'display:none',
      }) as HTMLInputElement
      function startRename(): void {
        nameSpan.style.display = 'none'
        nameInput.style.display = ''
        nameInput.focus()
        nameInput.select()
      }
      function commitRename(): void {
        nameInput.style.display = 'none'
        nameSpan.style.display = ''
        const value = nameInput.value.trim()
        if (value !== '' && value !== name) renameColumn(id, value)
      }
      nameSpan.addEventListener('click', startRename)
      nameInput.addEventListener('blur', commitRename)
      nameInput.addEventListener('keydown', blurOnEnter)
      const headEl = el(
        'div', { class: 'tt-kanban-col-head' },
        nameSpan, nameInput,
        el('button', { class: 'tt-btn tt-kanban-col-delete-btn', type: 'button', title: t(lc, 'kanban_delete_column_title'), onclick: () => deleteColumn(id) }, '🗑'),
        el('button', { class: 'tt-btn tt-kanban-add-btn', type: 'button', onclick: () => openEditModal(null, id) }, t(lc, 'kanban_add_card'))
      )
      wireColumnHeaderDrag(headEl, id)
      if (pendingColumnFocusId === id) {
        pendingColumnFocusId = null
        focusAfterAttach.run = startRename
      }
      return el('div', { class: 'tt-kanban-col' }, headEl,
        el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get(id)!.bodyEl, cols.get(id)!.zoneEl))
    })

    const addColumnBtn = el('button', {
      class: 'tt-btn tt-kanban-add-column-btn', type: 'button', title: t(lc, 'kanban_add_column'),
      onclick: () => addColumn(),
    }, t(lc, 'kanban_add_column'))

    const doneCancelColEl = el(
      'div', { class: 'tt-kanban-col' },
      el('div', { class: 'tt-kanban-col-head' }, doneCancelTitleEl),
      el('div', { class: 'tt-kanban-zone-label' }, doneCountEl,
        el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('done') }, '🗑')),
      el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get('done')!.bodyEl, cols.get('done')!.zoneEl),
      el('div', { class: 'tt-kanban-divider' }),
      el('div', { class: 'tt-kanban-zone-label' }, cancelledCountEl,
        el('button', { class: 'tt-btn tt-kanban-zone-trash', type: 'button', title: t(lc, 'kanban_clear_zone_title'), onclick: () => clearZone('cancelled') }, '🗑')),
      el('div', { class: 'tt-kanban-col-body-wrap' }, cols.get('cancelled')!.bodyEl, cols.get('cancelled')!.zoneEl)
    )

    boardEl.innerHTML = ''
    boardEl.append(todoColEl, ...middleColEls, addColumnBtn, doneCancelColEl)
    STATUSES.forEach((s) => wireColumnDrop(cols.get(s)!.bodyEl, s, cols.get(s)!.zoneEl))
    focusAfterAttach.run?.()
  }

  const boardEl = el('div', { class: 'tt-kanban-board' })
  const datalistEl = el('datalist', { id: datalistId })

  // Drop target for deleting a card by dragging it off the board — shown
  // only while dragging (see dragstart in renderCard above), same rationale
  // as src/modules/people-tree.ts's rootDropEl: revealing it must not
  // reflow the board mid-dragstart, or Chrome cancels the drag.
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

  function updateDatalist(tm: Team | undefined): void {
    datalistEl.innerHTML = ''
    const names = tm ? [...tm.stakeholders, ...tm.members].map((p) => p.name) : []
    for (const name of Array.from(new Set(names))) {
      datalistEl.appendChild(el('option', { value: name }))
    }
  }

  function renderAll(): void {
    rebuildBoard()
    const tm = findTeam()
    const today = todayIso()
    const tagNames = tm?.actionTagNames ?? {}
    updateDatalist(tm)
    const byStatus: Record<string, ActionItem[]> = {}
    STATUSES.forEach((s) => { byStatus[s] = [] })
    // Counts feed the filter chips. Only the two live columns count: a chip
    // reading "Urgent 7" where six of those are already done would be
    // answering a question nobody asked.
    const counts: Record<ActionItemColor, number> = { slate: 0, brass: 0, sage: 0, rust: 0, plum: 0, ledger: 0 }
    for (const it of tm?.actionItems ?? []) {
      const bucket = byStatus[it.status]
      if (!bucket) continue // its column was deleted elsewhere; ignore until reassigned
      bucket.push(it)
      if (it.color !== null && it.status !== 'done' && it.status !== 'cancelled') counts[it.color]++
    }
    renderTagChips(tagNames, counts)
    for (const s of STATUSES) {
      const group = byStatus[s]!.sort((a, b) => a.order - b.order)
      const visible = activeTagFilter === null ? group : group.filter((i) => i.color === activeTagFilter)
      const bodyEl = cols.get(s)!.bodyEl
      bodyEl.innerHTML = ''
      if (visible.length === 0) bodyEl.appendChild(emptyEl())
      else visible.forEach((it) => bodyEl.appendChild(renderCard(it, today, tagNames)))
      // Same "always the full count, unaffected by activeTagFilter" rule as
      // todoTitleEl/doneCancelTitleEl below (see the comment there) — a
      // middle column's live count is built from `group`, not `visible`.
      const nameSpan = middleNameSpans.get(s)
      if (nameSpan) {
        const name = tm?.actionColumns?.find((c) => c.id === s)?.name ?? ''
        nameSpan.textContent = `${name} (${group.length})`
      }
    }
    doneCountEl.textContent = t(lc, 'kanban_done_heading', { count: String(byStatus.done!.length) })
    cancelledCountEl.textContent = t(lc, 'kanban_cancelled_heading', { count: String(byStatus.cancelled!.length) })
    todoTitleEl.textContent = t(lc, 'kanban_col_todo', { count: String(byStatus.todo!.length) })
    doneCancelTitleEl.textContent = t(lc, 'kanban_col_done_cancelled', {
      count: String(byStatus.done!.length + byStatus.cancelled!.length),
    })
  }
  renderAll()

  function focusedRenameInput(): HTMLElement | null {
    const active = document.activeElement
    if (!(active instanceof HTMLInputElement) || !boardEl.contains(active)) return null
    return active.classList.contains('tt-kanban-col-rename-input') ? active : null
  }

  const deferredRebuild = createDeferredRebuild(renderAll)

  // Every card's backlinks chip must react to a mention of it
  // appearing/disappearing anywhere BACKLINK_SECTIONS covers — a daily note,
  // a person's notes, a milestone or risk follow-up — not just edits to
  // actions themselves, so the watch list is that full set rather than just
  // 'actions'. 'people' also feeds updateDatalist() above, which reads
  // stakeholders/members for the assignee autocomplete.
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    // The edit modal's notes editor is never rebuilt from the store on a
    // foreign change (only a full renderAll() below, which would blow away
    // an in-progress edit), so patch its @mention chips in place the same
    // way daily/person notes do — safe even mid-typing (see
    // Editor.refreshRefLabels' doc comment).
    if (openBundle) openBundle.richBundle.editor.refreshRefLabels()
    const active = focusedRenameInput()
    if (active) { deferredRebuild.arm(active); return }
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
  // Lands focus on the first card (To Do, then the middle columns in order,
  // then Done, then Cancelled — same order as STATUSES/the board's DOM) the
  // moment the module opens, so arrow-key navigation works immediately
  // without a preceding Tab. Only for the pane the user is actually in — a
  // team switch remounts both panes together, and without this guard
  // whichever pane happens to mount second (always pane 1) would silently
  // steal focus from pane 0's.
  if (ctx.paneIdx === ctx.store.doc.nav.focusedPane) {
    boardEl.querySelector<HTMLElement>('.tt-kanban-card')?.focus()
  }

  // No SEARCH_FOCUS_ITEM_EVENT listener here, unlike risks.ts/milestones.ts:
  // those need it to expand their own inline follow-up row before a match
  // inside it can be found/highlighted. A kanban card has no such inline
  // state — search-ui.ts's commit() already resolves the matched card via
  // `[data-item-id]` and applySearchHighlight() (search-highlight.ts) gives
  // it real focus, which is all landing here needs: same selection ring
  // arrow-key nav uses, and Enter opens it via the card's own keydown
  // handler above (openEditModal(item)) — no separate open-on-search path.
  const disposeArrowFallback = installArrowFallbackFocus(ctx, boardEl, '.tt-kanban-card', ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'])

  return () => {
    unsubscribe()
    disposeOpenBundle()
    disposeArrowFallback()
    deferredRebuild.dispose()
  }
})
