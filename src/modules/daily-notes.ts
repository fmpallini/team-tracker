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
import { el } from '../ui/dom'

/**
 * Per-container disposers for the previous instance mounted into that
 * container. `renderDailyNotes` (like every module renderer) can be invoked
 * repeatedly on the *same* container element — src/ui/panes.ts's
 * `renderBody` clears the container's DOM children before re-invoking the
 * renderer, but that clear does *not* reach the document-level listeners and
 * document.body-appended overlays that src/ui/atref.ts's and
 * src/ui/template-picker.ts's dropdowns attach when open (they're not
 * descendants of `container`). Without explicit disposal those would leak a
 * live document 'mousedown' listener plus an orphaned dropdown element every
 * time the user re-opens the same daily-notes pane. A WeakMap (rather than a
 * DOM data-attribute or a property stashed on the element) keeps this
 * strictly internal bookkeeping off the container itself and lets the
 * container be garbage-collected normally once panes.ts drops it.
 */
const disposers = new WeakMap<HTMLElement, () => void>()

function findTeam(ctx: ModuleCtx, teamId: string): Team | undefined {
  return docFindTeam(ctx.store.doc, teamId)
}

export function renderDailyNotes(container: HTMLElement, loc: Loc, ctx: ModuleCtx): void {
  // Tear down whatever this container previously hosted (see comment on
  // `disposers` above) before mounting a new instance into it.
  disposers.get(container)?.()
  disposers.delete(container)

  if (loc.ref.kind !== 'daily') return // registered only for 'daily'; defensive
  const date = loc.ref.date
  const teamId = loc.teamId
  const lc = ctx.locale

  function buildMarks(): CalendarMarks {
    return {
      hasNote(d: string): boolean {
        const note = findTeam(ctx, teamId)?.dailyNotes[d]
        return typeof note === 'string' && note.trim() !== ''
      },
      milestones(d: string): string[] {
        return (findTeam(ctx, teamId)?.milestones ?? []).filter((m) => m.date === d).map((m) => m.title)
      },
      actionItems(d: string): string[] {
        return (findTeam(ctx, teamId)?.actionItems ?? []).filter((a) => a.dueDate === d).map((a) => a.summary)
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
      })
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
  const unsubscribe = ctx.store.subscribe(() => {
    rebuildCalendar()
  })

  const layout = el(
    'div',
    { class: 'tt-daily-layout' },
    calendarCol,
    el('div', { class: 'tt-daily-editor-col' }, editor.root)
  )
  container.appendChild(layout)

  disposers.set(container, () => {
    unsubscribe()
    bundle.dispose()
  })
}
