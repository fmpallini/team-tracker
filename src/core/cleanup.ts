// src/core/cleanup.ts — cross-team data cleanup for the Prefs → Data tab
// (src/ui/prefs.ts). In one pass across every team it removes: done/cancelled
// action items and closed risks regardless of age (neither has a single date
// to gauge age by), plus the two things that do carry a date — completed
// milestones and daily notes — once that date is older than a user-chosen
// number of days.
import type { Doc } from './types'
import { diffDays } from './date'
import { unlinkRefsInTeam } from './refs'

export interface CleanupCounts {
  actions: number
  milestones: number
  risks: number
  dailyNotes: number
}

/** True when a date is strictly more than `days` days before `today` — the shared age test for daily notes and completed milestones. */
function isOlderThan(date: string, days: number, today: string): boolean {
  return diffDays(today, date) > days
}

export function countCleanupTargets(doc: Doc, days: number, today: string): CleanupCounts {
  const counts: CleanupCounts = { actions: 0, milestones: 0, risks: 0, dailyNotes: 0 }
  for (const team of doc.teams) {
    for (const a of team.actionItems) {
      if (a.status === 'done' || a.status === 'cancelled') counts.actions++
    }
    for (const m of team.milestones) {
      if (m.done && isOlderThan(m.date, days, today)) counts.milestones++
    }
    for (const r of team.risks) {
      if (r.closed) counts.risks++
    }
    for (const date of Object.keys(team.dailyNotes)) {
      if (isOlderThan(date, days, today)) counts.dailyNotes++
    }
  }
  return counts
}

export function applyCleanup(doc: Doc, days: number, today: string): void {
  for (const team of doc.teams) {
    // Same unlink-before-delete step the single-item delete call sites use
    // (people-tree.ts/action-items.ts/milestones.ts/risks.ts) — otherwise a
    // purged item leaves dangling @mentions elsewhere in the team pointing at
    // nothing. Daily notes need no equivalent: a `day:` mention resolves from
    // its date, not from the note's existence, so deleting the note can't
    // dangle a mention (see refs.ts's header comment).
    const removedActions = new Map(team.actionItems.filter((a) => a.status === 'done' || a.status === 'cancelled').map((a) => [a.id, a.summary]))
    unlinkRefsInTeam(team, 'action', removedActions)
    team.actionItems = team.actionItems.filter((a) => a.status !== 'done' && a.status !== 'cancelled')

    const isPurgeableMilestone = (m: { done: boolean; date: string }): boolean => m.done && isOlderThan(m.date, days, today)
    const removedMilestones = new Map(team.milestones.filter(isPurgeableMilestone).map((m) => [m.id, m.title]))
    unlinkRefsInTeam(team, 'milestone', removedMilestones)
    team.milestones = team.milestones.filter((m) => !isPurgeableMilestone(m))

    const removedRisks = new Map(team.risks.filter((r) => r.closed).map((r) => [r.id, r.title]))
    unlinkRefsInTeam(team, 'risk', removedRisks)
    team.risks = team.risks.filter((r) => !r.closed)

    for (const date of Object.keys(team.dailyNotes)) {
      if (isOlderThan(date, days, today)) delete team.dailyNotes[date]
    }
  }
}
