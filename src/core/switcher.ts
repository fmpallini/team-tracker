// src/core/switcher.ts — pure model of the fast switch (ui/palette.ts): four
// sections (Favorites → Due dates → Current team → Other teams), matching,
// dedupe and the 20-row allocation. No DOM, no store: callers pass the Doc.
// ui/palette.ts only renders what this returns.
import type { Doc, Favorite, ModuleRef } from './types'
import { findTeam } from './document'
import { t, type Locale } from './i18n'
import { diffDays } from './date'
import { collectDueItems } from './due'
import { favoriteKey, liveFavorites } from './favorites'
import { buildModuleItems, titleFor } from './module-items'
import { KIND_ICON, normalize } from './search'

export const SWITCHER_MAX_ROWS = 20
export const SWITCHER_MIN_PER_SECTION = 4

export interface SwitcherRow {
  /** Icon + title, e.g. "⚠️ Vendor delay". */
  label: string
  teamId: string
  ref: ModuleRef
  /** "🅱️ Beta" — favorites, due and other-team rows only (the current team's heading already names it). */
  teamBadge?: string
  /** Due rows only, e.g. "overdue by 6d". */
  dueLabel?: string
  /** Favorite rows only: what the row's ✕ removes. */
  favorite?: Favorite
}

export type SwitcherSectionId = 'favorites' | 'due' | 'current' | 'others'

export interface SwitcherSection {
  id: SwitcherSectionId
  heading: string
  /** Matches before the row cap; `rows.length <= total`. */
  total: number
  rows: SwitcherRow[]
}

/**
 * How many rows each section shows. Every section gets `min(count, min)`; the
 * remaining slots go out in round-robin passes in section order, one row per
 * section per pass, until `max` rows are used or nothing is left to show.
 * (4 sections × the default minimum of 4 is 16, so the minimums always fit.)
 */
export function allocateRows(counts: readonly number[], max = SWITCHER_MAX_ROWS, min = SWITCHER_MIN_PER_SECTION): number[] {
  const shown = counts.map((c) => Math.min(c, min))
  let left = max - shown.reduce((a, b) => a + b, 0)
  while (left > 0) {
    let gave = false
    for (let i = 0; i < counts.length && left > 0; i++) {
      if (shown[i]! < counts[i]!) {
        shown[i] = shown[i]! + 1
        left--
        gave = true
      }
    }
    if (!gave) break
  }
  return shown
}

function queryWords(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean)
}

/** Every word must appear in "<team name> <row title>", so "alpha risks" narrows to one team's Risks. */
function matches(words: string[], teamName: string, label: string): boolean {
  if (words.length === 0) return true
  const hay = normalize(`${teamName} ${label}`)
  return words.every((w) => hay.includes(w))
}

function hasItemId(ref: ModuleRef): boolean {
  return 'itemId' in ref && ref.itemId !== undefined
}

function badge(team: { emoji: string; name: string }): string {
  return `${team.emoji} ${team.name}`.trim()
}

export function buildSwitcher(doc: Doc, query: string, locale: Locale, today: string): SwitcherSection[] {
  const words = queryWords(query)
  const active = doc.nav.activeTeamId === null ? undefined : findTeam(doc, doc.nav.activeTeamId)

  // 1. Favorites (live ones only; the order they were starred).
  const favRows: SwitcherRow[] = []
  for (const fav of liveFavorites(doc)) {
    const team = findTeam(doc, fav.teamId)
    if (!team) continue
    const label = `${KIND_ICON[fav.ref.kind]} ${titleFor(doc, fav, locale)}`
    if (!matches(words, team.name, label)) continue
    favRows.push({ label, teamId: fav.teamId, ref: fav.ref, teamBadge: badge(team), favorite: fav })
  }

  // 2. Due dates: overdue first, then due soon (collectDueItems already sorts each bucket).
  const buckets = collectDueItems(doc, today)
  const dueRows: SwitcherRow[] = []
  for (const item of [...buckets.overdue, ...buckets.dueSoon]) {
    const team = findTeam(doc, item.loc.teamId)
    if (!team) continue
    const label = `${KIND_ICON[item.loc.ref.kind]} ${item.title}`
    if (!matches(words, team.name, label)) continue
    const dueLabel = item.date < today
      ? t(locale, 'due_overdue_by', { days: String(diffDays(today, item.date)) })
      : t(locale, 'due_in_days', { days: String(diffDays(item.date, today)) })
    dueRows.push({ label, teamId: item.loc.teamId, ref: item.loc.ref, teamBadge: badge(team), dueLabel })
  }

  // 3. Current team (before dedupe — see the allocation loop below).
  const currentMatches: SwitcherRow[] = []
  if (active) {
    for (const item of buildModuleItems(active, locale)) {
      if (!matches(words, active.name, item.label)) continue
      currentMatches.push({ label: item.label, teamId: active.id, ref: item.ref })
    }
  }

  // 4. Other teams: only once there is a query (or when no team is active, so the box is never blank).
  const otherRows: SwitcherRow[] = []
  if (words.length > 0 || !active) {
    for (const team of doc.teams) {
      if (team.id === active?.id) continue
      for (const item of buildModuleItems(team, locale)) {
        if (!matches(words, team.name, item.label)) continue
        otherRows.push({ label: item.label, teamId: team.id, ref: item.ref, teamBadge: badge(team) })
      }
    }
  }

  // A module-level Current-team row is dropped only when its favorite twin is
  // actually SHOWN — a favorite cut by the cap must not make the place vanish
  // from both sections. Card rows (with an itemId) are never dropped: a
  // favorite opens the module, not a card. Dedupe changes Current's count and
  // the cap depends on counts, so iterate: start by assuming every matching
  // favorite shows, then shrink to the share the allocation really gives
  // Favorites. That share only ever shrinks (a twin coming back lengthens
  // Current, which can only compete for the leftover slots), so it settles
  // within favRows.length + 2 passes.
  let favShown = favRows.length
  let currentRows: SwitcherRow[] = []
  let shown: number[] = []
  for (let pass = 0; pass <= favRows.length + 1; pass++) {
    const favKeys = new Set(favRows.slice(0, favShown).map((r) => favoriteKey(r)))
    currentRows = currentMatches.filter((r) => hasItemId(r.ref) || !favKeys.has(favoriteKey(r)))
    shown = allocateRows([favRows.length, dueRows.length, currentRows.length, otherRows.length])
    if (shown[0] === favShown) break
    favShown = shown[0]!
  }

  const all: { id: SwitcherSectionId; heading: string; rows: SwitcherRow[] }[] = [
    { id: 'favorites', heading: `⭐ ${t(locale, 'switcher_favorites')}`, rows: favRows },
    { id: 'due', heading: `⏰ ${t(locale, 'switcher_due')}`, rows: dueRows },
    { id: 'current', heading: active ? badge(active) : '', rows: currentRows },
    { id: 'others', heading: `🗂️ ${t(locale, 'switcher_others')}`, rows: otherRows },
  ]
  return all
    .map((s, i) => ({ id: s.id, heading: s.heading, total: s.rows.length, rows: s.rows.slice(0, shown[i]) }))
    .filter((s) => s.total > 0)
}
