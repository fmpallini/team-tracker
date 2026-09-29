import type { Loc, PaneState } from './types'

const HISTORY_CAP = 50

export function locsConflict(a: Loc, b: Loc | null): boolean {
  if (b === null) return false
  if (a.ref.kind !== b.ref.kind) return false
  if (a.teamId !== b.teamId) return false
  if (a.ref.kind === 'daily' && b.ref.kind === 'daily') return a.ref.date === b.ref.date
  if (a.ref.kind === 'person' && b.ref.kind === 'person') return a.ref.personId === b.ref.personId
  return true
}

export function sameLoc(a: Loc, b: Loc | null): boolean {
  if (b === null) return false
  if (a.teamId !== b.teamId) return false
  if (a.ref.kind !== b.ref.kind) return false
  if (a.ref.kind === 'daily' && b.ref.kind === 'daily') return a.ref.date === b.ref.date
  if (a.ref.kind === 'person' && b.ref.kind === 'person') {
    return a.ref.personId === b.ref.personId && a.ref.group === b.ref.group
  }
  return true
}

export function currentLoc(p: PaneState): Loc | null {
  if (p.index < 0) return null
  return p.history[p.index] ?? null
}

/** The most recent Loc this pane held for `teamId` — i.e. "what this pane last showed for this team" — or null if this pane never had that team open. Used to restore a team's per-pane last-used module on switching back to it. */
export function lastLocForTeam(pane: PaneState, teamId: string): Loc | null {
  for (let i = pane.history.length - 1; i >= 0; i--) {
    const loc = pane.history[i]
    if (loc && loc.teamId === teamId) return loc
  }
  return null
}

export type OpenResult = { type: 'opened'; pane: PaneState } | { type: 'focusOther' }

export function openLoc(pane: PaneState, target: Loc, otherCurrent: Loc | null): OpenResult {
  const current = currentLoc(pane)
  if (current !== null && sameLoc(target, current)) {
    return { type: 'opened', pane }
  }
  if (locsConflict(target, otherCurrent)) {
    return { type: 'focusOther' }
  }
  // Opening something new discards the "forward" tail — but only the target
  // team's part of it. History is walked per team (see `navigateHistory`), so
  // another team's entries sitting ahead of `index` are not this team's
  // forward stack; dropping them would also lose that team's last-used module
  // in this pane (`lastLocForTeam`).
  const kept = pane.history.filter((loc, i) => i <= pane.index || loc.teamId !== target.teamId)
  let newHistory = [...kept, target]
  let newIndex = newHistory.length - 1
  if (newHistory.length > HISTORY_CAP) {
    const drop = newHistory.length - HISTORY_CAP
    newHistory = newHistory.slice(drop)
    newIndex -= drop
  }
  return { type: 'opened', pane: { history: newHistory, index: newIndex } }
}

/**
 * Whether `loc` is a place this pane's history walk may land on from `cur`:
 * same team as the scope, not the spot it is already on (team switches push a
 * repeat of the pane's last location, so `[A, B, C | other team | C]` must not
 * offer the first C as a step), and not the other pane's module.
 */
export function steppable(loc: Loc, teamId: string, cur: Loc | null, otherCurrent: Loc | null): boolean {
  return loc.teamId === teamId && !sameLoc(loc, cur) && !locsConflict(loc, otherCurrent)
}

/**
 * One history step (back/forward) within `teamId`'s entries only — history is
 * per team even though the array is shared, so ◀/▶ never lands on another
 * team's location. `teamId` null (no active team) means nothing to walk.
 */
export function navigateHistory(pane: PaneState, dir: -1 | 1, otherCurrent: Loc | null, teamId: string | null): PaneState | null {
  if (teamId === null) return null
  const cur = currentLoc(pane)
  for (let i = pane.index + dir; i >= 0 && i < pane.history.length; i += dir) {
    const loc = pane.history[i]
    if (loc !== undefined && steppable(loc, teamId, cur, otherCurrent)) {
      return { history: pane.history, index: i }
    }
  }
  return null
}

/** Index of the newest history entry ahead of `pane.index` that `navigateHistory` could reach for `teamId`, or -1 if none — what "jump to latest" lands on. */
export function latestReachableIndex(pane: PaneState, otherCurrent: Loc | null, teamId: string | null): number {
  if (teamId === null) return -1
  const cur = currentLoc(pane)
  for (let i = pane.history.length - 1; i > pane.index; i--) {
    const loc = pane.history[i]
    if (loc !== undefined && steppable(loc, teamId, cur, otherCurrent)) return i
  }
  return -1
}

export interface HistoryEntry {
  index: number
  loc: Loc
  current: boolean
}

/**
 * The `teamId` entries the pane could be on, newest first, for the history
 * list. The current entry is always present; others only if they don't
 * conflict with `otherCurrent`. Consecutive repeats of one location (what a
 * team switch away and back leaves behind) collapse into one row, keeping the
 * current entry as that row's representative when it is part of the run.
 */
export function reachableHistory(pane: PaneState, otherCurrent: Loc | null, teamId: string | null): HistoryEntry[] {
  if (teamId === null) return []
  const chronological: HistoryEntry[] = []
  pane.history.forEach((loc, index) => {
    const current = index === pane.index
    if (loc.teamId !== teamId) return
    if (!current && locsConflict(loc, otherCurrent)) return
    const prev = chronological[chronological.length - 1]
    if (prev && sameLoc(loc, prev.loc)) {
      if (current) chronological[chronological.length - 1] = { index, loc, current }
      else if (!prev.current) chronological[chronological.length - 1] = { index, loc, current }
      return
    }
    chronological.push({ index, loc, current })
  })
  return chronological.reverse()
}
