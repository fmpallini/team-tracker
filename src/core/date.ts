// src/core/date.ts — single home for ISO-date ("YYYY-MM-DD") and wall-clock
// arithmetic shared across core and the module renderers. Keep every date
// computation here rather than re-implementing per file.
//
// `Locale` is imported type-only from ./i18n, which itself imports `pad2`
// from here — safe because a type-only import is erased at compile time, so
// there's no runtime import cycle.
import type { Locale } from './i18n'

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

/**
 * Wall-clock hours/minutes as locale-formatted text: 24h "HH:MM" for pt-BR,
 * 12h "H:MM AM/PM" for en-US — matching each locale's everyday clock
 * convention, same as formatDate() (src/core/i18n.ts) already does for
 * day/month order. Manual formatting (not Intl) for the same reason the
 * rest of this file avoids Intl: fully deterministic output across
 * platforms/environments, and trivially testable without locale-data quirks.
 */
export function formatHHMM(hours: number, minutes: number, locale: Locale): string {
  if (locale === 'pt-BR') return `${pad2(hours)}:${pad2(minutes)}`
  const period = hours < 12 ? 'AM' : 'PM'
  const h12 = hours % 12 || 12
  return `${h12}:${pad2(minutes)} ${period}`
}

/** Current local wall-clock time, locale-formatted (see formatHHMM). */
export function nowHHMM(locale: Locale): string {
  const now = new Date()
  return formatHHMM(now.getHours(), now.getMinutes(), locale)
}
