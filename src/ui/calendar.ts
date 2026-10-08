// src/ui/calendar.ts — mini month calendar used by src/modules/daily-notes.ts
// (Task 18) to pick a day. Self-contained: owns its own "currently displayed
// month" state (initialized from `opts.anchor ?? opts.selected`) and
// re-renders its own DOM in place on month navigation. The caller rebuilds a
// fresh instance (see
// daily-notes.ts's rebuildCalendar) whenever the underlying marks change —
// this module has no external "refresh" hook by design (matches the fixed
// `createCalendar(opts): HTMLElement` contract).
import { t, todayIso, type Locale } from '../core/i18n'
import { pad2 } from '../core/date'
import { el } from './dom'
import { icon } from './icons'

export interface CalendarMarks {
  hasNote(dateIso: string): boolean
  /** Milestones landing on this day, each already labelled with its title and done/pending status for the icon's tooltip; empty array = no milestone. */
  milestones(dateIso: string): { label: string; done: boolean }[]
  /** Action items due this day, each already labelled with its summary and status for the icon's tooltip; `resolved` groups 'done' and 'cancelled' together, matching the icon's own two states. Empty array = none due. */
  actionItems(dateIso: string): { label: string; resolved: boolean }[]
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

export function createCalendar(opts: {
  selected: string
  locale: Locale
  marks: CalendarMarks
  onPick(dateIso: string): void
  /** Also render a non-navigable grid for the month before the displayed one, stacked above it (Task: daily-notes two-month view). */
  showPrevMonth?: boolean
  /** ISO date whose month seeds the displayed pair; defaults to `selected`. Lets a caller keep the same two months on screen across a re-mount even when `selected` moves to a different (but still visible) month — see daily-notes.ts's calendarAnchorByPane. */
  anchor?: string
  /** Fired when the user moves the displayed month via the nav arrows (goPrevMonth/goNextMonth), carrying the new displayed month as an ISO date (day component is arbitrary, e.g. "-01"). Lets a caller keep its own anchor tracking (e.g. daily-notes.ts's calendarAnchorByPane) in sync with manual navigation, not just picks. */
  onViewChange?(anchorIso: string): void
}): HTMLElement {
  const initial = parseIso(opts.anchor ?? opts.selected)
  let viewYear = initial.y
  let viewMonth = initial.m // 1-12

  const root = el('div', { class: 'tt-calendar' })

  function monthLabel(year: number, month: number): string {
    return `${t(opts.locale, `calendar_month_${month}` as 'calendar_month_1')} ${year}`
  }

  function goPrevMonth(): void {
    viewMonth -= 1
    if (viewMonth < 1) { viewMonth = 12; viewYear -= 1 }
    render()
    opts.onViewChange?.(`${viewYear}-${pad2(viewMonth)}-01`)
  }

  function goNextMonth(): void {
    viewMonth += 1
    if (viewMonth > 12) { viewMonth = 1; viewYear += 1 }
    render()
    opts.onViewChange?.(`${viewYear}-${pad2(viewMonth)}-01`)
  }

  function buildHeader(label: string, withNav: boolean): HTMLElement {
    const prevBtn = withNav
      ? el(
          'button',
          { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_prev_month_title'), onclick: goPrevMonth },
          icon('back', 12)
        )
      : null
    const nextBtn = withNav
      ? el(
          'button',
          { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_next_month_title'), onclick: goNextMonth },
          icon('next', 12)
        )
      : null
    return el(
      'div',
      { class: 'tt-calendar-header' },
      prevBtn,
      el('span', { class: 'tt-calendar-month-label' }, label),
      nextBtn
    )
  }

  function buildWeekdaysRow(): HTMLElement {
    const weekdaysRow = el('div', { class: 'tt-calendar-weekdays' })
    for (let dow = 0; dow < 7; dow++) {
      weekdaysRow.appendChild(el('span', { class: 'tt-calendar-weekday' }, t(opts.locale, `calendar_weekday_${dow}` as 'calendar_weekday_0')))
    }
    return weekdaysRow
  }

  function buildGrid(year: number, month: number): HTMLElement {
    const grid = el('div', { class: 'tt-calendar-grid' })
    const firstDow = new Date(year, month - 1, 1).getDay()
    const daysInMonth = new Date(year, month, 0).getDate()
    const today = todayIso()

    for (let i = 0; i < firstDow; i++) {
      grid.appendChild(el('div', { class: 'tt-calendar-day tt-calendar-day-blank' }))
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${year}-${pad2(month)}-${pad2(day)}`
      const classes = ['tt-calendar-day']
      if (iso === today) classes.push('tt-calendar-day-today')
      if (iso === opts.selected) classes.push('tt-calendar-day-selected')
      if (opts.marks.hasNote(iso)) classes.push('tt-calendar-day-has-note')

      const dayBtn = el(
        'button',
        { class: classes.join(' '), type: 'button', 'data-date': iso, onclick: () => opts.onPick(iso) },
        String(day)
      )

      // One icon per type regardless of how many items land on the day — its
      // state groups every item on that day into "still needs attention" vs
      // "resolved": any not-done milestone, or any action neither done nor
      // cancelled, flips the whole icon to its pending state. The tooltip
      // (native `title`) always lists every item with its own status, so
      // nothing is lost by collapsing the icon itself to two states.
      const milestoneEntries = opts.marks.milestones(iso)
      if (milestoneEntries.length > 0) {
        const icon = milestoneEntries.some((m) => !m.done) ? '🚩' : '🏁'
        dayBtn.appendChild(el('span', { class: 'tt-calendar-flag', title: milestoneEntries.map((m) => m.label).join(', ') }, icon))
      }

      const actionEntries = opts.marks.actionItems(iso)
      if (actionEntries.length > 0) {
        const icon = actionEntries.some((a) => !a.resolved) ? '⏳' : '✅'
        dayBtn.appendChild(el('span', { class: 'tt-calendar-check', title: actionEntries.map((a) => a.label).join(', ') }, icon))
      }

      grid.appendChild(dayBtn)
    }

    return grid
  }

  function render(): void {
    root.innerHTML = ''

    const header = buildHeader(monthLabel(viewYear, viewMonth), !opts.showPrevMonth)
    const weekdaysRow = buildWeekdaysRow()
    const grid = buildGrid(viewYear, viewMonth)

    if (opts.showPrevMonth) {
      let prevMonth = viewMonth - 1
      let prevYear = viewYear
      if (prevMonth < 1) { prevMonth = 12; prevYear -= 1 }

      const prevHeader = buildHeader(monthLabel(prevYear, prevMonth), true)
      const prevWeekdaysRow = buildWeekdaysRow()
      const prevGrid = buildGrid(prevYear, prevMonth)

      root.append(
        prevHeader, prevWeekdaysRow, prevGrid,
        el('div', { class: 'tt-calendar-divider' }),
        header, weekdaysRow, grid
      )
    } else {
      root.append(header, weekdaysRow, grid)
    }
  }

  render()
  return root
}
