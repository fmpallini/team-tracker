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
  const truncated = pane.history.slice(0, pane.index + 1)
  let newHistory = [...truncated, target]
  let newIndex = newHistory.length - 1
  if (newHistory.length > HISTORY_CAP) {
    const drop = newHistory.length - HISTORY_CAP
    newHistory = newHistory.slice(drop)
    newIndex -= drop
  }
  return { type: 'opened', pane: { history: newHistory, index: newIndex } }
}

export function navigateHistory(pane: PaneState, dir: -1 | 1, otherCurrent: Loc | null): PaneState | null {
  for (let i = pane.index + dir; i >= 0 && i < pane.history.length; i += dir) {
    const loc = pane.history[i]
    if (loc === undefined) continue
    if (!locsConflict(loc, otherCurrent)) {
      return { history: pane.history, index: i }
    }
  }
  return null
}
