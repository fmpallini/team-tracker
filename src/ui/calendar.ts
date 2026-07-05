// src/ui/calendar.ts — mini month calendar used by src/modules/daily-notes.ts
// (Task 18) to pick a day. Self-contained: owns its own "currently displayed
// month" state (initialized from `opts.selected`) and re-renders its own DOM
// in place on month navigation. The caller rebuilds a fresh instance (see
// daily-notes.ts's rebuildCalendar) whenever the underlying marks change —
// this module has no external "refresh" hook by design (matches the fixed
// `createCalendar(opts): HTMLElement` contract).
import { t, todayIso, type Locale } from '../core/i18n'
import { el } from './dom'

export interface CalendarMarks {
  hasNote(dateIso: string): boolean
  /** Titles of milestones landing on this day; empty array = no milestone. */
  milestones(dateIso: string): string[]
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
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
}): HTMLElement {
  const initial = parseIso(opts.selected)
  let viewYear = initial.y
  let viewMonth = initial.m // 1-12

  const root = el('div', { class: 'tt-calendar' })

  function monthLabel(): string {
    return `${t(opts.locale, `calendar_month_${viewMonth}` as 'calendar_month_1')} ${viewYear}`
  }

  function goPrevMonth(): void {
    viewMonth -= 1
    if (viewMonth < 1) { viewMonth = 12; viewYear -= 1 }
    render()
  }

  function goNextMonth(): void {
    viewMonth += 1
    if (viewMonth > 12) { viewMonth = 1; viewYear += 1 }
    render()
  }

  function render(): void {
    root.innerHTML = ''

    const prevBtn = el(
      'button',
      { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_prev_month_title'), onclick: goPrevMonth },
      '‹'
    )
    const nextBtn = el(
      'button',
      { class: 'tt-btn tt-calendar-nav-btn', type: 'button', title: t(opts.locale, 'calendar_next_month_title'), onclick: goNextMonth },
      '›'
    )
    const header = el(
      'div',
      { class: 'tt-calendar-header' },
      prevBtn,
      el('span', { class: 'tt-calendar-month-label' }, monthLabel()),
      nextBtn
    )

    const weekdaysRow = el('div', { class: 'tt-calendar-weekdays' })
    for (let dow = 0; dow < 7; dow++) {
      weekdaysRow.appendChild(el('span', { class: 'tt-calendar-weekday' }, t(opts.locale, `calendar_weekday_${dow}` as 'calendar_weekday_0')))
    }

    const grid = el('div', { class: 'tt-calendar-grid' })
    const firstDow = new Date(viewYear, viewMonth - 1, 1).getDay()
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate()
    const today = todayIso()

    for (let i = 0; i < firstDow; i++) {
      grid.appendChild(el('div', { class: 'tt-calendar-day tt-calendar-day-blank' }))
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${viewYear}-${pad2(viewMonth)}-${pad2(day)}`
      const classes = ['tt-calendar-day']
      if (iso === today) classes.push('tt-calendar-day-today')
      if (iso === opts.selected) classes.push('tt-calendar-day-selected')
      if (opts.marks.hasNote(iso)) classes.push('tt-calendar-day-has-note')

      const dayBtn = el(
        'button',
        { class: classes.join(' '), type: 'button', onclick: () => opts.onPick(iso) },
        String(day)
      )

      const titles = opts.marks.milestones(iso)
      if (titles.length > 0) {
        dayBtn.appendChild(el('span', { class: 'tt-calendar-flag', title: titles.join(', ') }, '🚩'))
      }

      grid.appendChild(dayBtn)
    }

    root.append(header, weekdaysRow, grid)
  }

  render()
  return root
}
