// src/modules/daily-notes.ts — Task 18: the first real module renderer.
// Wires src/ui/editor.ts (WYSIWYG editor), src/ui/atref.ts (@ mentions +
// ref-click navigation), src/ui/template-picker.ts (/ templates) and
// src/ui/calendar.ts (day picker) into the pane system (src/ui/panes.ts).
import type { Loc, Team } from '../core/types'
import { t, todayIso } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createRichEditorBundle } from '../ui/rich-editor'
import { createCalendar, type CalendarMarks } from '../ui/calendar'
import { nowHHMM } from '../core/date'
import { findTeam as docFindTeam } from '../core/document'
import { scopeAffects, type Section } from '../core/scope'
import { el } from '../ui/dom'
import { withDisposal } from './lifecycle'

function findTeam(ctx: ModuleCtx, teamId: string): Team | undefined {
  return docFindTeam(ctx.store.doc, teamId)
}

export const renderDailyNotes = withDisposal((container: HTMLElement, loc: Loc, ctx: ModuleCtx) => {
  if (loc.ref.kind !== 'daily') return // registered only for 'daily'; defensive
  const date = loc.ref.date
  const teamId = loc.teamId
  const lc = ctx.locale

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
        locale: lc,
        marks: buildMarks(),
        showPrevMonth: true,
        onPick: (pickedDate) => {
          ctx.pm.openInPane(ctx.paneIdx, { teamId, ref: { kind: 'daily', date: pickedDate } })
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
  calendarCol.append(toggleBtn, calendarSlot)

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
  // due dates, so it genuinely needs all three sections (plus 'teams', since
  // a rename/delete/reorder can invalidate any pane).
  const WATCHED: readonly Section[] = ['notes', 'milestones', 'actions', 'teams']
  const unsubscribe = ctx.store.subscribe((scope) => {
    if (!scopeAffects(scope, teamId, WATCHED)) return
    rebuildCalendar()
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
