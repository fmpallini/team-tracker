// src/core/date.ts — single home for ISO-date ("YYYY-MM-DD") and wall-clock
// arithmetic shared across core and the module renderers. Keep every date
// computation here rather than re-implementing per file.

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** ISO date `days` away from `iso`; month/year rollover handled by Date. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

/** Whole days from `earlier` to `later` (both ISO dates); UTC math so DST transitions can't skew the count. */
export function diffDays(later: string, earlier: string): number {
  const [ly, lm, ld] = later.split('-').map(Number) as [number, number, number]
  const [ey, em, ed] = earlier.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / 86400000)
}

/** Current local wall-clock time as "HH:MM". */
export function nowHHMM(): string {
  const now = new Date()
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}
