import { pad2, addDaysIso, diffDays, formatHHMM, nowHHMM, isWithinTwoMonthWindow } from '../src/core/date'

describe('pad2', () => {
  test('pads single digits, leaves two-plus digits alone', () => {
    expect(pad2(0)).toBe('00')
    expect(pad2(9)).toBe('09')
    expect(pad2(10)).toBe('10')
    expect(pad2(23)).toBe('23')
  })
})

describe('addDaysIso', () => {
  test('adds and subtracts days within a month', () => {
    expect(addDaysIso('2026-07-15', 5)).toBe('2026-07-20')
    expect(addDaysIso('2026-07-15', -5)).toBe('2026-07-10')
  })

  test('rolls over month/year boundaries', () => {
    expect(addDaysIso('2026-07-30', 5)).toBe('2026-08-04')
    expect(addDaysIso('2026-12-30', 5)).toBe('2027-01-04')
  })
})

describe('diffDays', () => {
  test('whole days between two ISO dates', () => {
    expect(diffDays('2026-07-20', '2026-07-15')).toBe(5)
    expect(diffDays('2026-07-15', '2026-07-20')).toBe(-5)
    expect(diffDays('2026-07-15', '2026-07-15')).toBe(0)
  })

  test('unaffected by local DST transitions (UTC-based math)', () => {
    expect(diffDays('2026-01-01', '2025-12-01')).toBe(31)
  })
})

describe('formatHHMM', () => {
  test('pt-BR: 24h "HH:MM"', () => {
    expect(formatHHMM(0, 0, 'pt-BR')).toBe('00:00')
    expect(formatHHMM(9, 5, 'pt-BR')).toBe('09:05')
    expect(formatHHMM(14, 32, 'pt-BR')).toBe('14:32')
    expect(formatHHMM(23, 59, 'pt-BR')).toBe('23:59')
  })

  test('en-US: 12h "H:MM AM/PM"', () => {
    expect(formatHHMM(0, 0, 'en-US')).toBe('12:00 AM') // midnight
    expect(formatHHMM(9, 5, 'en-US')).toBe('9:05 AM')
    expect(formatHHMM(12, 0, 'en-US')).toBe('12:00 PM') // noon
    expect(formatHHMM(14, 32, 'en-US')).toBe('2:32 PM')
    expect(formatHHMM(23, 59, 'en-US')).toBe('11:59 PM')
  })
})

describe('nowHHMM', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('formats the current wall-clock time per locale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    expect(nowHHMM('pt-BR')).toBe('14:32')
    expect(nowHHMM('en-US')).toBe('2:32 PM')
  })
})

describe('isWithinTwoMonthWindow', () => {
  test('same month as anchor -> true', () => {
    expect(isWithinTwoMonthWindow('2026-07-01', '2026-07-31')).toBe(true)
  })

  test('exactly one month before anchor -> true', () => {
    expect(isWithinTwoMonthWindow('2026-07-15', '2026-06-01')).toBe(true)
  })

  test('one month after anchor -> false', () => {
    expect(isWithinTwoMonthWindow('2026-07-15', '2026-08-01')).toBe(false)
  })

  test('two months before anchor -> false', () => {
    expect(isWithinTwoMonthWindow('2026-07-15', '2026-05-15')).toBe(false)
  })

  test('handles year rollover: December is "one month before" a January anchor', () => {
    expect(isWithinTwoMonthWindow('2026-01-10', '2025-12-25')).toBe(true)
  })

  test('same year/month, different day -> true regardless of day', () => {
    expect(isWithinTwoMonthWindow('2026-07-01', '2026-07-31')).toBe(true)
  })
})
