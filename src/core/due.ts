// src/core/due.ts — pure computation of overdue/due-soon action items and
// milestones across every team, for the sidebar badge/list (src/ui/sidebar.ts).
// Deliberately independent of src/modules/action-items.ts's own isOverdue
// (same "date < today, not done/cancelled" semantics) — core/ must not
// depend on modules/.
import type { Doc, Loc } from './types'

export interface DueItem {
  loc: Loc
  title: string
  teamName: string
  date: string
  kind: 'action' | 'milestone'
}

export interface DueBuckets {
  overdue: DueItem[]
  dueSoon: DueItem[]
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

export function collectDueItems(doc: Doc, today: string): DueBuckets {
  const cutoff = addDaysIso(today, doc.prefs.dueSoonDays)
  const overdue: DueItem[] = []
  const dueSoon: DueItem[] = []

  function classify(entry: DueItem): void {
    if (entry.date < today) overdue.push(entry)
    else if (entry.date <= cutoff) dueSoon.push(entry)
  }

  for (const team of doc.teams) {
    for (const it of team.actionItems) {
      if (it.status === 'done' || it.status === 'cancelled') continue
      if (it.dueDate === null) continue
      classify({
        loc: { teamId: team.id, ref: { kind: 'actions', itemId: it.id } },
        title: it.summary, teamName: team.name, date: it.dueDate, kind: 'action',
      })
    }
    for (const m of team.milestones) {
      if (m.done) continue
      classify({
        loc: { teamId: team.id, ref: { kind: 'milestones', itemId: m.id } },
        title: m.title, teamName: team.name, date: m.date, kind: 'milestone',
      })
    }
  }

  overdue.sort((a, b) => a.date.localeCompare(b.date))
  dueSoon.sort((a, b) => a.date.localeCompare(b.date))
  return { overdue, dueSoon }
}
