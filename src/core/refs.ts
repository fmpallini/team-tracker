// src/core/refs.ts — auto-unlink-on-delete: rewrites @[Label](kind:id) mentions
// back to plain "Label" text when the referenced item is deleted, so a note
// never ends up pointing at something that no longer exists. Called from
// inside the same store.update() as the delete (see the 5 call sites in
// people-tree.ts/action-items.ts/milestones.ts/risks.ts), same-team-scoped
// only — refs never cross teams (src/ui/atref.ts's candidates are already
// team-scoped the same way).
import type { Team } from './types'

export type RefKind = 'person' | 'action' | 'milestone' | 'risk'

export function unlinkRefsInText(text: string, kind: RefKind, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return text
  const re = new RegExp(`@\\[([^\\]]+)\\]\\(${kind}:([^)\\s]+)\\)`, 'g')
  return text.replace(re, (whole: string, label: string, id: string) => (ids.has(id) ? label : whole))
}

export function unlinkRefsInTeam(team: Team, kind: RefKind, ids: string[]): void {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  for (const date of Object.keys(team.dailyNotes)) {
    team.dailyNotes[date] = unlinkRefsInText(team.dailyNotes[date]!, kind, idSet)
  }
  for (const group of ['stakeholders', 'members'] as const) {
    for (const p of team[group]) p.notes = unlinkRefsInText(p.notes, kind, idSet)
  }
  for (const item of team.actionItems) item.notes = unlinkRefsInText(item.notes, kind, idSet)
  for (const m of team.milestones) m.followup = unlinkRefsInText(m.followup, kind, idSet)
  for (const r of team.risks) r.followup = unlinkRefsInText(r.followup, kind, idSet)
}
