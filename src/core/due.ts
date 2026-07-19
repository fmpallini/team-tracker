// src/core/due.ts — the app's single "what counts as overdue/active" rule,
// plus pure computation of overdue/due-soon action items and milestones
// across every team for the sidebar badge/list (src/ui/sidebar.ts). The
// kanban card highlight (src/modules/action-items.ts) imports isOverdue from
// here, so the badge and the board can never disagree on the semantics.
import type { ActionItem, Doc, Loc } from './types'
import { addDaysIso } from './date'

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

/** An item still in play — not landed in a terminal status. */
export function isActionActive(item: Pick<ActionItem, 'status'>): boolean {
  return item.status !== 'done' && item.status !== 'cancelled'
}

/** True when the item has a due date strictly before `today` and is still active. */
export function isOverdue(item: Pick<ActionItem, 'dueDate' | 'status'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && isActionActive(item)
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
      if (!isActionActive(it) || it.dueDate === null) continue
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
