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

// Characters mdToHtml's inline() parser treats specially — sanitized so a
// title can never reactivate markdown formatting (or spoof another mention)
// once wrapped as a plain former-reference marker below: `*` (bold/italic),
// `~` (strike, and our own marker's own delimiter), `<`/`>` (the
// `&lt;u&gt;`→`<u>` underline escape-hatch), and `@`/`[`/`]`/`(`/`)`
// (ref-mention syntax — replacing any one of these breaks the combination
// refPattern() requires, so all five are covered individually rather than
// trying to match the exact mention shape).
const MD_SPECIAL_CHARS = /[*~<>@[\]()]/g

function sanitizeForUnlinkMarker(title: string): string {
  return title.replace(MD_SPECIAL_CHARS, '_')
}

// `titles` maps each deleted item's id to its *current* title, not whatever
// label was typed into the mention at creation time — a mention's stored
// label goes stale on rename (rendering always resolves the live title
// instead, so this staleness is normally invisible; see markdown.ts's
// `inline()`), and this is the one path where that frozen fallback would
// otherwise leak a pre-rename name into the note as plain text.
//
// The replacement is wrapped in single tildes (`~Title~`) — a marker
// mdToHtml renders as muted italic text (see markdown.ts's `.tt-unlinked-ref`
// rule) so a note keeps a visual trace that this text used to be a live
// reference, even though the target is gone and there's nothing left to
// link to.
function unlinkWithPattern(text: string, re: RegExp, prefixLen: number, titles: ReadonlyMap<string, string>): string {
  return text.replace(re, (whole: string, _label: string, ref: string) => {
    const title = titles.get(ref.slice(prefixLen))
    return title !== undefined ? `~${sanitizeForUnlinkMarker(title)}~` : whole
  })
}

export function unlinkRefsInText(text: string, kind: IdRefKind, titles: ReadonlyMap<string, string>): string {
  if (titles.size === 0) return text
  return unlinkWithPattern(text, refPattern(kind), kind.length + 1, titles)
}

export function unlinkRefsInTeam(team: Team, kind: IdRefKind, titles: ReadonlyMap<string, string>): void {
  if (titles.size === 0) return
  // One regex compile for the whole team sweep (String.replace resets lastIndex per call).
  const re = refPattern(kind)
  const prefixLen = kind.length + 1
  const unlink = (text: string): string => unlinkWithPattern(text, re, prefixLen, titles)
  for (const date of Object.keys(team.dailyNotes)) {
    team.dailyNotes[date] = unlink(team.dailyNotes[date]!)
  }
  team.generalNotes = unlink(team.generalNotes ?? '')
  for (const group of ['stakeholders', 'members'] as const) {
    for (const p of team[group]) p.notes = unlink(p.notes)
  }
  for (const item of team.actionItems) item.notes = unlink(item.notes)
  for (const m of team.milestones) m.followup = unlink(m.followup)
  for (const r of team.risks) r.followup = unlink(r.followup)
}

/**
 * Unconditionally flattens every @[label](kind:id) mention in `text` to its
 * plain label — unlike unlinkRefsInText/unlinkRefsInTeam, which only rewrite
 * mentions pointing at specific deleted ids. Used when a card's free-text
 * field moves to a *different* team (Task 2's card-transfer.ts): the ids it
 * mentions belong to the source team and are meaningless (or collide) in the
 * destination, so every mention — not just dangling ones — must lose its
 * link and become ordinary prose.
 */
export function stripAllRefs(text: string): string {
  return text.replace(refPattern(), (_, label: string) => label)
}
