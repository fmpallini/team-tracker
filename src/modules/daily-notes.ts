// src/modules/daily-notes.ts — Task 18: the first real module renderer.
// Wires src/ui/editor.ts (WYSIWYG editor), src/ui/atref.ts (@ mentions +
// ref-click navigation), src/ui/template-picker.ts (/ templates) and
// src/ui/calendar.ts (day picker) into the pane system (src/ui/panes.ts).
import type { Loc, Team } from '../core/types'
import { t } from '../core/i18n'
import type { ModuleCtx } from '../ui/panes'
import { createEditor, type Editor } from '../ui/editor'
import { attachAtAutocomplete, makeRefClickHandler, type AtPerson } from '../ui/atref'
import { attachTemplatePicker } from '../ui/template-picker'
import { createCalendar, type CalendarMarks } from '../ui/calendar'
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

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function nowHHMM(): string {
  const now = new Date()
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

function findTeam(ctx: ModuleCtx, teamId: string): Team | undefined {
  return ctx.store.doc.teams.find((tm) => tm.id === teamId)
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

  const editor: Editor = createEditor(
    {
      onChange() {
        const md = editor.getMd()
        ctx.store.update((d) => {
          const tm = d.teams.find((t2) => t2.id === teamId)
          if (!tm) return
          if (md.trim() === '') delete tm.dailyNotes[date]
          else tm.dailyNotes[date] = md
        })
      },
      onRefClick: makeRefClickHandler(ctx.store, ctx.pm, ctx.paneIdx, lc, teamId),
      onAtTrigger() {},
      onSlashTrigger() {},
    },
    lc
  )
  editor.setMd(findTeam(ctx, teamId)?.dailyNotes[date] ?? '')

  function getPeople(): AtPerson[] {
    const tm = findTeam(ctx, teamId)
    if (!tm) return []
    return [
      ...tm.stakeholders.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'stakeholders' })),
      ...tm.members.map((p): AtPerson => ({ id: p.id, name: p.name, group: 'members' })),
    ]
  }

  const atHandle = attachAtAutocomplete(editor, { getPeople, locale: lc, onPick: () => {} })

  const tplHandle = attachTemplatePicker(editor, {
    getTemplates: () => ctx.store.doc.templates.filter((tpl) => tpl.scope === 'daily' || tpl.scope === 'any'),
    getCtx: () => ({
      dateIso: date,
      time: nowHHMM(),
      teamName: findTeam(ctx, teamId)?.name,
      locale: lc,
    }),
    locale: lc,
  })

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
    atHandle.dispose()
    tplHandle.dispose()
    editor.destroy()
  })
}
