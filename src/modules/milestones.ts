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
import { unlinkRefsInTeam } from '../core/refs'
import type { ModuleCtx } from '../ui/panes'
import { scopeAffects, type Section } from '../core/scope'
import { confirmDelete } from '../ui/modal'
import { createRichEditorBundle } from '../ui/rich-editor'
import { ExpandableRowsController } from '../ui/expandable-followup'
import { SEARCH_FOCUS_ITEM_EVENT } from '../ui/search-highlight'
import { openItemContextMenu } from '../ui/card-context-menu'
import { createDatePicker } from '../ui/date-picker'
import { nowHHMM } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'
import { el, blurOnEnter } from '../ui/dom'
import { withDisposal } from './lifecycle'

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

export const renderMilestones = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'milestones') return // registered only for 'milestones'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }
  function milestones(): Milestone[] {
    return findTeam()?.milestones ?? []
  }

  let focusMilestoneId: string | null = null
  // Every currently-expanded row's follow-up editor is mounted at once —
  // not just one — so expand-all/collapse-all can show every follow-up
  // simultaneously.
  const expandable = new ExpandableRowsController()

  function toggleExpand(id: string): void {
    expandable.toggle(id)
    renderAll()
  }

  /** Expands (or collapses) every milestone's follow-up editor at once, driving the toolbar's expand-all/collapse-all button. */
  function setAllExpanded(expand: boolean): void {
    expandable.setAll(milestones().map((m) => m.id), expand)
    renderAll()
  }

  /** Full rich editor for a milestone's follow-up, via src/ui/rich-editor.ts's createRichEditorBundle (editor + @ref autocomplete + '/' template picker), scoped to 'any' templates. Registers itself with `expandable` so the caller can dispose it later. */
  function renderFollowupRow(m: Milestone): HTMLElement {
    const bundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: m.followup,
      onChange: (md) => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const found = tm?.milestones.find((mm) => mm.id === m.id)
          if (!found) return
          found.followup = md.trim() === '' ? '' : md
        }, { teamId, sections: ['milestones'] })
      },
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    expandable.register(m.id, bundle)
    return el('div', { class: 'tt-milestone-followup-row', 'data-milestone-followup-id': m.id, 'data-item-id': m.id }, bundle.editor.root)
  }

  function removeMilestone(id: string): void {
    expandable.collapse(id) // local UI state; must flip before store.update fires the synchronous subscriber below
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      unlinkRefsInTeam(tm, 'milestone', [id])
      tm.milestones = tm.milestones.filter((m) => m.id !== id)
      // No `sections`: unlinkRefsInTeam rewrites @mentions across every
      // content-bearing section of this team (notes, people, actions, risks
      // — see refs.ts), not just 'milestones'. Team-only scoping is the
      // narrowest scope that's still correct and won't rot if
      // unlinkRefsInTeam's reach changes later.
    }, { teamId })
  }

  function requestDelete(m: Milestone): void {
    if (m.title.trim() === '') {
      removeMilestone(m.id) // empty titles carry no meaningful content to lose — delete silently
      return
    }
    confirmDelete(lc, {
      title: t(lc, 'milestone_delete_title'),
      message: t(lc, 'milestone_delete_confirm', { title: m.title }),
      confirmLabel: t(lc, 'milestone_delete_btn'),
      onConfirm: () => removeMilestone(m.id),
    })
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

  function openRowContextMenu(itemId: string, x: number, y: number): void {
    openItemContextMenu(ctx, 'milestone', teamId, itemId, x, y)
  }

  function renderRow(m: Milestone): HTMLElement {
    // No allowClear: a milestone always has a date, same constraint the old
    // native <input type=date> relied on browsers to (mostly) enforce.
    const datePicker = createDatePicker({
      value: m.date, locale: lc,
      onChange: (iso) => {
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.milestones.find((mm) => mm.id === m.id)
          if (found) found.date = iso
        }, { teamId, sections: ['milestones'] })
      },
    })
    datePicker.root.classList.add('tt-milestone-date-input')

    const titleInput = el('input', {
      type: 'text', class: 'tt-milestone-title-input tt-input', placeholder: t(lc, 'milestone_title_placeholder'), value: m.title,
      onkeydown: blurOnEnter,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.milestones.find((mm) => mm.id === m.id)
          if (found) found.title = value
          // Unscoped beyond the team: `title` is the label @[…](milestone:id)
          // mentions resolve through live — see the note at people-tree.ts's
          // rename site.
        }, { teamId })
      },
    })

    const doneCheckbox = el('input', {
      type: 'checkbox', class: 'tt-milestone-done-checkbox', title: t(lc, 'milestone_done_title'), checked: m.done,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.milestones.find((mm) => mm.id === m.id)
          if (found) found.done = checked
        }, { teamId, sections: ['milestones'] })
      },
    })

    // tabindex="-1": Tab should move cleanly between the row's data fields
    // (date/title/done) like a spreadsheet, not stop on every hover-revealed
    // icon button in between — still reachable by click/hover.
    const expandBtn = el(
      'button',
      { class: 'tt-btn tt-milestone-expand-btn', type: 'button', tabindex: '-1', title: t(lc, 'milestone_followup_toggle_title'), onclick: () => toggleExpand(m.id) },
      expandable.isExpanded(m.id) ? '▾' : '▸'
    )

    const deleteBtn = el(
      'button',
      { class: 'tt-btn tt-milestone-delete-btn', type: 'button', tabindex: '-1', title: t(lc, 'milestone_delete_title'), onclick: () => requestDelete(m) },
      '🗑'
    )

    const row = el(
      'div',
      {
        class: 'tt-milestone-row',
        'data-milestone-id': m.id,
        'data-item-id': m.id,
        title: t(lc, 'milestone_row_context_hint'),
      },
      datePicker.root, titleInput, doneCheckbox, expandBtn, deleteBtn
    )
    if (m.done) row.classList.add('tt-milestone-done-row')
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openRowContextMenu(m.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })
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
        if (expandable.isExpanded(m.id)) listEl.appendChild(renderFollowupRow(m))
      })
    }
    if (focusMilestoneId) {
      listEl.querySelector<HTMLInputElement>(`[data-milestone-id="${focusMilestoneId}"] .tt-milestone-title-input`)?.focus()
      focusMilestoneId = null
    }
    updateExpandAllBtn(sorted)
  }

  function renderAll(): void {
    expandable.disposeAll() // every previously-expanded editor is torn down before the list (and possibly fresh ones) is rebuilt
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
    }, { teamId, sections: ['milestones'] })
  }

  const addBtn = el(
    'button',
    { class: 'tt-btn tt-milestone-add-btn', type: 'button', onclick: () => addMilestone() },
    t(lc, 'milestone_add_btn')
  )
  const expandAllBtn = el(
    'button',
    { class: 'tt-btn tt-milestone-expand-all-btn', type: 'button', onclick: () => setAllExpanded(!expandable.isAllExpanded(milestones().map((m) => m.id))) },
    ''
  )

  /** Label reads "Expand all" unless every milestone is already expanded, in which case it flips to "Collapse all" — mirrors milestone_expand_all_btn/milestone_collapse_all_btn i18n keys. */
  function updateExpandAllBtn(sorted: Milestone[]): void {
    expandAllBtn.textContent = t(lc, expandable.isAllExpanded(sorted.map((m) => m.id)) ? 'milestone_collapse_all_btn' : 'milestone_expand_all_btn')
  }

  const toolbar = el('div', { class: 'tt-milestone-toolbar' }, addBtn, expandAllBtn)

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
  const WATCHED: readonly Section[] = ['milestones', 'teams']
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    const active = focusedCaretInput()
    if (active) {
      active.addEventListener('blur', () => renderAll(), { once: true })
      return
    }
    renderAll()
  })

  /** Expands the milestone a search result pointed at, if it's currently collapsed, so its follow-up text (what the search actually matched) becomes visible. No-op if the id isn't one of this team's milestones or is already expanded. Safe even if a stale listener from a prior mount somehow survives — the id-membership check above makes it a no-op regardless. */
  function onSearchFocusItem(e: Event): void {
    const itemId = (e as CustomEvent<string>).detail
    if (!milestones().some((m) => m.id === itemId)) return
    if (expandable.isExpanded(itemId)) return
    expandable.expand(itemId)
    renderAll()
  }
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)

  container.appendChild(el('div', { class: 'tt-milestones' }, timelineEl, toolbar, listEl))
  renderAll()

  return () => {
    unsubscribe()
    expandable.disposeAll()
    container.removeEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)
  }
})
