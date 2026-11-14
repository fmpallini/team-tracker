// src/core/cadence.ts — the 1:1 cadence rule: how often a person is due a 1:1
// and the date it falls due. Pure, shared by core/due.ts (badges, due panel,
// fast switch) and the people UI, so they can never disagree.
//
// Both inputs are persisted in a file a user may hand-edit (plain `.tmv`), so
// every read is guarded: a malformed value is treated as absent and a person
// with an unreadable `lastOneOnOne` is simply never due. Nothing here throws.
import type { Person, Prefs } from './types'
import { addDaysIso } from './date'

export type PersonGroup = 'stakeholders' | 'members'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** An integer 1..365 — the only values a cadence may take. */
export function isCadence(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365
}

/** A real calendar date: `2026-02-31` matches the shape but rolls over, so it fails the round trip. */
export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE.test(v) && addDaysIso(v, 0) === v
}

/** The cadence a person of this group gets when they have none of their own: the members' preference, nothing for stakeholders. */
export function defaultCadenceDays(group: PersonGroup, prefs: Prefs): number | null {
  if (group !== 'members') return null
  return isCadence(prefs.oneOnOneDefaultDays) ? prefs.oneOnOneDefaultDays : null
}

/**
 * Days between 1:1s for this person, or null when none is wanted. The
 * person's own `oneOnOneEveryDays` wins (null = none); when absent (or
 * malformed) members follow `prefs.oneOnOneDefaultDays` (0 = none) and
 * stakeholders have no default.
 */
export function effectiveCadenceDays(person: Person, group: PersonGroup, prefs: Prefs): number | null {
  const own = person.oneOnOneEveryDays
  if (own === null) return null
  if (isCadence(own)) return own
  return defaultCadenceDays(group, prefs)
}

/** When the next 1:1 falls due: the last one plus the cadence; null if never held (nothing to count from) or no cadence. */
export function oneOnOneDueDate(person: Person, group: PersonGroup, prefs: Prefs): string | null {
  if (!isIsoDate(person.lastOneOnOne)) return null
  const days = effectiveCadenceDays(person, group, prefs)
  return days === null ? null : addDaysIso(person.lastOneOnOne, days)
}
