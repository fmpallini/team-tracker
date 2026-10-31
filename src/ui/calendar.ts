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
import { icon, iconButton } from './icons'

export interface CalendarMarks {
  hasNote(dateIso: string): boolean
  /** Milestones landing on this day, each already labelled with its title and done/pending status for the icon's tooltip; empty array = no milestone. */
  milestones(dateIso: string): { label: string; done: boolean }[]
  /** Action items due this day, each already labelled with its summary and status for the icon's tooltip; `resolved` groups 'done' and 'cancelled' together, matching the icon's own two states. Empty array = none due. */
  actionItems(dateIso: string): { label: string; resolved: boolean }[]
  /** How many other fields @-mention this day (the day's "↩ N" chip count); 0 = none. */
  backlinks(dateIso: string): number
}

/** Marks a day cell as referenced (the dog-ear in the corner) with a "{count} references" tooltip, or clears both when `count` is 0. Shared with daily-notes.ts's in-place refresh. */
export function setDayBacklinks(cell: HTMLElement, count: number, locale: Locale): void {
  cell.classList.toggle('tt-calendar-day-has-backlinks', count > 0)
  if (count > 0) cell.title = t(locale, 'backlinks_badge_title', { count: String(count) })
  else cell.removeAttribute('title')
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

  const root = el('div', { class: 'tt-calendar' + (opts.showPrevMonth ? ' tt-calendar-stacked' : '') })

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
      ? iconButton({
        class: 'tt-calendar-nav-btn',
        title: t(opts.locale, 'calendar_prev_month_title'),
        icon: 'back',
        size: 12,
        onclick: goPrevMonth,
      })
      : null
    const nextBtn = withNav
      ? iconButton({
        class: 'tt-calendar-nav-btn',
        title: t(opts.locale, 'calendar_next_month_title'),
        icon: 'next',
        size: 12,
        onclick: goNextMonth,
      })
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

    // The days either side of the month stay in the grid as faint, inert numbers, so every week row reads complete.
    const outside = (n: number): HTMLElement => el('div', { class: 'tt-calendar-day tt-calendar-day-blank tt-calendar-day-outside', 'aria-hidden': 'true' }, String(n))
    const prevMonthDays = new Date(year, month - 1, 0).getDate()
    for (let i = 0; i < firstDow; i++) grid.appendChild(outside(prevMonthDays - firstDow + 1 + i))

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
      setDayBacklinks(dayBtn, opts.marks.backlinks(iso), opts.locale)

      // One icon per type regardless of how many items land on the day — its
      // state groups every item on that day into "still needs attention" vs
      // "resolved": any not-done milestone, or any action neither done nor
      // cancelled, flips the whole icon to its pending state. The tooltip
      // (native `title`) always lists every item with its own status, so
      // nothing is lost by collapsing the icon itself to two states.
      const milestoneEntries = opts.marks.milestones(iso)
      if (milestoneEntries.length > 0) {
        const pending = milestoneEntries.some((m) => !m.done)
        dayBtn.appendChild(el('span', {
          class: 'tt-calendar-flag', 'data-state': pending ? 'pending' : 'done', title: milestoneEntries.map((m) => m.label).join(', '),
        }, icon(pending ? 'flag' : 'flagFill', 11)))
      }

      const actionEntries = opts.marks.actionItems(iso)
      if (actionEntries.length > 0) {
        const pending = actionEntries.some((a) => !a.resolved)
        dayBtn.appendChild(el('span', {
          class: 'tt-calendar-check', 'data-state': pending ? 'pending' : 'done', title: actionEntries.map((a) => a.label).join(', '),
        }, icon(pending ? 'checkbox' : 'tasks', 11)))
      }

      grid.appendChild(dayBtn)
    }

    for (let n = 1; n <= (7 - ((firstDow + daysInMonth) % 7)) % 7; n++) grid.appendChild(outside(n))

    return grid
  }

  /** One month as its own card. The one holding the selected day is marked, so a stacked pair can lift it and let the other recede. */
  function buildMonth(year: number, month: number, withNav: boolean): HTMLElement {
    const holdsSelected = opts.selected.startsWith(`${year}-${pad2(month)}-`)
    return el(
      'section',
      { class: 'tt-calendar-month' + (holdsSelected ? ' tt-calendar-month-current' : '') },
      buildHeader(monthLabel(year, month), withNav),
      buildWeekdaysRow(),
      buildGrid(year, month)
    )
  }

  function render(): void {
    root.innerHTML = ''

    if (opts.showPrevMonth) {
      let prevMonth = viewMonth - 1
      let prevYear = viewYear
      if (prevMonth < 1) { prevMonth = 12; prevYear -= 1 }
      // Both arrows sit on the upper month's header, as they always have.
      root.append(buildMonth(prevYear, prevMonth, true), buildMonth(viewYear, viewMonth, false))
    } else {
      root.append(buildMonth(viewYear, viewMonth, true))
    }
  }

  render()
  return root
}
