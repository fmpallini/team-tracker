// src/core/due.ts — the app's single "what counts as overdue/active" rule,
// plus pure computation of overdue/due-soon action items and milestones
// (and 1:1s that are due, see cadence.ts) across every team for the sidebar badge/list (src/ui/sidebar.ts). The
// kanban card highlight (src/modules/action-items.ts) imports isOverdue from
// here, so the badge and the board can never disagree on the semantics.
import type { ActionItem, Doc, Loc } from './types'
import { addDaysIso, diffDays } from './date'
import { oneOnOneDueDate } from './cadence'
import { t, type Locale } from './i18n'

export interface DueItem {
  loc: Loc
  title: string
  teamName: string
  teamEmoji: string
  date: string
  kind: 'action' | 'milestone' | 'person'
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

/** "overdue by Nd" before `today`, else "in Nd" (0 on the day itself) — the due panel's and the fast switch's one wording. */
export function dueRelativeLabel(locale: Locale, date: string, today: string): string {
  return date < today
    ? t(locale, 'due_overdue_by', { days: String(diffDays(today, date)) })
    : t(locale, 'due_in_days', { days: String(diffDays(date, today)) })
}

/** What a due badge shows for a team: the item count, and whether any is already late (red) or all still ahead (brass). */
export interface TeamDue {
  count: number
  overdue: boolean
}

export function teamDueSummary(buckets: DueBuckets): Map<string, TeamDue> {
  const out = new Map<string, TeamDue>()
  function add(items: DueItem[], overdue: boolean): void {
    for (const it of items) {
      const cur = out.get(it.loc.teamId) ?? { count: 0, overdue: false }
      cur.count++
      cur.overdue ||= overdue
      out.set(it.loc.teamId, cur)
    }
  }
  add(buckets.overdue, true)
  add(buckets.dueSoon, false)
  return out
}

/** The sidebar modules a due item belongs to: a person's 1:1 counts under People (members) or Stakeholders by their group. */
export type DueModule = 'actions' | 'milestones' | 'members' | 'stakeholders'

/** Per-module overdue / due-soon counts for one team — what the module list's badges show. A module with nothing due has no entry. */
export function moduleDueSummary(buckets: DueBuckets, teamId: string): Map<DueModule, { overdue: number; dueSoon: number }> {
  const out = new Map<DueModule, { overdue: number; dueSoon: number }>()
  function add(items: DueItem[], field: 'overdue' | 'dueSoon'): void {
    for (const it of items) {
      if (it.loc.teamId !== teamId) continue
      const ref = it.loc.ref
      const mod: DueModule = ref.kind === 'person' ? ref.group : it.kind === 'milestone' ? 'milestones' : 'actions'
      const cur = out.get(mod) ?? { overdue: 0, dueSoon: 0 }
      cur[field]++
      out.set(mod, cur)
    }
  }
  add(buckets.overdue, 'overdue')
  add(buckets.dueSoon, 'dueSoon')
  return out
}

/** The text a due row shows: the item's title, except a 1:1, whose title is just the person's name. */
export function dueItemLabel(locale: Locale, item: DueItem): string {
  return item.kind === 'person' ? t(locale, 'due_one_on_one_title', { name: item.title }) : item.title
}

/** Where a due date stands on `today`: late, within the next `dueSoonDays` (today included), or not due yet. One rule for the due list, the badges and the org chart's marks. */
export function dueState(date: string, today: string, dueSoonDays: number): 'overdue' | 'soon' | null {
  if (date < today) return 'overdue'
  return date <= addDaysIso(today, dueSoonDays) ? 'soon' : null
}

export function collectDueItems(doc: Doc, today: string): DueBuckets {
  const overdue: DueItem[] = []
  const dueSoon: DueItem[] = []

  function classify(entry: DueItem): void {
    const state = dueState(entry.date, today, doc.prefs.dueSoonDays)
    if (state === 'overdue') overdue.push(entry)
    else if (state === 'soon') dueSoon.push(entry)
  }

  for (const team of doc.teams) {
    for (const it of team.actionItems) {
      if (!isActionActive(it) || it.dueDate === null) continue
      classify({
        loc: { teamId: team.id, ref: { kind: 'actions', itemId: it.id } },
        title: it.summary, teamName: team.name, teamEmoji: team.emoji, date: it.dueDate, kind: 'action',
      })
    }
    for (const m of team.milestones) {
      if (m.done) continue
      classify({
        loc: { teamId: team.id, ref: { kind: 'milestones', itemId: m.id } },
        title: m.title, teamName: team.name, teamEmoji: team.emoji, date: m.date, kind: 'milestone',
      })
    }
  }

  // 1:1s are due a cadence after the last one; oneOnOneDueDate returns null (never due) for no cadence or an unreadable date.
  for (const team of doc.teams) {
    for (const group of ['members', 'stakeholders'] as const) {
      for (const p of team[group]) {
        const date = oneOnOneDueDate(p, group, doc.prefs)
        if (date === null) continue
        classify({
          loc: { teamId: team.id, ref: { kind: 'person', personId: p.id, group } },
          title: p.name, teamName: team.name, teamEmoji: team.emoji, date, kind: 'person',
        })
      }
    }
  }

  overdue.sort((a, b) => a.date.localeCompare(b.date))
  dueSoon.sort((a, b) => a.date.localeCompare(b.date))
  return { overdue, dueSoon }
}
