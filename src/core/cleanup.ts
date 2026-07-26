// src/core/cleanup.ts — cross-team data cleanup for the Prefs → Data tab
// (src/ui/prefs.ts). Removes terminal-state action items/milestones/risks
// (regardless of age) and daily notes older than a user-chosen number of
// days, across every team in the document in one pass.
import type { Doc } from './types'
import { diffDays } from './date'

export interface CleanupCounts {
  actions: number
  milestones: number
  risks: number
  dailyNotes: number
}

/** True when a daily-note date is strictly more than `days` days before `today`. */
function isStaleDailyNote(date: string, days: number, today: string): boolean {
  return diffDays(today, date) > days
}

export function countCleanupTargets(doc: Doc, days: number, today: string): CleanupCounts {
  const counts: CleanupCounts = { actions: 0, milestones: 0, risks: 0, dailyNotes: 0 }
  for (const team of doc.teams) {
    for (const a of team.actionItems) {
      if (a.status === 'done' || a.status === 'cancelled') counts.actions++
    }
    for (const m of team.milestones) {
      if (m.done) counts.milestones++
    }
    for (const r of team.risks) {
      if (r.closed) counts.risks++
    }
    for (const date of Object.keys(team.dailyNotes)) {
      if (isStaleDailyNote(date, days, today)) counts.dailyNotes++
    }
  }
  return counts
}

export function applyCleanup(doc: Doc, days: number, today: string): void {
  for (const team of doc.teams) {
    team.actionItems = team.actionItems.filter((a) => a.status !== 'done' && a.status !== 'cancelled')
    team.milestones = team.milestones.filter((m) => !m.done)
    team.risks = team.risks.filter((r) => !r.closed)
    for (const date of Object.keys(team.dailyNotes)) {
      if (isStaleDailyNote(date, days, today)) delete team.dailyNotes[date]
    }
  }
}
