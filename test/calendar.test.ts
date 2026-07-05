import { createCalendar, type CalendarMarks } from '../src/ui/calendar'
import type { Locale } from '../src/core/i18n'

function noMarks(): CalendarMarks {
  return { hasNote: () => false, milestones: () => [] }
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
    const marks: CalendarMarks = { hasNote: (d) => d === '2026-07-10', milestones: () => [] }
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US', marks, onPick: () => {} })

    expect(dayButtonFor(root, 10).classList.contains('tt-calendar-day-has-note')).toBe(true)
    expect(dayButtonFor(root, 11).classList.contains('tt-calendar-day-has-note')).toBe(false)
  })

  test('milestones(day) renders a 🚩 flag with a title of the joined milestone titles', () => {
    const marks: CalendarMarks = {
      hasNote: () => false,
      milestones: (d) => (d === '2026-07-20' ? ['Launch', 'Freeze'] : []),
    }
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US', marks, onPick: () => {} })

    const flag = dayButtonFor(root, 20).querySelector('.tt-calendar-flag')
    expect(flag).not.toBeNull()
    expect(flag!.textContent).toBe('🚩')
    expect(flag!.getAttribute('title')).toBe('Launch, Freeze')
    expect(dayButtonFor(root, 21).querySelector('.tt-calendar-flag')).toBeNull()
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

describe('createCalendar onPick', () => {
  test('clicking a day invokes onPick with that day\'s ISO date', () => {
    const picks: string[] = []
    const root = createCalendar({ selected: '2026-07-01', locale: 'en-US' as Locale, marks: noMarks(), onPick: (d) => picks.push(d) })

    dayButtonFor(root, 22).click()

    expect(picks).toEqual(['2026-07-22'])
  })
})
