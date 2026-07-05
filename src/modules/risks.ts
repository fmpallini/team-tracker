// src/modules/risks.ts — Task 22: risks module. A flat, orderable list of
// Risk per team (structurally close to src/modules/action-items.ts: same
// disposer WeakMap, loc.teamId-keyed store.update helpers, flat before/after
// drag reorder), plus two things neither action-items nor milestones need:
// a *computed, never-persisted* exposure column (chance*impact, colored by
// range) and a per-row expandable follow-up editor that mirrors
// src/modules/person-notes.ts's full editor + @ref + template-picker wiring.
// Only one follow-up editor is ever mounted at a time — expanding a row
// disposes whichever editor was previously expanded, which keeps the
// lifecycle simple (no need to track/preserve multiple live editors across
// rebuilds).
import type { Risk, RiskPlan, Loc, Team } from '../core/types'
import { t, todayIso, type MsgKey } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
import { computeFlatDropPosition } from './action-items'
import { el } from '../ui/dom'

/** Per-container disposers — see the extensive comment on the same pattern in src/modules/daily-notes.ts. */
const disposers = new WeakMap<HTMLElement, () => void>()

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function nowHHMM(): string {
  const now = new Date()
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

// --- pure, unit-testable helpers -------------------------------------------

/** Chance × impact — computed on the fly, never written back to the Risk record. */
export function computeExposure(chance: number, impact: number): number {
  return chance * impact
}

export type ExposureLevel = 'low' | 'medium' | 'high'

/** Buckets a computed exposure into the brief's three color ranges: 1-2 low, 3-4 medium, 6-9 high (5 is unreachable for a 1-3 × 1-3 product, but the thresholds are written generically rather than as a lookup table). */
export function exposureLevel(exposure: number): ExposureLevel {
  if (exposure >= 6) return 'high'
  if (exposure >= 3) return 'medium'
  return 'low'
}

const EXPOSURE_COLORS: Record<ExposureLevel, string> = {
  low: '#16a34a',
  medium: '#ca8a04',
  high: '#dc2626',
}

export function exposureColor(exposure: number): string {
  return EXPOSURE_COLORS[exposureLevel(exposure)]
}

export type ExposureSort = 'none' | 'desc' | 'asc'

/** Cycles the "Exposição" header's sort state: unsorted -> desc -> asc -> unsorted. */
export function nextExposureSort(current: ExposureSort): ExposureSort {
  return current === 'none' ? 'desc' : current === 'desc' ? 'asc' : 'none'
}

/**
 * Display order for the risk list. `'none'` returns the manual `order`
 * sequence — the array's persisted, drag-reorderable order. `'desc'`/`'asc'`
 * layer a *display-only* sort by computed exposure on top of that sequence,
 * via a stable sort so risks with equal exposure keep their relative manual
 * order; `order` itself is never touched by sorting, so switching back to
 * `'none'` (or reloading) always restores the manual arrangement.
 */
export function sortRisksForDisplay(risks: Risk[], sort: ExposureSort): Risk[] {
  const manual = [...risks].sort((a, b) => a.order - b.order)
  if (sort === 'none') return manual
  return manual.sort((a, b) => {
    const diff = computeExposure(a.chance, a.impact) - computeExposure(b.chance, b.impact)
    return sort === 'desc' ? -diff : diff
  })
}

/**
 * Moves `draggedId` to become a sibling (before/after `targetId`) within
 * `risks`, renumbering `order` across the whole array so it stays a dense
 * 0..n-1 sequence — mirrors src/modules/action-items.ts's `moveActionItem`,
 * flattened for `Risk`. Mutates the Risk objects in place so it can run
 * directly inside a `store.update` callback. No-ops when dragging an item
 * onto itself or when either id isn't present.
 */
export function moveRisk(risks: Risk[], draggedId: string, targetId: string, position: 'before' | 'after'): void {
  if (draggedId === targetId) return
  const sorted = [...risks].sort((a, b) => a.order - b.order)
  const draggedIdx = sorted.findIndex((r) => r.id === draggedId)
  if (draggedIdx === -1) return
  const dragged = sorted.splice(draggedIdx, 1)[0]!
  const targetIdx = sorted.findIndex((r) => r.id === targetId)
  if (targetIdx === -1) return
  const insertAt = position === 'before' ? targetIdx : targetIdx + 1
  sorted.splice(insertAt, 0, dragged)
  sorted.forEach((r, i) => { r.order = i })
}

const PLAN_OPTIONS: RiskPlan[] = ['mitigate', 'transfer', 'eliminate', 'accept']
const PLAN_KEYS: Record<RiskPlan, MsgKey> = {
  mitigate: 'risk_plan_mitigate',
  transfer: 'risk_plan_transfer',
  eliminate: 'risk_plan_eliminate',
  accept: 'risk_plan_accept',
}

// --- renderer ---------------------------------------------------------------

export function renderRisks(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'risks') return // registered only for 'risks'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function risks(): Risk[] {
    return findTeam()?.risks ?? []
  }

  let draggedId: string | null = null
  let sortMode: ExposureSort = 'none'
  let expandedId: string | null = null
  let focusRiskId: string | null = null

  interface ExpandedBundle { id: string; editor: Editor; atHandle: AtAutocompleteHandle; tplHandle: TemplatePickerHandle }
  let expandedBundle: ExpandedBundle | null = null

  function disposeExpandedBundle(): void {
    if (!expandedBundle) return
    expandedBundle.atHandle.dispose()
    expandedBundle.tplHandle.dispose()
    expandedBundle.editor.destroy()
    expandedBundle = null
  }

  function clearDropClasses(): void {
    listEl.querySelectorAll('.tt-risk-row').forEach((n) => {
      n.classList.remove('tt-risk-drop-before', 'tt-risk-drop-after')
    })
  }

  function removeRisk(id: string): void {
    if (expandedId === id) expandedId = null // local UI state; must flip before store.update fires the synchronous subscriber below
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.risks = tm.risks.filter((r) => r.id !== id)
    })
  }

  function openDeleteConfirm(r: Risk): void {
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'risk_delete_confirm', { title: r.title }))
    let handle: ModalHandle
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'risk_delete_btn'),
      primary: true,
      onClick: () => {
        removeRisk(r.id)
        handle.close()
      },
    }
    handle = showModal({ title: t(lc, 'risk_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function requestDelete(r: Risk): void {
    if (r.title.trim() === '') {
      removeRisk(r.id) // empty titles carry no meaningful content to lose — delete silently
      return
    }
    openDeleteConfirm(r)
  }

  function toggleExpand(id: string): void {
    expandedId = expandedId === id ? null : id
    renderAll()
  }

  function buildSelect(className: string, options: { value: string; label: string }[], selected: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el('select', {
      class: className,
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    })
    for (const opt of options) {
      select.appendChild(el('option', { value: opt.value }, opt.label))
    }
    select.value = selected
    return select
  }

  function getPeople(): AtPerson[] {
    const tm = findTeam()
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  /** Builds the full rich editor for a risk's follow-up, wired exactly like src/modules/person-notes.ts (editor + @ref autocomplete + '/' template picker), scoped to 'any' templates since a follow-up isn't tied to a person or a day. Registers itself as `expandedBundle` so the caller can dispose it later. */
  function renderFollowupRow(r: Risk): HTMLElement {
    const editor: Editor = createEditor(
      {
        onChange() {
          const md = editor.getMd()
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            const found = tm?.risks.find((rr) => rr.id === r.id)
            if (!found) return
            found.followup = md.trim() === '' ? '' : md
          })
        },
        onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
        onAtTrigger() {},
        onSlashTrigger() {},
      },
      lc
    )
    editor.setMd(r.followup)

    const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
    const tplHandle = attachTemplatePicker(editor, {
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getCtx: () => ({ dateIso: todayIso(), time: nowHHMM(), teamName: findTeam()?.name, locale: lc }),
      locale: lc,
    })

    expandedBundle = { id: r.id, editor, atHandle, tplHandle }

    return el('div', { class: 'tt-risk-followup-row', 'data-risk-followup-id': r.id }, editor.root)
  }

  function renderRow(r: Risk): HTMLElement {
    const exposure = computeExposure(r.chance, r.impact)

    const titleInput = el('input', {
      type: 'text', class: 'tt-risk-title-input tt-input', placeholder: t(lc, 'risk_title_placeholder'), value: r.title,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
          if (found) found.title = value
        })
      },
    })

    const numberOptions = [1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))
    const chanceSelect = buildSelect('tt-risk-chance-select', numberOptions, String(r.chance), (value) => {
      ctx.store.update((d) => {
        const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
        if (found) found.chance = Number(value) as 1 | 2 | 3
      })
    })

    const impactSelect = buildSelect('tt-risk-impact-select', numberOptions, String(r.impact), (value) => {
      ctx.store.update((d) => {
        const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
        if (found) found.impact = Number(value) as 1 | 2 | 3
      })
    })

    const exposureBadge = el(
      'span',
      { class: `tt-risk-exposure-badge tt-risk-exposure-${exposureLevel(exposure)}` },
      String(exposure)
    )
    exposureBadge.style.backgroundColor = exposureColor(exposure)

    const planSelect = buildSelect(
      'tt-risk-plan-select',
      PLAN_OPTIONS.map((p) => ({ value: p, label: t(lc, PLAN_KEYS[p]) })),
      r.plan,
      (value) => {
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
          if (found) found.plan = value as RiskPlan
        })
      }
    )

    const expanded = expandedId === r.id
    const expandBtn = el(
      'button',
      { class: 'tt-btn tt-risk-expand-btn', type: 'button', title: t(lc, 'risk_followup_toggle_title'), onclick: () => toggleExpand(r.id) },
      expanded ? '▾' : '▸'
    )

    const deleteBtn = el(
      'button',
      { class: 'tt-btn tt-risk-delete-btn', type: 'button', title: t(lc, 'risk_delete_title'), onclick: () => requestDelete(r) },
      '🗑'
    )

    const row = el(
      'div',
      { class: 'tt-risk-row', draggable: sortMode === 'none' ? 'true' : 'false', 'data-risk-id': r.id },
      titleInput, chanceSelect, impactSelect, exposureBadge, planSelect, expandBtn, deleteBtn
    )
    if (expanded) row.classList.add('tt-risk-row-expanded')

    // Drag reorder only makes sense against the manual `order` sequence — a
    // display-only exposure sort has no manual position to reorder into, so
    // dragging is disabled while one is active (mirrors the `draggable`
    // attribute above).
    if (sortMode === 'none') {
      row.addEventListener('dragstart', (e) => {
        draggedId = r.id
        const dt = (e as DragEvent).dataTransfer
        if (dt) { dt.setData('text/plain', r.id); dt.effectAllowed = 'move' }
      })
      row.addEventListener('dragover', (e) => {
        if (draggedId === null || draggedId === r.id) return
        e.preventDefault()
        const rect = row.getBoundingClientRect()
        const pos = computeFlatDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
        clearDropClasses()
        row.classList.add(`tt-risk-drop-${pos}`)
      })
      row.addEventListener('dragleave', () => {
        row.classList.remove('tt-risk-drop-before', 'tt-risk-drop-after')
      })
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        clearDropClasses()
        const srcId = draggedId
        draggedId = null
        if (srcId === null || srcId === r.id) return
        const rect = row.getBoundingClientRect()
        const pos = computeFlatDropPosition((e as MouseEvent).clientY - rect.top, rect.height)
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          moveRisk(tm.risks, srcId, r.id, pos)
        })
      })
      row.addEventListener('dragend', () => {
        draggedId = null
        clearDropClasses()
      })
    }

    return row
  }

  const listEl = el('div', { class: 'tt-risk-list' })

  const sortIndicatorEl = el('span', { class: 'tt-risk-sort-indicator' })
  const exposureHeaderBtn = el(
    'button',
    {
      class: 'tt-risk-header-exposure', type: 'button', title: t(lc, 'risk_sort_exposure_title'),
      onclick: () => { sortMode = nextExposureSort(sortMode); renderAll() },
    },
    t(lc, 'risk_col_exposure'), sortIndicatorEl
  )
  const headerRow = el(
    'div',
    { class: 'tt-risk-header-row' },
    el('span', { class: 'tt-risk-header-title' }, t(lc, 'risk_col_title')),
    el('span', { class: 'tt-risk-header-chance' }, t(lc, 'risk_col_chance')),
    el('span', { class: 'tt-risk-header-impact' }, t(lc, 'risk_col_impact')),
    exposureHeaderBtn,
    el('span', { class: 'tt-risk-header-plan' }, t(lc, 'risk_col_plan')),
    el('span', { class: 'tt-risk-header-followup' }, t(lc, 'risk_col_followup')),
    el('span', { class: 'tt-risk-header-spacer' })
  )

  function updateSortIndicator(): void {
    sortIndicatorEl.textContent = sortMode === 'desc' ? ' ▾' : sortMode === 'asc' ? ' ▲' : ''
    exposureHeaderBtn.classList.toggle('active', sortMode !== 'none')
  }

  function renderAll(): void {
    disposeExpandedBundle() // any previously-expanded editor is torn down before the list (and possibly a fresh one) is rebuilt
    listEl.innerHTML = ''
    const list = sortRisksForDisplay(risks(), sortMode)
    if (list.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-risk-empty' }, t(lc, 'risk_empty')))
    } else {
      for (const r of list) {
        listEl.appendChild(renderRow(r))
        if (expandedId === r.id) listEl.appendChild(renderFollowupRow(r))
      }
    }
    updateSortIndicator()

    if (focusRiskId) {
      listEl.querySelector<HTMLInputElement>(`[data-risk-id="${focusRiskId}"] .tt-risk-title-input`)?.focus()
      focusRiskId = null
    }
  }

  function addRisk(): void {
    const newId = crypto.randomUUID()
    focusRiskId = newId
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      const maxOrder = tm.risks.length === 0 ? -1 : Math.max(...tm.risks.map((r) => r.order))
      tm.risks.push({ id: newId, title: '', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: maxOrder + 1, closed: false })
    })
  }

  const addBtn = el(
    'button',
    { class: 'tt-btn tt-risk-add-btn', type: 'button', onclick: () => addRisk() },
    t(lc, 'risk_add_btn')
  )
  const toolbar = el('div', { class: 'tt-risk-toolbar' }, addBtn)

  /**
   * True (and returns the focused element) for the caret-sensitive elements
   * this module owns: the title text input (mirrors
   * src/modules/action-items.ts's `focusedCaretInput`) and — since a follow-up
   * editor can be live-edited for a while before its debounced onChange
   * commits — the expanded row's contenteditable `.editor` itself. Selects
   * are deliberately excluded: like the checkboxes in action-items/
   * milestones, choosing an option has no caret to preserve, so a foreign
   * change is free to rebuild immediately.
   */
  function focusedCaretElement(): HTMLElement | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !container.contains(active)) return null
    if (active instanceof HTMLInputElement && active.type === 'text') return active
    if (active.classList.contains('editor') && active.isContentEditable) return active
    return null
  }

  // Same rationale as action-items.ts's identically-shaped subscribe
  // callback: a full rebuild is the simplest correct way to keep row
  // order/exposure/expansion in sync with the store, but it would blow away
  // an in-progress title edit's caret, or tear down and recreate the
  // expanded follow-up editor out from under an in-progress keystroke, if
  // some *other* change fires while either is focused. Skip that one rebuild
  // and defer it to the field's next blur — nothing is lost, since blur is
  // exactly when this field's own edit (if any) commits and would have
  // triggered a rebuild anyway.
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretElement()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-risks' }, toolbar, headerRow, listEl))
  renderAll()

  disposers.set(container, () => {
    unsubscribe()
    disposeExpandedBundle()
  })
}
