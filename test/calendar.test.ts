import { createCalendar, type CalendarMarks } from '../src/ui/calendar'
import type { Locale } from '../src/core/i18n'

function noMarks(): CalendarMarks {
  return { hasNote: () => false, milestones: () => [], actionItems: () => [] }
}

function dayButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('.tt-calendar-day:not(.tt-calendar-day-blank)'))
}

/** Finds the button for a given day-of-month by its leading text node (ignores the optional flag span appended after it). */
function dayButtonFor(root: HTMLElement, day: number): HTMLButtonElement {
  const found = dayButtons(root).find((b) => (b.firstChild?.textContent ?? '') === String(day))
  if (!found) throw new Error(`no day button found for day ${day}`)
  return found
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createCalendar grid math', () => {
  test('renders exactly the number of days in the displayed month, plus correct leading blanks', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    const daysInMonth = new Date(2026, 7, 0).getDate() // July 2026 -> 31
    const firstDow = new Date(2026, 6, 1).getDay()

    expect(dayButtons(root)).toHaveLength(daysInMonth)
    expect(root.querySelectorAll('.tt-calendar-day-blank')).toHaveLength(firstDow)
  })

  test('renders 7 weekday headers', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(root.querySelectorAll('.tt-calendar-weekday')).toHaveLength(7)
  })

  test('handles a leap-February month (29 days)', () => {
    const root = createCalendar({ selected: '2028-02-10', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(dayButtons(root)).toHaveLength(29)
  })

  test('each day cell carries its ISO date as data-date', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(dayButtonFor(root, 1).dataset.date).toBe('2026-07-01')
    expect(dayButtonFor(root, 15).dataset.date).toBe('2026-07-15')
    expect(dayButtonFor(root, 31).dataset.date).toBe('2026-07-31')
  })
})

describe('createCalendar today ring', () => {
  test('marks today with tt-calendar-day-today and no other day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15)) // 2026-07-15 local

    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    const todayCells = root.querySelectorAll('.tt-calendar-day-today')
    expect(todayCells).toHaveLength(1)
    expect(dayButtonFor(root, 15).classList.contains('tt-calendar-day-today')).toBe(true)
    expect(dayButtonFor(root, 14).classList.contains('tt-calendar-day-today')).toBe(false)
  })

  test('no day is marked today when the displayed month is not the current month', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15)) // today = July 2026

    const root = createCalendar({ selected: '2026-08-01', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(root.querySelectorAll('.tt-calendar-day-today')).toHaveLength(0)
  })
})

describe('createCalendar marks', () => {
  test('hasNote(day) tints that day and no other', () => {
    const marks: CalendarMarks = { hasNote: (d) => d === '2026-07-10', milestones: () => [], actionItems: () => [] }
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US', marks, onPick: () => {} })

    expect(dayButtonFor(root, 10).classList.contains('tt-calendar-day-has-note')).toBe(true)
    expect(dayButtonFor(root, 11).classList.contains('tt-calendar-day-has-note')).toBe(false)
  })

  test('milestones(day) renders a 🚩 flag with a title of the joined milestone titles', () => {
    const marks: CalendarMarks = {
      hasNote: () => false,
      milestones: (d) => (d === '2026-07-20' ? ['Launch', 'Freeze'] : []),
      actionItems: () => [],
    }
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US', marks, onPick: () => {} })

    const flag = dayButtonFor(root, 20).querySelector('.tt-calendar-flag')
    expect(flag).not.toBeNull()
    expect(flag!.textContent).toBe('🚩')
    expect(flag!.getAttribute('title')).toBe('Launch, Freeze')
    expect(dayButtonFor(root, 21).querySelector('.tt-calendar-flag')).toBeNull()
  })

  test('actionItems(day) renders a ✅ check with a title of the joined summaries', () => {
    const marks: CalendarMarks = {
      hasNote: () => false,
      milestones: () => [],
      actionItems: (d) => (d === '2026-07-20' ? ['Ship report', 'Review budget'] : []),
    }
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US', marks, onPick: () => {} })

    const check = dayButtonFor(root, 20).querySelector('.tt-calendar-check')
    expect(check).not.toBeNull()
    expect(check!.textContent).toBe('✅')
    expect(check!.getAttribute('title')).toBe('Ship report, Review budget')
    expect(dayButtonFor(root, 21).querySelector('.tt-calendar-check')).toBeNull()
  })
})

describe('createCalendar month navigation', () => {
  function monthLabel(root: HTMLElement): string {
    return root.querySelector('.tt-calendar-month-label')!.textContent ?? ''
  }

  test('clicking › advances one month, regenerating the grid for the new month', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(monthLabel(root)).toBe('July 2026')

    ;(root.querySelector('.tt-calendar-nav-btn:last-of-type') as HTMLButtonElement).click()

    expect(monthLabel(root)).toBe('August 2026')
    expect(dayButtons(root)).toHaveLength(31)
  })

  test('clicking ‹ from January wraps back to December of the previous year', () => {
    const root = createCalendar({ selected: '2026-01-15', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(monthLabel(root)).toBe('January 2026')

    ;(root.querySelector('.tt-calendar-nav-btn') as HTMLButtonElement).click()

    expect(monthLabel(root)).toBe('December 2025')
  })

  test('month label uses the locale dictionary (pt-BR month names)', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'pt-BR', marks: noMarks(), onPick: () => {} })
    expect(monthLabel(root)).toBe('Julho 2026')
  })
})

describe('createCalendar showPrevMonth', () => {
  /** Month labels in DOM order: [0] = previous-month header, [1] = current-month header. */
  function monthLabels(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll('.tt-calendar-month-label')).map((e) => e.textContent ?? '')
  }
  /** Nav buttons in DOM order. In showPrevMonth mode (the only mode this describe block uses) all nav buttons live on the top/previous-month header — the bottom/current-month header has none: [0]=‹ [1]=›. (Single-month mode has its own nav buttons, covered by the separate 'createCalendar month navigation' describe block above.) */
  function navBtns(root: HTMLElement): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('.tt-calendar-nav-btn'))
  }

  test('renders a single header/weekday-row/grid by default', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {} })
    expect(root.querySelectorAll('.tt-calendar-header')).toHaveLength(1)
    expect(root.querySelectorAll('.tt-calendar-weekdays')).toHaveLength(1)
    expect(root.querySelectorAll('.tt-calendar-grid')).toHaveLength(1)
  })

  test('renders a labeled previous-month header/weekdays/grid above the current one', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })

    expect(monthLabels(root)).toEqual(['June 2026', 'July 2026'])
    expect(root.querySelectorAll('.tt-calendar-header')).toHaveLength(2)
    expect(root.querySelectorAll('.tt-calendar-weekdays')).toHaveLength(2)
    expect(root.querySelectorAll('.tt-calendar-weekday')).toHaveLength(14)

    const grids = root.querySelectorAll('.tt-calendar-grid')
    expect(grids).toHaveLength(2)
    const juneDays = new Date(2026, 6, 0).getDate() // June 2026 -> 30
    expect(grids[0]!.querySelectorAll('.tt-calendar-day:not(.tt-calendar-day-blank)')).toHaveLength(juneDays)
  })

  test('defaults the displayed month pair to selected when anchor is omitted', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    expect(monthLabels(root)).toEqual(['June 2026', 'July 2026'])
  })

  test('anchor controls the displayed month pair independently of selected', () => {
    const root = createCalendar({
      selected: '2026-06-10', anchor: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true,
    })
    expect(monthLabels(root)).toEqual(['June 2026', 'July 2026'])

    const topGrid = root.querySelectorAll('.tt-calendar-grid')[0]!
    const selectedBtn = Array.from(topGrid.querySelectorAll('.tt-calendar-day')).find((b) =>
      b.classList.contains('tt-calendar-day-selected')
    )
    expect(selectedBtn?.firstChild?.textContent).toBe('10')
  })

  test('previous-month header wraps to December of the prior year from January', () => {
    const root = createCalendar({ selected: '2026-01-10', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    expect(monthLabels(root)).toEqual(['December 2025', 'January 2026'])
  })

  test('nav arrows appear only on the previous-month (top) header', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    const headers = root.querySelectorAll('.tt-calendar-header')
    expect(headers).toHaveLength(2)
    expect(headers[0]!.querySelectorAll('.tt-calendar-nav-btn')).toHaveLength(2)
    expect(headers[1]!.querySelectorAll('.tt-calendar-nav-btn')).toHaveLength(0)
  })

  test('navigating › (the only nav arrows, on the top header) shifts both labels', () => {
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: () => {}, showPrevMonth: true })
    navBtns(root)[1]!.click() // top header's ›

    expect(monthLabels(root)).toEqual(['July 2026', 'August 2026'])
  })

  test('clicking a day in the previous-month grid invokes onPick with that day\'s ISO date', () => {
    const picks: string[] = []
    const root = createCalendar({ selected: '2026-07-15', locale: 'en-US', marks: noMarks(), onPick: (d) => picks.push(d), showPrevMonth: true })

    const prevGrid = root.querySelectorAll('.tt-calendar-grid')[0]!
    const dayBtn = Array.from(prevGrid.querySelectorAll('.tt-calendar-day:not(.tt-calendar-day-blank)')).find(
      (b) => (b.firstChild?.textContent ?? '') === '10'
    ) as HTMLButtonElement
    dayBtn.click()

    expect(picks).toEqual(['2026-06-10'])
  })
})

describe('createCalendar onPick', () => {
  test('clicking a day invokes onPick with that day\'s ISO date', () => {
    const picks: string[] = []
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US' as Locale, marks: noMarks(), onPick: (d) => picks.push(d) })

    dayButtonFor(root, 22).click()

    expect(picks).toEqual(['2026-07-22'])
  })
})
