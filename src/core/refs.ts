// src/core/refs.ts — the @-mention ref vocabulary, plus auto-unlink-on-delete.
//
// REF_KINDS is the single registry of every referenceable kind. The mention
// regexes here and in core/markdown.ts, the @ picker's group headers/icons
// (src/ui/atref.ts), and the ref-kind → pane-module mapping are all derived
// from it — adding a kind means one entry here plus rendering support, not
// parallel regex/table edits across five files.
//
// Auto-unlink rewrites @[Label](kind:id) mentions back to plain "Label" text
// when the referenced item is deleted, so a note never ends up pointing at
// something that no longer exists. Called from inside the same store.update()
// as the delete (see the 5 call sites in people-tree.ts/action-items.ts/
// milestones.ts/risks.ts), same-team-scoped only — refs never cross teams
// (src/ui/atref.ts's candidates are already team-scoped the same way).
import type { ModuleRef, Team } from './types'
import type { MsgKey } from './i18n'

interface RefKindSpec {
  /** Regex source for the target after the "kind:" prefix in @[label](kind:target). */
  targetPattern: string
  /** The pane module that opens this ref — also keys core/search.ts's KIND_ICON. */
  moduleKind: ModuleRef['kind']
  /** i18n key for the @ picker's group header. */
  headerKey: MsgKey
}

export const REF_KINDS = {
  person: { targetPattern: '[^)\\s]+', moduleKind: 'person', headerKey: 'atref_group_people' },
  day: { targetPattern: '\\d{4}-\\d{2}-\\d{2}', moduleKind: 'daily', headerKey: 'atref_group_dates' },
  action: { targetPattern: '[^)\\s]+', moduleKind: 'actions', headerKey: 'module_actions' },
  milestone: { targetPattern: '[^)\\s]+', moduleKind: 'milestones', headerKey: 'module_milestones' },
  risk: { targetPattern: '[^)\\s]+', moduleKind: 'risks', headerKey: 'module_risks' },
} as const satisfies Record<string, RefKindSpec>

export type RefKind = keyof typeof REF_KINDS
export const REF_KIND_LIST = Object.keys(REF_KINDS) as RefKind[]

/** Ref kinds whose target is an item id — everything but 'day', whose target is a date. */
export type IdRefKind = Exclude<RefKind, 'day'>

/**
 * Regex over one @[label](kind:target) mention: group 1 is the label, group 2
 * the full "kind:target". Pass `kind` to narrow to a single kind. Returns a
 * fresh instance per call — the global flag makes instances stateful.
 */
export function refPattern(kind?: RefKind): RegExp {
  const kinds = kind ? [kind] : REF_KIND_LIST
  const alternatives = kinds.map((k) => `${k}:${REF_KINDS[k].targetPattern}`).join('|')
  return new RegExp(`@\\[([^\\]]+)\\]\\((${alternatives})\\)`, 'g')
}

function unlinkWithPattern(text: string, re: RegExp, prefixLen: number, ids: ReadonlySet<string>): string {
  return text.replace(re, (whole: string, label: string, ref: string) => (ids.has(ref.slice(prefixLen)) ? label : whole))
}

export function unlinkRefsInText(text: string, kind: IdRefKind, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return text
  return unlinkWithPattern(text, refPattern(kind), kind.length + 1, ids)
}

export function unlinkRefsInTeam(team: Team, kind: IdRefKind, ids: string[]): void {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  // One regex compile for the whole team sweep (String.replace resets lastIndex per call).
  const re = refPattern(kind)
  const prefixLen = kind.length + 1
  const unlink = (text: string): string => unlinkWithPattern(text, re, prefixLen, idSet)
  for (const date of Object.keys(team.dailyNotes)) {
    team.dailyNotes[date] = unlink(team.dailyNotes[date]!)
  }
  for (const group of ['stakeholders', 'members'] as const) {
    for (const p of team[group]) p.notes = unlink(p.notes)
  }
  for (const item of team.actionItems) item.notes = unlink(item.notes)
  for (const m of team.milestones) m.followup = unlink(m.followup)
  for (const r of team.risks) r.followup = unlink(r.followup)
}
