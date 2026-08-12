// src/modules/daily-notes.ts — Task 18: the first real module renderer.
// Wires src/ui/editor.ts (WYSIWYG editor), src/ui/atref.ts (@ mentions +
// ref-click navigation), src/ui/template-picker.ts (/ templates) and
// src/ui/calendar.ts (day picker) into the pane system (src/ui/panes.ts).
import type { Loc, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createRichEditorBundle } from '../ui/rich-editor'
import { createCalendar, type CalendarMarks } from '../ui/calendar'
import { nowHHMM, isWithinTwoMonthWindow } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'
import { scopeAffects, type Section } from '../core/scope'
import type { Store } from '../core/store'
import { el } from '../ui/dom'
import { withDisposal } from './lifecycle'
import { BACKLINK_SECTIONS } from '../core/search'
import { createBacklinksChip } from '../ui/backlinks-panel'
import { navigateToLoc } from '../ui/atref'

function findTeam(ctx: ModuleCtx, teamId: string): Team | undefined {
  return docFindTeam(ctx.store.doc, teamId)
}

/**
 * Per-store, per-pane "which month pair the two-month calendar is anchored
 * to". `withDisposal` (lifecycle.ts) tears down and rebuilds
 * `renderDailyNotes`'s whole closure on every pane navigation — including a
 * pick on this very calendar — so this can't live in a local variable; it
 * has to survive the remount. Keyed by Store (main.ts's onDocumentOpened
 * creates a fresh one per file open, mirroring panes.ts's layoutsByStore)
 * so it never leaks state from a previously-closed document.
 *
 * Keyed by pane index only, not (pane, team): switching teams in a pane
 * carries over the previous team's anchor. Accepted tradeoff, not an
 * oversight — the opened date is always still visible in one of the two
 * grids either way, so the worst case is a one-month visual offset.
 */
const calendarAnchorByPane = new WeakMap<Store, Map<0 | 1, string>>()

/**
 * Reuses the pane's previous anchor if `date` is already visible under it
 * (see isWithinTwoMonthWindow), so picking a date already shown in either
 * grid doesn't re-center the pair — only the highlighted day moves. Falls
 * back to `date` itself (today's behavior) the first time a pane opens, or
 * whenever the newly-opened date falls outside the currently displayed pair.
 */
function resolveCalendarAnchor(store: Store, paneIdx: 0 | 1, date: string): string {
  let panes = calendarAnchorByPane.get(store)
  if (!panes) {
    panes = new Map()
    calendarAnchorByPane.set(store, panes)
  }
  const prevAnchor = panes.get(paneIdx)
  const anchor = prevAnchor && isWithinTwoMonthWindow(prevAnchor, date) ? prevAnchor : date
  panes.set(paneIdx, anchor)
  return anchor
}

export const renderDailyNotes = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'daily') return // registered only for 'daily'; defensive
  const date = loc.ref.date
  const teamId = loc.teamId
  const lc = ctx.locale
  let anchor = resolveCalendarAnchor(ctx.store, ctx.paneIdx, date)

  function buildMarks(): CalendarMarks {
    const team = findTeam(ctx, teamId)
    const milestonesByDate = new Map<string, string[]>()
    for (const m of team?.milestones ?? []) {
      const list = milestonesByDate.get(m.date)
      if (list) list.push(m.title)
      else milestonesByDate.set(m.date, [m.title])
    }
    const actionItemsByDate = new Map<string, string[]>()
    for (const a of team?.actionItems ?? []) {
      if (a.dueDate === null) continue
      const list = actionItemsByDate.get(a.dueDate)
      if (list) list.push(a.summary)
      else actionItemsByDate.set(a.dueDate, [a.summary])
    }
    const dailyNotes = team?.dailyNotes ?? {}
    return {
      hasNote(d: string): boolean {
        const note = dailyNotes[d]
        return typeof note === 'string' && note.trim() !== ''
      },
      milestones(d: string): string[] {
        return milestonesByDate.get(d) ?? []
      },
      actionItems(d: string): string[] {
        return actionItemsByDate.get(d) ?? []
      },
    }
  }

  const calendarSlot = el('div', { class: 'tt-daily-calendar-slot' })
  function rebuildCalendar(): void {
    calendarSlot.innerHTML = ''
    calendarSlot.appendChild(
      createCalendar({
        selected: date,
        anchor,
        locale: lc,
        marks: buildMarks(),
        showPrevMonth: true,
        onPick: (pickedDate) => {
          ctx.pm.openInPane(ctx.paneIdx, { teamId, ref: { kind: 'daily', date: pickedDate } })
        },
        onViewChange: (a) => {
          anchor = a
          calendarAnchorByPane.get(ctx.store)?.set(ctx.paneIdx, a)
        },
      })
    )
    calendarSlot.appendChild(
      el(
        'div',
        { class: 'tt-daily-calendar-actions' },
        el(
          'button',
          {
            class: 'tt-btn tt-daily-calendar-today-btn',
            type: 'button',
            onclick: () => ctx.pm.openInPane(ctx.paneIdx, { teamId, ref: { kind: 'daily', date: todayIso() } }),
          },
          t(lc, 'date_picker_today_btn')
        )
      )
    )
  }
  rebuildCalendar()

  let collapsed = false
  const calendarCol = el('div', { class: 'tt-daily-calendar-col' })
  const toggleBtn = el(
    'button',
    {
      class: 'tt-btn tt-daily-calendar-toggle',
      type: 'button',
      title: t(lc, 'calendar_toggle_title'),
      onclick: () => {
        collapsed = !collapsed
        calendarCol.classList.toggle('tt-daily-collapsed', collapsed)
      },
    },
    '📅'
  )
  const badgeSlot = el('div', { class: 'tt-daily-badge-slot' })
  function rebuildBadge(): void {
    badgeSlot.innerHTML = ''
    const backlinks = ctx.searchIndex.backlinks(teamId, 'day', date)
    const chip = createBacklinksChip(backlinks, lc, (loc, opts) => navigateToLoc(ctx.store, ctx.pm, ctx.paneIdx, loc, opts))
    if (chip) badgeSlot.appendChild(chip)
  }
  rebuildBadge()
  calendarCol.append(toggleBtn, badgeSlot, calendarSlot)

  const bundle = createRichEditorBundle({
    store: ctx.store, pm: ctx.pm, paneIdx: ctx.paneIdx, locale: lc, teamId,
    initialMd: findTeam(ctx, teamId)?.dailyNotes[date] ?? '',
    onChange: (md) => {
      ctx.store.update((d) => {
        const tm = d.teams.find((t2) => t2.id === teamId)
        if (!tm) return
        if (md.trim() === '') delete tm.dailyNotes[date]
        else tm.dailyNotes[date] = md
      }, { teamId, sections: ['notes'] })
    },
    getTeam: () => findTeam(ctx, teamId),
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'daily' || tpl.scope === 'any'),
    getTemplateCtx: () => ({ dateIso: date, time: nowHHMM(lc), teamName: findTeam(ctx, teamId)?.name, locale: lc }),
  })
  const editor = bundle.editor

  // Marks (has-note tint, milestone flags) can change from edits made
  // elsewhere (this same note, the milestones module in the other split
  // pane, etc.) — refresh only the calendar; touching the editor here would
  // clobber the user's live caret position.
  // The calendar marks show has-note tint, milestone flags, and action-item
  // due dates, so that alone would need 'notes'/'milestones'/'actions' (plus
  // 'teams', since a rename/delete/reorder can invalidate any pane). The
  // remaining BACKLINK_SECTIONS entries ('people', 'risks') are watched too,
  // for rebuildBadge() below: the day's backlinks chip must react to a
  // mention of this date appearing/disappearing in any of those sections.
  const WATCHED: readonly Section[] = ['teams', ...BACKLINK_SECTIONS]
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    rebuildCalendar()
    rebuildBadge()
    // Patches this note's own @mention chips in place — safe even mid-typing
    // (see Editor.refreshRefLabels' doc comment), unlike rebuilding the
    // editor content outright.
    editor.refreshRefLabels()
  })

  const layout = el(
    'div',
    { class: 'tt-daily-layout' },
    calendarCol,
    el('div', { class: 'tt-daily-editor-col' }, editor.root)
  )
  container.appendChild(layout)

  return () => {
    unsubscribe()
    bundle.dispose()
  }
})
