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

export interface CalendarMarks {
  hasNote(dateIso: string): boolean
  /** Titles of milestones landing on this day; empty array = no milestone. */
  milestones(dateIso: string): string[]
  /** Summaries of action items due this day; empty array = none due. */
  actionItems(dateIso: string): string[]
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
          '‹'
        )
      : null
    const nextBtn = withNav
      ? el(
          'button',
          { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_next_month_title'), onclick: goNextMonth },
          '›'
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

      const titles = opts.marks.milestones(iso)
      if (titles.length > 0) {
        dayBtn.appendChild(el('span', { class: 'tt-calendar-flag', title: titles.join(', ') }, '🚩'))
      }

      const dueSummaries = opts.marks.actionItems(iso)
      if (dueSummaries.length > 0) {
        dayBtn.appendChild(el('span', { class: 'tt-calendar-check', title: dueSummaries.join(', ') }, '✅'))
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
