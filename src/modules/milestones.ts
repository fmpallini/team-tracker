// src/modules/milestones.ts — Task 21: milestones module. Two stacked areas
// inside one container: a proportional-timeline SVG (top) and an editable,
// date-sorted list (bottom). Reuses the same structural discipline as
// src/modules/action-items.ts — a per-container disposer WeakMap, loc.teamId-
// keyed store.update helpers, and the "skip rebuild while a text/date input
// is focused, defer to blur" strategy so an in-progress edit's caret survives
// a foreign store change. The SVG itself is always fully rebuilt: nothing
// inside it can hold DOM focus, so there is nothing to preserve there.
//
// The calendar (src/ui/calendar.ts, Task 18) reads team.milestones directly
// for its 🚩 markers, so any store.update here is picked up automatically —
// this module never talks to the calendar.
import type { Milestone, Loc, Team } from '../core/types'
import { t, todayIso, formatDate } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { showModal, type ModalButton, type ModalHandle } from '../ui/modal'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson, type AtAutocompleteHandle } from '../ui/atref'
import { attachTemplatePicker, type TemplatePickerHandle } from '../ui/template-picker'
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

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Minimum horizontal distance (px) between two neighboring milestone dots. */
const MIN_GAP = 24
const TIMELINE_HEIGHT = 90
const CIRCLE_R = 6
/** Left/right margin reserved so the first/last circle's stroke never clips against the SVG edge. */
const H_PADDING = 24
/** Fallback drawable width used when the container hasn't been laid out yet (e.g. jsdom, or first paint before layout). */
const FALLBACK_WIDTH = 200

// --- pure, unit-testable helpers -------------------------------------------

/** Milestones sorted by date ascending (ties keep their original relative order). */
export function sortByDate<T extends { date: string }>(milestones: T[]): T[] {
  return [...milestones].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** Truncates a title to 16 chars (+ ellipsis) for the compact under-dot label; callers pair this with a full-text `<title>`/tooltip. */
export function truncateTitle(title: string): string {
  return title.length > 16 ? `${title.slice(0, 16)}…` : title
}

export interface TimelineLayout {
  /** Milestone id -> x position (px), in a [0, innerWidth] coordinate space (no H_PADDING baked in — callers add their own margin). */
  x: Record<string, number>
  /**
   * Width (px) needed to honor `minGap` between every pair of date-sorted
   * neighbors while keeping positions exactly proportional to elapsed time.
   * Equals the passed-in `width` when no growth was required; larger
   * otherwise — callers should size the SVG to this and let its container
   * scroll horizontally.
   */
  innerWidth: number
  /** x position of the "today" marker, or null when `today` falls outside [min date, max date]. */
  todayX: number | null
}

/**
 * Pure layout math for the timeline. Positions are proportional to elapsed
 * time between the earliest and latest milestone date; growing `innerWidth`
 * uniformly (rather than special-casing individual gaps) is what lets a
 * single "grow" preserve *every* pair's proportionality — a uniform scale-up
 * multiplies every gap by the same factor.
 *
 * Milestones that land on the exact same date (zero time delta) can't be
 * separated by scaling alone (any width keeps them coincident), so a final
 * forward pass nudges same-date coincident points apart by `minGap` — this
 * is the one place positions are not exactly proportional, and only applies
 * to same-date ties.
 */
export function computeTimelineLayout(
  milestones: { id: string; date: string }[],
  minGap: number,
  width: number,
  today: string
): TimelineLayout {
  if (milestones.length === 0) return { x: {}, innerWidth: width, todayX: null }

  const sorted = sortByDate(milestones)

  if (sorted.length === 1) {
    const only = sorted[0]!
    const x = width / 2
    return { x: { [only.id]: x }, innerWidth: width, todayX: today === only.date ? x : null }
  }

  const minMs = Date.parse(sorted[0]!.date)
  const maxMs = Date.parse(sorted[sorted.length - 1]!.date)
  const span = maxMs - minMs // >= 0 since sorted ascending

  // Fraction (0..1) of the way from min to max date. When every milestone
  // shares the same date (span === 0), everyone lands at 0.5 — the tie-break
  // pass below is what actually spreads them out.
  const fracs = sorted.map((m) => (span === 0 ? 0.5 : (Date.parse(m.date) - minMs) / span))

  // Smallest *positive* fractional gap between date-sorted neighbors (ties,
  // i.e. diff === 0, are excluded — scaling can't fix those). This drives how
  // much the width must grow so that gap alone still clears minGap.
  let minFrac = Infinity
  for (let i = 1; i < fracs.length; i++) {
    const d = fracs[i]! - fracs[i - 1]!
    if (d > 0 && d < minFrac) minFrac = d
  }

  let innerWidth = width
  if (minFrac !== Infinity) {
    const needed = minGap / minFrac
    if (needed > innerWidth) innerWidth = needed
  }

  const raw = fracs.map((f) => f * innerWidth)

  // Forward pass: enforce minGap against same-date (zero-frac-diff) ties,
  // and as a defensive floor in general. For any pair the scale-up above
  // already handled, raw[i] already exceeds x[i-1] + minGap, so this is a
  // no-op there.
  const x: number[] = [raw[0]!]
  for (let i = 1; i < raw.length; i++) {
    x.push(Math.max(raw[i]!, x[i - 1]! + minGap))
  }
  if (x[x.length - 1]! > innerWidth) innerWidth = x[x.length - 1]!

  const xMap: Record<string, number> = {}
  sorted.forEach((m, i) => { xMap[m.id] = x[i]! })

  let todayX: number | null = null
  const todayMs = Date.parse(today)
  if (todayMs >= minMs && todayMs <= maxMs) {
    const frac = span === 0 ? 0.5 : (todayMs - minMs) / span
    todayX = frac * innerWidth
  }

  return { x: xMap, innerWidth, todayX }
}

// --- renderer ---------------------------------------------------------------

export function renderMilestones(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'milestones') return // registered only for 'milestones'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return ctx.store.doc.teams.find((tm) => tm.id === teamId)
  }
  function milestones(): Milestone[] {
    return findTeam()?.milestones ?? []
  }

  let focusMilestoneId: string | null = null
  let expandedId: string | null = null

  interface ExpandedBundle { id: string; editor: Editor; atHandle: AtAutocompleteHandle; tplHandle: TemplatePickerHandle }
  let expandedBundle: ExpandedBundle | null = null

  function disposeExpandedBundle(): void {
    if (!expandedBundle) return
    expandedBundle.atHandle.dispose()
    expandedBundle.tplHandle.dispose()
    expandedBundle.editor.destroy()
    expandedBundle = null
  }

  function toggleExpand(id: string): void {
    expandedId = expandedId === id ? null : id
    renderAll()
  }

  function getPeople(): AtPerson[] {
    const tm = findTeam()
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  /** Full rich editor for a milestone's follow-up, wired exactly like src/modules/risks.ts's renderFollowupRow (editor + @ref autocomplete + '/' template picker), scoped to 'any' templates. Registers itself as `expandedBundle` so the caller can dispose it later. */
  function renderFollowupRow(m: Milestone): HTMLElement {
    const editor: Editor = createEditor(
      {
        onChange() {
          const md = editor.getMd()
          ctx.store.update((d) => {
            const tm = d.teams.find((t2) => t2.id === teamId)
            const found = tm?.milestones.find((mm) => mm.id === m.id)
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
    editor.setMd(m.followup)

    const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })
    const tplHandle = attachTemplatePicker(editor, {
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getCtx: () => ({ dateIso: todayIso(), time: nowHHMM(), teamName: findTeam()?.name, locale: lc }),
      locale: lc,
    })

    expandedBundle = { id: m.id, editor, atHandle, tplHandle }

    return el('div', { class: 'tt-milestone-followup-row', 'data-milestone-followup-id': m.id }, editor.root)
  }

  function removeMilestone(id: string): void {
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.milestones = tm.milestones.filter((m) => m.id !== id)
    })
  }

  function openDeleteConfirm(m: Milestone): void {
    const body = el('p', { class: 'tt-modal-message' }, t(lc, 'milestone_delete_confirm', { title: m.title }))
    let handle: ModalHandle
    const cancelBtn: ModalButton = { label: t(lc, 'cancel'), onClick: () => handle.close() }
    const confirmBtn: ModalButton = {
      label: t(lc, 'milestone_delete_btn'),
      primary: true,
      onClick: () => {
        removeMilestone(m.id)
        handle.close()
      },
    }
    handle = showModal({ title: t(lc, 'milestone_delete_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function requestDelete(m: Milestone): void {
    if (m.title.trim() === '') {
      removeMilestone(m.id) // empty titles carry no meaningful content to lose — delete silently
      return
    }
    openDeleteConfirm(m)
  }

  // --- timeline (SVG) -------------------------------------------------------

  const timelineEl = el('div', { class: 'tt-milestone-timeline' })

  function renderTimeline(): void {
    timelineEl.innerHTML = ''
    const sorted = sortByDate(milestones())
    if (sorted.length === 0) {
      timelineEl.style.display = 'none'
      return
    }
    timelineEl.style.display = ''

    const today = todayIso()
    // clientWidth is 0 until the element is laid out (e.g. jsdom, or before
    // first paint) — fall back to a fixed width so layout stays deterministic
    // rather than collapsing everything to x=0.
    const containerWidth = timelineEl.clientWidth > 0 ? timelineEl.clientWidth : FALLBACK_WIDTH
    const drawWidth = Math.max(containerWidth - H_PADDING * 2, 1)
    const layout = computeTimelineLayout(
      sorted.map((m) => ({ id: m.id, date: m.date })),
      MIN_GAP,
      drawWidth,
      today
    )
    const svgWidth = layout.innerWidth + H_PADDING * 2

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', String(svgWidth))
    svg.setAttribute('height', String(TIMELINE_HEIGHT))
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${TIMELINE_HEIGHT}`)
    svg.setAttribute('class', 'tt-milestone-svg')

    const midY = TIMELINE_HEIGHT / 2

    const axis = document.createElementNS(SVG_NS, 'line')
    axis.setAttribute('x1', String(H_PADDING))
    axis.setAttribute('x2', String(svgWidth - H_PADDING))
    axis.setAttribute('y1', String(midY))
    axis.setAttribute('y2', String(midY))
    axis.setAttribute('class', 'tt-milestone-axis')
    svg.appendChild(axis)

    if (layout.todayX !== null) {
      const tx = H_PADDING + layout.todayX
      const todayLine = document.createElementNS(SVG_NS, 'line')
      todayLine.setAttribute('x1', String(tx))
      todayLine.setAttribute('x2', String(tx))
      todayLine.setAttribute('y1', '4')
      todayLine.setAttribute('y2', String(TIMELINE_HEIGHT - 4))
      todayLine.setAttribute('class', 'tt-milestone-today-line')
      svg.appendChild(todayLine)
    }

    for (const m of sorted) {
      const cx = H_PADDING + layout.x[m.id]!
      const overdue = m.date < today && !m.done

      // "Filled when done" reads as a solid dot once complete; the two
      // not-done states (--muted / --accent from the brief) are rendered as
      // that color's hollow outline instead, so overdue-vs-upcoming is
      // visible at a glance without needing the done fill to mean anything
      // extra.
      const circle = document.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', String(cx))
      circle.setAttribute('cy', String(midY))
      circle.setAttribute('r', String(CIRCLE_R))
      circle.setAttribute('class', `tt-milestone-dot ${m.done ? 'tt-milestone-dot-done' : overdue ? 'tt-milestone-dot-overdue' : 'tt-milestone-dot-future'}`)
      if (m.done) {
        circle.setAttribute('fill', 'var(--accent)')
        circle.setAttribute('stroke', 'var(--accent)')
      } else if (overdue) {
        circle.setAttribute('fill', 'none')
        circle.setAttribute('stroke', 'var(--muted)')
      } else {
        circle.setAttribute('fill', 'none')
        circle.setAttribute('stroke', 'var(--accent)')
      }

      const titleNode = document.createElementNS(SVG_NS, 'title')
      titleNode.textContent = m.title
      circle.appendChild(titleNode)
      svg.appendChild(circle)

      const dateText = document.createElementNS(SVG_NS, 'text')
      dateText.setAttribute('x', String(cx))
      dateText.setAttribute('y', String(midY - 16))
      dateText.setAttribute('class', 'tt-milestone-date-label')
      dateText.textContent = formatDate(m.date, lc)
      svg.appendChild(dateText)

      const label = document.createElementNS(SVG_NS, 'text')
      label.setAttribute('x', String(cx))
      label.setAttribute('y', String(midY + 24))
      label.setAttribute('class', 'tt-milestone-title-label')
      label.textContent = truncateTitle(m.title)
      svg.appendChild(label)
    }

    timelineEl.appendChild(svg)
  }

  // --- list -------------------------------------------------------------

  function renderRow(m: Milestone): HTMLElement {
    const dateInput = el('input', {
      type: 'date', class: 'tt-milestone-date-input tt-input', value: m.date,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        if (value === '') return // type=date: browsers don't normally allow clearing to '', guard anyway
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.milestones.find((mm) => mm.id === m.id)
          if (found) found.date = value
        })
      },
    })

    const titleInput = el('input', {
      type: 'text', class: 'tt-milestone-title-input tt-input', placeholder: t(lc, 'milestone_title_placeholder'), value: m.title,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.milestones.find((mm) => mm.id === m.id)
          if (found) found.title = value
        })
      },
    })

    const doneCheckbox = el('input', {
      type: 'checkbox', class: 'tt-milestone-done-checkbox', title: t(lc, 'milestone_done_title'), checked: m.done,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.milestones.find((mm) => mm.id === m.id)
          if (found) found.done = checked
        })
      },
    })

    const expandBtn = el(
      'button',
      { class: 'tt-btn tt-milestone-expand-btn', type: 'button', title: t(lc, 'milestone_followup_toggle_title'), onclick: () => toggleExpand(m.id) },
      '📝'
    )

    const deleteBtn = el(
      'button',
      { class: 'tt-btn tt-milestone-delete-btn', type: 'button', title: t(lc, 'milestone_delete_title'), onclick: () => requestDelete(m) },
      '🗑'
    )

    const row = el(
      'div',
      { class: 'tt-milestone-row', 'data-milestone-id': m.id },
      dateInput, titleInput, doneCheckbox, expandBtn, deleteBtn
    )
    if (m.done) row.classList.add('tt-milestone-done-row')
    return row
  }

  const listEl = el('div', { class: 'tt-milestone-list' })

  function renderList(): void {
    const sorted = sortByDate(milestones())
    listEl.innerHTML = ''
    if (sorted.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-milestone-empty' }, t(lc, 'milestone_empty')))
    } else {
      sorted.forEach((m) => {
        listEl.appendChild(renderRow(m))
        if (expandedId === m.id) listEl.appendChild(renderFollowupRow(m))
      })
    }
    if (focusMilestoneId) {
      listEl.querySelector<HTMLInputElement>(`[data-milestone-id="${focusMilestoneId}"] .tt-milestone-title-input`)?.focus()
      focusMilestoneId = null
    }
  }

  function renderAll(): void {
    disposeExpandedBundle() // any previously-expanded editor is torn down before the list (and possibly a fresh one) is rebuilt
    renderTimeline()
    renderList()
  }

  function addMilestone(): void {
    const newId = crypto.randomUUID()
    focusMilestoneId = newId
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      tm.milestones.push({ id: newId, date: todayIso(), title: '', done: false, followup: '' })
    })
  }

  const addBtn = el(
    'button',
    { class: 'tt-btn tt-milestone-add-btn', type: 'button', onclick: () => addMilestone() },
    t(lc, 'milestone_add_btn')
  )
  const toolbar = el('div', { class: 'tt-milestone-toolbar' }, addBtn)

  /**
   * True (and returns the focused element) for the caret-sensitive elements
   * this module owns: text/date inputs (mirrors src/modules/action-items.ts's
   * `focusedCaretInput` — the done checkbox has no caret and its own 'change'
   * handler needs the row to move immediately, so it is deliberately
   * excluded) and, since a follow-up editor can be live-edited for a while
   * before its debounced onChange commits, the expanded row's contenteditable
   * `.editor` itself (mirrors src/modules/risks.ts's focusedCaretElement).
   */
  function focusedCaretInput(): HTMLElement | null {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !container.contains(active)) return null
    if (active instanceof HTMLInputElement && (active.type === 'text' || active.type === 'date')) return active
    if (active.classList.contains('editor') && active.isContentEditable) return active
    return null
  }

  // Same rationale as action-items.ts's identically-shaped subscribe
  // callback: a full rebuild is the simplest correct way to keep the list's
  // date order and the timeline's positions in sync with the store, but it
  // would blow away an in-progress edit's caret if some *other* change fires
  // while a text/date input here is focused. Skip that one rebuild and defer
  // it to the field's next blur — nothing is lost, since blur is exactly when
  // this field's own edit (if any) commits and would have triggered a
  // rebuild anyway. (The SVG itself never holds focus, so it's always safe
  // to rebuild — renderAll rebuilds both together for simplicity.)
  const unsubscribe = ctx.store.subscribe(() => {
    const active = focusedCaretInput()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  container.appendChild(el('div', { class: 'tt-milestones' }, timelineEl, toolbar, listEl))
  renderAll()

  disposers.set(container, () => {
    unsubscribe()
    disposeExpandedBundle()
  })
}
