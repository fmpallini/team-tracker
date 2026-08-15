// src/modules/risks.ts — Task 22: risks module. A flat, orderable list of
// Risk per team (structurally close to src/modules/action-items.ts: same
// disposer WeakMap, loc.teamId-keyed store.update helpers, flat before/after
// drag reorder), plus two things neither action-items nor milestones need:
// a *computed, never-persisted* exposure column (chance*impact, colored by
// range) and a per-row expandable follow-up editor that mirrors
// src/modules/person-notes.ts's full editor + @ref + template-picker wiring.
// Any number of follow-up editors can be expanded at once (tracked in the
// shared `expandable` ExpandableRowsController, src/ui/expandable-followup.ts),
// which is what backs the toolbar's expand-all/collapse-all button. A 3x3
// chance/impact quadrant SVG sits above the list (computeQuadrantLayout +
// renderQuadrant below), mirroring milestones.ts's timeline: always rebuilt
// in full alongside the list, since nothing inside an SVG can hold DOM focus.
import type { Risk, RiskPlan, Loc, Team } from '../core/types'
import { t, todayIso, type MsgKey } from '../core/i18n'
import { unlinkRefsInTeam } from '../core/refs'
import { installArrowFallbackFocus, type ModuleCtx } from '../ui/panes'
import { scopeAffects, type Section } from '../core/scope'
import { confirmDelete } from '../ui/modal'
import { createRichEditorBundle } from '../ui/rich-editor'
import { ExpandableRowsController } from '../ui/expandable-followup'
import { SEARCH_FOCUS_ITEM_EVENT } from '../ui/search-highlight'
import { openItemContextMenu } from '../ui/card-context-menu'
import { computeFlatDropPosition } from './action-items'
import { nowHHMM } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'
import { el, blurOnEnter, createDeferredRebuild } from '../ui/dom'
import { withDisposal } from './lifecycle'
import { BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'

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

// The stamp's color used to be three literal hex values (#16a34a/#ca8a04/
// #dc2626) assigned through `exposureBadge.style.color`. That made the app's
// signature mark the only thing on screen ignoring the palette picker — and,
// being an inline style, the one thing no palette block could have overridden
// anyway. The `.tt-risk-exposure-{level}` class the badge already carries now
// drives the color from `--exposure-{level}` in styles.css, so the stamp
// follows the theme like everything else.

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
 * 0..n-1 sequence — mirrors src/modules/action-items.ts's `moveCard`,
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

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Pixel size of one (chance, impact) cell in the quadrant grid at its floor — today's fixed size, kept as the minimum a render can shrink to (see computeCellSize, below). */
const QUADRANT_CELL_MIN = 60
/** Ceiling a render can grow a cell to, how ever much free pane space is available. */
const QUADRANT_CELL_MAX = 110
const QUADRANT_DOT_R = 3.5
const QUADRANT_DOT_R_MIN = 2
/** Dot's x offset from its cell's left edge — every dot in a cell shares this x, so their title labels (always drawn immediately to the dot's right) line up in a column instead of needing per-dot horizontal placement. */
const QUADRANT_DOT_INSET = 10
/** Below this per-row vertical slot, a cell's stacked dots sit too close together for an adjacent label to stay legible without overlapping its neighbors — the label is skipped for that dot (its <title> tooltip still carries the full text). */
const QUADRANT_LABEL_MIN_GAP = 11
/** Room reserved for the impact tick numbers + rotated axis title on the left. */
const QUADRANT_PAD_LEFT = 34
const QUADRANT_PAD_TOP = 6
/** Room reserved on the right for title labels spilling past the last (chance=3) column. */
const QUADRANT_PAD_RIGHT = 64
/** Room reserved for the chance tick numbers + axis title below the grid. */
const QUADRANT_PAD_BOTTOM = 30

export interface QuadrantDot {
  id: string
  /** Center position in a [0, cellSize*3] x [0, cellSize*3] space — callers add their own grid-origin offset, same convention as computeTimelineLayout's (milestones.ts) innerWidth-relative x. */
  cx: number
  cy: number
  r: number
  /** Whether there's enough vertical room in this dot's cell to draw a title label beside it without overlapping a neighbor — see QUADRANT_LABEL_MIN_GAP. */
  showLabel: boolean
}

/**
 * Places every risk's dot in its (chance, impact) cell of a 3x3 grid —
 * impact increases upward (row 0 = impact 3), chance increases rightward
 * (col 0 = chance 1), the conventional risk-matrix reading. `cellSize`
 * (defaults to QUADRANT_CELL_MIN) scales every dimension uniformly, so
 * callers rendering a grown chart (see computeCellSize) pass their computed
 * size straight through instead of this always assuming the floor. Risks
 * sharing a cell get one of two layouts:
 *
 * - Few enough that a title label fits beside each one (see
 *   QUADRANT_LABEL_MIN_GAP): stacked in a single column sharing one x, so
 *   every label lines up and none of them overlap their neighbor above/below.
 * - Too many for that: labels would collide regardless, so they're dropped
 *   (the dot's <title> tooltip still carries the full text) and the dots
 *   themselves switch to a 2D sub-grid spread across the *whole* cell instead
 *   of staying pinned to the labeled layout's left column — a crowded cell
 *   reads as a cluster, not a cramped, mostly-empty stack.
 */
export function computeQuadrantLayout(
  risks: { id: string; chance: 1 | 2 | 3; impact: 1 | 2 | 3 }[],
  cellSize: number = QUADRANT_CELL_MIN
): QuadrantDot[] {
  const ratio = cellSize / QUADRANT_CELL_MIN
  const dotR = QUADRANT_DOT_R * ratio
  const dotRMin = QUADRANT_DOT_R_MIN * ratio
  const dotInset = QUADRANT_DOT_INSET * ratio
  const labelMinGap = QUADRANT_LABEL_MIN_GAP * ratio

  const groups = new Map<string, typeof risks>()
  for (const r of risks) {
    const key = `${r.chance}:${r.impact}`
    const group = groups.get(key)
    if (group) group.push(r)
    else groups.set(key, [r])
  }

  const dots: QuadrantDot[] = []
  for (const group of groups.values()) {
    const { chance, impact } = group[0]!
    const cellLeft = (chance - 1) * cellSize
    const cellTop = (3 - impact) * cellSize
    const n = group.length
    const singleColStepY = cellSize / (n + 1)

    if (n === 1 || singleColStepY >= labelMinGap) {
      const r = n === 1 ? dotR : Math.max(dotRMin, Math.min(dotR, singleColStepY / 2 - 1))
      group.forEach((risk, i) => {
        dots.push({ id: risk.id, cx: cellLeft + dotInset, cy: cellTop + singleColStepY * (i + 1), r, showLabel: true })
      })
    } else {
      const cols = Math.ceil(Math.sqrt(n))
      const rows = Math.ceil(n / cols)
      const r = Math.max(dotRMin, Math.min(dotR, cellSize / (2 * Math.max(cols, rows))))
      const stepX = cellSize / (cols + 1)
      const stepY = cellSize / (rows + 1)
      group.forEach((risk, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        dots.push({ id: risk.id, cx: cellLeft + stepX * (col + 1), cy: cellTop + stepY * (row + 1), r, showLabel: false })
      })
    }
  }
  return dots
}

/** Baseline character cap at QUADRANT_CELL_MIN, tuned to fit inside the remaining width of a *minimum-sized* cell (cell minus the dot's inset and radius) without spilling into the next cell over. */
const QUADRANT_LABEL_MAX_CHARS = 7

/** Truncation for a title drawn beside a quadrant dot, scaled to `cellSize` by the same ratio computeQuadrantLayout scales its own geometry by — a grown chart (see computeCellSize) has proportionally more room per cell, so it earns proportionally more of the title, while staying fit to its own cell at any size. The dot's <title> tooltip always carries the untruncated text. */
function truncateForQuadrant(title: string, cellSize: number): string {
  const maxChars = Math.max(QUADRANT_LABEL_MAX_CHARS, Math.round(QUADRANT_LABEL_MAX_CHARS * (cellSize / QUADRANT_CELL_MIN)))
  return title.length > maxChars ? `${title.slice(0, maxChars)}…` : title
}

const LEVEL_OPTIONS = [1, 2, 3] as const
const LEVEL_KEYS: Record<1 | 2 | 3, MsgKey> = {
  1: 'risk_level_1',
  2: 'risk_level_2',
  3: 'risk_level_3',
}

const PLAN_OPTIONS: RiskPlan[] = ['mitigate', 'transfer', 'eliminate', 'accept']
const PLAN_KEYS: Record<RiskPlan, MsgKey> = {
  mitigate: 'risk_plan_mitigate',
  transfer: 'risk_plan_transfer',
  eliminate: 'risk_plan_eliminate',
  accept: 'risk_plan_accept',
}

// --- renderer ---------------------------------------------------------------

export const renderRisks = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'risks') return // registered only for 'risks'; defensive
  const teamId = loc.teamId
  const lc = ctx.locale

  function findTeam(): Team | undefined {
    return docFindTeam(ctx.store.doc, teamId)
  }
  function risks(): Risk[] {
    return findTeam()?.risks ?? []
  }

  let draggedId: string | null = null
  let sortMode: ExposureSort = 'none'
  // Every currently-expanded row's follow-up editor is mounted at once —
  // not just one — so expand-all/collapse-all can show every follow-up
  // simultaneously.
  const expandable = new ExpandableRowsController()
  let focusRiskId: string | null = null

  function clearDropClasses(): void {
    listEl.querySelectorAll('.tt-risk-row').forEach((n) => {
      n.classList.remove('tt-risk-drop-before', 'tt-risk-drop-after')
    })
  }

  function removeRisk(id: string): void {
    expandable.collapse(id) // local UI state; must flip before store.update fires the synchronous subscriber below
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      const removed = tm.risks.find((r) => r.id === id)
      unlinkRefsInTeam(tm, 'risk', removed ? new Map([[id, removed.title]]) : new Map())
      tm.risks = tm.risks.filter((r) => r.id !== id)
      // No `sections`: unlinkRefsInTeam rewrites @mentions across every
      // content-bearing section of this team (notes, people, actions,
      // milestones — see refs.ts), not just 'risks'. Team-only scoping is
      // the narrowest scope that's still correct and won't rot if
      // unlinkRefsInTeam's reach changes later.
    }, { teamId })
  }

  function setClosed(id: string, closed: boolean): void {
    if (closed) expandable.collapse(id) // a closed row never renders a follow-up editor, so drop it before the subscriber rebuilds
    ctx.store.update((d) => {
      const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === id)
      if (found) found.closed = closed
    }, { teamId, sections: ['risks'] })
  }

  function requestDelete(r: Risk): void {
    if (r.title.trim() === '') {
      removeRisk(r.id) // empty titles carry no meaningful content to lose — delete silently
      return
    }
    confirmDelete(lc, {
      title: t(lc, 'risk_delete_title'),
      message: t(lc, 'risk_delete_confirm', { title: r.title }),
      confirmLabel: t(lc, 'risk_delete_btn'),
      onConfirm: () => removeRisk(r.id),
    })
  }

  // Keyboard-driven (Enter on a focused row) needs to land focus somewhere
  // sane after renderAll() replaces the row DOM — on the follow-up editor
  // when expanding (so typing can start immediately), or back on the row
  // itself when collapsing (so ArrowUp/Down can continue). renderAll() runs
  // synchronously here, so the DOM is already rebuilt by the time we query it.
  function toggleExpand(id: string): void {
    const wasExpanded = expandable.isExpanded(id)
    expandable.toggle(id)
    renderAll()
    if (wasExpanded) listEl.querySelector<HTMLElement>(`[data-risk-id="${id}"].tt-risk-row`)?.focus()
    else listEl.querySelector<HTMLElement>(`[data-risk-followup-id="${id}"] .editor`)?.focus()
  }

  /** Expands (or collapses) every currently-open (non-closed) risk's follow-up editor at once, driving the toolbar's expand-all/collapse-all button. */
  function setAllExpanded(expand: boolean): void {
    expandable.setAll(risks().filter((r) => !r.closed).map((r) => r.id), expand)
    renderAll()
  }

  function buildSelect(className: string, columnKey: MsgKey, options: { value: string; label: string }[], selected: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el('select', {
      class: className,
      // These selects had no accessible name at all — the column header was
      // the only thing identifying them, and on a narrow row that header is
      // hidden entirely (see the container query in styles.css). The name
      // travels with the control instead.
      'aria-label': t(lc, columnKey),
      title: t(lc, columnKey),
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
    })
    for (const opt of options) {
      select.appendChild(el('option', { value: opt.value }, opt.label))
    }
    select.value = selected
    return select
  }

  /** Builds the full rich editor for a risk's follow-up, via src/ui/rich-editor.ts's createRichEditorBundle (editor + @ref autocomplete + '/' template picker), scoped to 'any' templates since a follow-up isn't tied to a person or a day. Registers itself with `expandable` so the caller can dispose it later. */
  function renderFollowupRow(r: Risk): HTMLElement {
    const bundle = createRichEditorBundle({
      store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
      initialMd: r.followup,
      onChange: (md) => {
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          const found = tm?.risks.find((rr) => rr.id === r.id)
          if (!found) return
          found.followup = md.trim() === '' ? '' : md
        }, { teamId, sections: ['risks'] })
      },
      getTeam: () => findTeam(),
      getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'any'),
      getTemplateCtx: () => ({ dateIso: todayIso(), time: nowHHMM(lc), teamName: findTeam()?.name, locale: lc }),
    })
    expandable.register(r.id, bundle)
    return el('div', { class: 'tt-risk-followup-row', 'data-risk-followup-id': r.id, 'data-item-id': r.id }, bundle.editor.root)
  }

  function openRowContextMenu(itemId: string, x: number, y: number): void {
    const r = risks().find((rr) => rr.id === itemId)
    if (!r) return
    openItemContextMenu(ctx, 'risk', teamId, itemId, x, y, () => requestDelete(r))
  }

  // --- quadrant (SVG) ---------------------------------------------------

  const quadrantEl = el('div', { class: 'tt-risk-quadrant' })

  /** Jumps to a risk from its quadrant dot: expands its follow-up first if it's currently collapsed (so the click has an unmistakable visible effect even when the row was already on-screen and needed no scrolling — a bare `.focus()` after a mouse click is easy to miss, since most browsers' :focus-visible heuristics suppress the ring for pointer-driven focus), then scrolls to and focuses the row. */
  function focusRiskFromQuadrant(id: string): void {
    if (!expandable.isExpanded(id)) {
      expandable.expand(id)
      renderAll()
    }
    const row = listEl.querySelector<HTMLElement>(`[data-risk-id="${id}"].tt-risk-row`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.focus()
  }

  /**
   * How large to draw each quadrant cell this render. QUADRANT_CELL_MIN is
   * the floor (today's fixed size); QUADRANT_CELL_MAX a sane ceiling. Grows
   * past the floor only when the pane genuinely has unused room to spare:
   *
   * - Horizontally, from the quadrant's own rendered width — mirrors
   *   milestones.ts's timelineEl.clientWidth pattern.
   * - Vertically, from risksWrap's viewport height (`.tt-risks` is
   *   `height: 100%`, so this doesn't shrink/grow with content) minus what
   *   the toolbar/header/list/closed-section currently need.
   *
   * Both measurements are taken independently of the quadrant's own current
   * size (listEl/closedEl are already rebuilt for this render by the time
   * this runs — see renderAll), so this is a single pass: no measure-resize-
   * remeasure loop. In jsdom (tests), every measurement reads 0 and the
   * floor is returned — the same fallback milestones.ts's FALLBACK_WIDTH
   * uses for the identical reason.
   */
  function computeCellSize(): number {
    const availWidth = quadrantEl.clientWidth
    const widthCell = availWidth > 0 ? (availWidth - QUADRANT_PAD_LEFT - QUADRANT_PAD_RIGHT) / 3 : QUADRANT_CELL_MIN

    let heightCell = QUADRANT_CELL_MIN
    const totalAvail = risksWrap.clientHeight
    if (totalAvail > 0) {
      const wrapStyle = getComputedStyle(risksWrap)
      const paddingV = (parseFloat(wrapStyle.paddingTop) || 0) + (parseFloat(wrapStyle.paddingBottom) || 0)
      const gapPx = parseFloat(wrapStyle.rowGap) || 0
      const others = toolbar.offsetHeight + headerRow.offsetHeight + listEl.offsetHeight + closedEl.offsetHeight
      const freeForQuadrant = totalAvail - paddingV - gapPx * 4 - others
      heightCell = (freeForQuadrant - QUADRANT_PAD_TOP - QUADRANT_PAD_BOTTOM) / 3
    }

    return Math.max(QUADRANT_CELL_MIN, Math.min(QUADRANT_CELL_MAX, Math.floor(Math.min(widthCell, heightCell))))
  }

  /** Renders the 3x3 chance/impact quadrant: a per-cell exposure-tinted background (reusing exposureLevel's own low/medium/high bucketing) plus one dot per open risk, packed via computeQuadrantLayout. Closed risks are excluded — mirrors the list below, where they live in their own collapsed section. */
  function renderQuadrant(): void {
    quadrantEl.innerHTML = ''
    const open = risks().filter((r) => !r.closed)
    if (open.length === 0) {
      quadrantEl.style.display = 'none'
      return
    }
    quadrantEl.style.display = ''

    const cell = computeCellSize()
    const grid = cell * 3
    const gx0 = QUADRANT_PAD_LEFT
    const gy0 = QUADRANT_PAD_TOP
    const svgWidth = gx0 + grid + QUADRANT_PAD_RIGHT
    const svgHeight = gy0 + grid + QUADRANT_PAD_BOTTOM

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', String(svgWidth))
    svg.setAttribute('height', String(svgHeight))
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`)
    svg.setAttribute('class', 'tt-risk-quadrant-svg')

    for (let chance = 1; chance <= 3; chance++) {
      for (let impact = 1; impact <= 3; impact++) {
        const level = exposureLevel(computeExposure(chance, impact))
        const rect = document.createElementNS(SVG_NS, 'rect')
        rect.setAttribute('x', String(gx0 + (chance - 1) * cell))
        rect.setAttribute('y', String(gy0 + (3 - impact) * cell))
        rect.setAttribute('width', String(cell))
        rect.setAttribute('height', String(cell))
        rect.setAttribute('class', `tt-risk-quadrant-cell tt-risk-quadrant-cell-${level}`)
        svg.appendChild(rect)
      }
    }

    for (let chance = 1; chance <= 3; chance++) {
      const tick = document.createElementNS(SVG_NS, 'text')
      tick.setAttribute('x', String(gx0 + (chance - 0.5) * cell))
      tick.setAttribute('y', String(gy0 + grid + 14))
      tick.setAttribute('class', 'tt-risk-quadrant-tick')
      tick.textContent = String(chance)
      svg.appendChild(tick)
    }
    for (let impact = 1; impact <= 3; impact++) {
      const tick = document.createElementNS(SVG_NS, 'text')
      tick.setAttribute('x', String(gx0 - 8))
      tick.setAttribute('y', String(gy0 + (3 - impact + 0.5) * cell))
      tick.setAttribute('class', 'tt-risk-quadrant-tick tt-risk-quadrant-tick-y')
      tick.textContent = String(impact)
      svg.appendChild(tick)
    }

    const xTitle = document.createElementNS(SVG_NS, 'text')
    xTitle.setAttribute('x', String(gx0 + grid / 2))
    xTitle.setAttribute('y', String(svgHeight - 2))
    xTitle.setAttribute('class', 'tt-risk-quadrant-axis-title')
    xTitle.textContent = t(lc, 'risk_col_chance')
    svg.appendChild(xTitle)

    const yTitle = document.createElementNS(SVG_NS, 'text')
    yTitle.setAttribute('x', '10')
    yTitle.setAttribute('y', String(gy0 + grid / 2))
    yTitle.setAttribute('class', 'tt-risk-quadrant-axis-title')
    yTitle.setAttribute('transform', `rotate(-90 10 ${gy0 + grid / 2})`)
    yTitle.textContent = t(lc, 'risk_col_impact')
    svg.appendChild(yTitle)

    const byId = new Map(open.map((r) => [r.id, r]))
    const dots = computeQuadrantLayout(open.map((r) => ({ id: r.id, chance: r.chance, impact: r.impact })), cell)
    for (const dot of dots) {
      const risk = byId.get(dot.id)!
      const cx = gx0 + dot.cx
      const cy = gy0 + dot.cy

      const circle = document.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', String(cx))
      circle.setAttribute('cy', String(cy))
      circle.setAttribute('r', String(dot.r))
      // Flat color, not exposure-level-tinted: the cell background already
      // carries that signal, and coloring the dot too was redundant with it.
      circle.setAttribute('class', 'tt-risk-quadrant-dot')
      // Not `data-risk-id`: that attribute already identifies the row below,
      // and several existing tests/selectors do `[data-risk-id="…"]` scoped
      // to the whole container expecting exactly one match.
      circle.setAttribute('data-quadrant-risk-id', dot.id)
      circle.addEventListener('click', () => focusRiskFromQuadrant(dot.id))
      const titleNode = document.createElementNS(SVG_NS, 'title')
      titleNode.textContent = risk.title
      circle.appendChild(titleNode)
      svg.appendChild(circle)

      if (dot.showLabel) {
        const label = document.createElementNS(SVG_NS, 'text')
        label.setAttribute('x', String(cx + dot.r + 3))
        label.setAttribute('y', String(cy))
        label.setAttribute('class', 'tt-risk-quadrant-label')
        label.textContent = truncateForQuadrant(risk.title, cell)
        svg.appendChild(label)
      }
    }

    quadrantEl.appendChild(svg)
  }

  function renderRow(r: Risk): HTMLElement {
    const exposure = computeExposure(r.chance, r.impact)

    const titleInput = el('input', {
      type: 'text', class: 'tt-risk-title-input tt-input', placeholder: t(lc, 'risk_title_placeholder'), value: r.title,
      onkeydown: blurOnEnter,
      onchange: (e: Event) => {
        const value = (e.target as HTMLInputElement).value
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
          if (found) found.title = value
          // Unscoped beyond the team: `title` is the label @[…](risk:id)
          // mentions resolve through live — see the note at people-tree.ts's
          // rename site.
        }, { teamId })
      },
    })

    // Labelled, not bare 1/2/3: the stored value is still the number, but
    // nothing on screen said whether 3 meant high chance or high confidence.
    // The dropdown is the one place with room for the word, so it carries it.
    const numberOptions = LEVEL_OPTIONS.map((n) => ({ value: String(n), label: t(lc, LEVEL_KEYS[n]) }))
    const chanceSelect = buildSelect('tt-risk-chance-select', 'risk_col_chance', numberOptions, String(r.chance), (value) => {
      ctx.store.update((d) => {
        const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
        if (found) found.chance = Number(value) as 1 | 2 | 3
      }, { teamId, sections: ['risks'] })
    })

    const impactSelect = buildSelect('tt-risk-impact-select', 'risk_col_impact', numberOptions, String(r.impact), (value) => {
      ctx.store.update((d) => {
        const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
        if (found) found.impact = Number(value) as 1 | 2 | 3
      }, { teamId, sections: ['risks'] })
    })

    const exposureBadge = el(
      'span',
      { class: `tt-risk-exposure-badge tt-risk-exposure-${exposureLevel(exposure)}` },
      String(exposure)
    )
    // The badge's own width stays intrinsic (small circle) — this wrapping
    // cell is what carries the 4.5rem column width shared with the header,
    // so the stamp can be a true circle without losing header alignment.
    const exposureCell = el('span', { class: 'tt-risk-exposure-cell' }, exposureBadge)

    const planSelect = buildSelect(
      'tt-risk-plan-select',
      'risk_col_plan',
      PLAN_OPTIONS.map((p) => ({ value: p, label: t(lc, PLAN_KEYS[p]) })),
      r.plan,
      (value) => {
        ctx.store.update((d) => {
          const found = d.teams.find((t2) => t2.id === teamId)?.risks.find((rr) => rr.id === r.id)
          if (found) found.plan = value as RiskPlan
        }, { teamId, sections: ['risks'] })
      }
    )

    // tabindex="-1": Tab should move cleanly between the row's data fields
    // (title/chance/impact/plan) like a spreadsheet, not stop on every icon
    // button in between. That decision stands — but combined with the old
    // `opacity: 0` resting state it left *no* route to these actions without
    // a pointer. The buttons now rest visible-but-quiet (styles.css), and the
    // row itself is a single Tab stop that opens the same context menu on
    // Enter/Space, so every action has a keyboard path.
    const backlinks = ctx.searchIndex.backlinks(teamId, 'risk', r.id)
    // A fixed-width slot even when there's no chip: `createBacklinksChip`
    // returns null for zero backlinks and `el()` skips null children
    // entirely, which would collapse this column on chip-less rows and
    // misalign chance/impact/exposure/plan against rows that do have one.
    const backlinksChip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
      ?? el('span', { class: 'tt-backlinks-chip-slot' })

    const expanded = expandable.isExpanded(r.id)
    const expandBtn = el(
      'button',
      { class: 'tt-btn tt-risk-expand-btn', type: 'button', tabindex: '-1', title: t(lc, 'risk_followup_toggle_title'), onclick: () => toggleExpand(r.id) },
      expanded ? '▾' : '▸'
    )

    const closeBtn = el(
      'button',
      { class: 'tt-btn tt-risk-close-btn', type: 'button', tabindex: '-1', title: t(lc, 'risk_close_title'), onclick: () => setClosed(r.id, true) },
      '✔️'
    )

    const deleteBtn = el(
      'button',
      { class: 'tt-btn tt-risk-delete-btn', type: 'button', tabindex: '-1', title: t(lc, 'risk_delete_title'), onclick: () => requestDelete(r) },
      '🗑'
    )

    // Narrow-row scaffolding, inert until the container query in styles.css
    // turns it on (see `.tt-risks` container-type). `lineBreak` is a
    // zero-height 100%-basis flex item — the standard way to force a wrap at
    // a chosen point — and the three mini-labels stand in for the column
    // header, which the same query hides. All four are display:none at full
    // width, so the wide row is byte-for-byte the layout it always was.
    const metaLabel = (which: 'chance' | 'impact' | 'plan', key: MsgKey): HTMLElement =>
      el('span', { class: `tt-risk-meta-label tt-risk-meta-${which}`, 'aria-hidden': 'true' }, t(lc, key))
    const lineBreak = el('span', { class: 'tt-risk-linebreak', 'aria-hidden': 'true' })

    const row = el(
      'div',
      {
        class: 'tt-risk-row',
        draggable: sortMode === 'none' ? 'true' : 'false',
        tabindex: '0',
        'data-risk-id': r.id,
        'data-item-id': r.id,
        title: `${t(lc, 'risk_row_context_hint')} · ${t(lc, 'risk_row_menu_hint')}`,
      },
      titleInput,
      metaLabel('chance', 'risk_col_chance'), chanceSelect,
      metaLabel('impact', 'risk_col_impact'), impactSelect,
      exposureCell,
      metaLabel('plan', 'risk_col_plan'), planSelect,
      lineBreak,
      backlinksChip, expandBtn, closeBtn, deleteBtn
    )
    if (expanded) row.classList.add('tt-risk-row-expanded')

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openRowContextMenu(r.id, (e as MouseEvent).clientX, (e as MouseEvent).clientY)
    })

    // Guarded on `e.target === row` throughout so Enter inside the title
    // input still means "commit and blur" (blurOnEnter), Space inside a
    // select still opens the dropdown, and arrows inside a select still
    // change its value — only a keypress on the row itself counts.
    row.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent
      if (ev.target !== row) return
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        const rows = Array.from(listEl.querySelectorAll<HTMLElement>('.tt-risk-row'))
        const next = rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]
        if (!next) return
        ev.preventDefault()
        next.focus()
        return
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        toggleExpand(r.id)
        return
      }
      if (ev.key !== ' ') return
      // Keyboard equivalent of the right-click menu.
      ev.preventDefault()
      const rect = row.getBoundingClientRect()
      openRowContextMenu(r.id, rect.left + 16, rect.bottom)
    })

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
        }, { teamId, sections: ['risks'] })
      })
      row.addEventListener('dragend', () => {
        draggedId = null
        clearDropClasses()
      })
    }

    return row
  }

  /** Condensed row for the collapsible closed-risks section: title, computed exposure and a reopen button — the full editable controls (chance/impact/plan/follow-up) aren't relevant once a risk is closed. */
  function renderClosedRow(r: Risk): HTMLElement {
    const exposure = computeExposure(r.chance, r.impact)
    const reopenBtn = el(
      'button',
      { class: 'tt-btn tt-risk-reopen-btn', type: 'button', title: t(lc, 'risk_reopen_title'), onclick: () => setClosed(r.id, false) },
      '♻️'
    )
    return el(
      'div',
      { class: 'tt-risk-row tt-risk-row-closed', 'data-risk-id': r.id },
      el('span', { class: 'tt-risk-title-text' }, r.title),
      el('span', { class: 'tt-risk-exposure-badge' }, String(exposure)),
      reopenBtn
    )
  }

  const listEl = el('div', { class: 'tt-risk-list' })
  const closedEl = el('details', { class: 'tt-risks-closed' })

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
    // Four blank spacers matching the row's four trailing elements 1:1 — the
    // backlinks chip slot plus the three hover-revealed icon buttons
    // (expand/close/delete). A text label here ("Follow-up") was both
    // cramped and, since it only ever matched one of them, the reason the
    // header and row columns drifted out of alignment (2 header slots vs. 3
    // row buttons, before the chip made it 3 vs. 4).
    el('span', { class: 'tt-risk-header-spacer' }),
    el('span', { class: 'tt-risk-header-spacer' }),
    el('span', { class: 'tt-risk-header-spacer' }),
    el('span', { class: 'tt-risk-header-spacer' })
  )

  function updateSortIndicator(): void {
    sortIndicatorEl.textContent = sortMode === 'desc' ? ' ▾' : sortMode === 'asc' ? ' ▲' : ''
    exposureHeaderBtn.classList.toggle('active', sortMode !== 'none')
  }

  function renderAll(): void {
    expandable.disposeAll() // every previously-expanded editor is torn down before the list (and possibly fresh ones) is rebuilt
    listEl.innerHTML = ''
    const all = risks()
    const open = sortRisksForDisplay(all.filter((r) => !r.closed), sortMode)
    const closed = all.filter((r) => r.closed).sort((a, b) => a.order - b.order)
    if (open.length === 0) {
      listEl.appendChild(el('div', { class: 'tt-risk-empty' }, t(lc, 'risk_empty')))
    } else {
      for (const r of open) {
        listEl.appendChild(renderRow(r))
        if (expandable.isExpanded(r.id)) listEl.appendChild(renderFollowupRow(r))
      }
    }
    updateSortIndicator()
    updateExpandAllBtn(open)

    closedEl.innerHTML = ''
    closedEl.appendChild(el('summary', {}, t(lc, 'risks_closed_heading', { count: String(closed.length) })))
    closed.forEach((r) => closedEl.appendChild(renderClosedRow(r)))
    closedEl.classList.toggle('tt-risks-closed-empty', closed.length === 0)

    if (focusRiskId) {
      listEl.querySelector<HTMLInputElement>(`[data-risk-id="${focusRiskId}"] .tt-risk-title-input`)?.focus()
      focusRiskId = null
    }

    // Sized against listEl/closedEl's just-rebuilt heights (see
    // computeCellSize) — must run after they're rebuilt above, not before.
    renderQuadrant()
  }

  function addRisk(): void {
    const newId = crypto.randomUUID()
    focusRiskId = newId
    ctx.store.update((d) => {
      const tm = d.teams.find((t2) => t2.id === teamId)
      if (!tm) return
      const maxOrder = tm.risks.length === 0 ? -1 : Math.max(...tm.risks.map((r) => r.order))
      tm.risks.push({ id: newId, title: '', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: maxOrder + 1, closed: false })
    }, { teamId, sections: ['risks'] })
  }

  const addBtn = el(
    'button',
    { class: 'tt-btn tt-risk-add-btn', type: 'button', onclick: () => addRisk() },
    t(lc, 'risk_add_btn')
  )
  const expandAllBtn = el(
    'button',
    {
      class: 'tt-btn tt-risk-expand-all-btn',
      type: 'button',
      onclick: () => setAllExpanded(!expandable.isAllExpanded(risks().filter((r) => !r.closed).map((r) => r.id))),
    },
    ''
  )

  /** Label reads "Expand all" unless every open (non-closed) row is already expanded, in which case it flips to "Collapse all" — mirrors risk_expand_all_btn/risk_collapse_all_btn i18n keys. */
  function updateExpandAllBtn(open: Risk[]): void {
    expandAllBtn.textContent = t(lc, expandable.isAllExpanded(open.map((r) => r.id)) ? 'risk_collapse_all_btn' : 'risk_expand_all_btn')
  }

  const toolbar = el('div', { class: 'tt-risk-toolbar' }, addBtn, expandAllBtn)

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
  // and defer it to the field's next blur (see ui/dom.ts's
  // createDeferredRebuild, shared with the identical mechanism in
  // milestones.ts) — nothing is lost, since blur is exactly when this
  // field's own edit (if any) commits and would have triggered a rebuild
  // anyway.
  const deferred = createDeferredRebuild(renderAll)

  // Every risk's backlinks chip must react to a mention of it
  // appearing/disappearing anywhere BACKLINK_SECTIONS covers — a daily note,
  // a person's notes, an action item or milestone follow-up — not just
  // edits to risks themselves, so the watch list is that full set (plus
  // 'teams', since a rename/delete/reorder can invalidate any pane).
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    // Patches every expanded follow-up editor's @mention chips in place —
    // safe even while a caret-sensitive field elsewhere is focused (see
    // Editor.refreshRefLabels' doc comment), so this runs unconditionally
    // instead of waiting on the deferred full rebuild below.
    expandable.refreshAllLabels()
    const active = focusedCaretElement()
    if (active) {
      deferred.arm(active)
      return
    }
    renderAll()
  })

  /** Expands the risk a search result pointed at, if it's currently collapsed, so its follow-up text (what the search actually matched) becomes visible. No-op if the id isn't one of this team's risks or is already expanded. Safe even if a stale listener from a prior mount somehow survives — the id-membership check above makes it a no-op regardless. */
  function onSearchFocusItem(e: Event): void {
    const itemId = (e as CustomEvent<string>).detail
    if (!risks().some((r) => r.id === itemId)) return
    if (expandable.isExpanded(itemId)) return
    expandable.expand(itemId)
    renderAll()
  }
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)

  const disposeArrowFallback = installArrowFallbackFocus(ctx, listEl, '.tt-risk-row', ['ArrowDown', 'ArrowUp'])

  // Named (not inlined into the appendChild below) so computeCellSize can
  // measure its viewport height directly.
  const risksWrap = el('div', { class: 'tt-risks' }, quadrantEl, toolbar, headerRow, listEl, closedEl)
  container.appendChild(risksWrap)
  renderAll()
  // Lands focus on the first row the moment the module opens, so
  // ArrowUp/Down navigation works immediately without a preceding Tab. Only
  // for the pane the user is actually in — a team switch remounts both
  // panes together, and without this guard whichever pane happens to mount
  // second (always pane 1) would silently steal focus from pane 0's.
  if (ctx.paneIdx === ctx.store.doc.nav.focusedPane) {
    listEl.querySelector<HTMLElement>('.tt-risk-row')?.focus()
  }

  return () => {
    unsubscribe()
    // An armed deferral would otherwise rebuild a torn-down module on the
    // field's next blur.
    deferred.dispose()
    expandable.disposeAll()
    disposeArrowFallback()
    container.removeEventListener(SEARCH_FOCUS_ITEM_EVENT, onSearchFocusItem)
  }
})
