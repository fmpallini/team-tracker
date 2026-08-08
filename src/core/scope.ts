// src/core/scope.ts — change scoping for store.update(). Pure: no DOM, no
// store import, so it can be unit-tested and reasoned about on its own.

/**
 * The parts of a Doc a mutation can touch. Deliberately coarse — the point is
 * to stop a daily-note keystroke from rebuilding an unrelated kanban board,
 * not to track individual fields.
 */
export type Section =
  | 'notes'
  | 'people'
  | 'actions'
  | 'milestones'
  | 'risks'
  | 'prefs'
  | 'templates'
  | 'teams'

/**
 * What a `store.update()` call changed. Both fields are optional and absence
 * means "unrestricted": `{}` (or a missing scope entirely) affects every
 * listener, which is what keeps every un-migrated call site behaving exactly
 * as it did before scoping existed.
 */
export interface ChangeScope {
  /** Only this team's data changed. Omitted = could be any/all teams. */
  teamId?: string
  /** Only these sections changed. Omitted = could be any section. */
  sections?: readonly Section[]
}

/**
 * Whether a listener watching `sections` of team `teamId` needs to react to a
 * mutation described by `scope`.
 *
 * Conservative by construction: anything unknown (null scope, absent field)
 * resolves to `true`. A false negative would silently show stale UI; a false
 * positive only costs a redundant render, which is the behavior we already
 * had. When in doubt, do not narrow the call site.
 */
export function scopeAffects(
  scope: ChangeScope | null | undefined,
  teamId: string,
  sections: readonly Section[]
): boolean {
  if (!scope) return true
  if (scope.teamId !== undefined && scope.teamId !== teamId) return false
  return scopeTouchesSections(scope, sections)
}

/**
 * The section half of `scopeAffects`, for listeners that span *every* team and
 * so have no `teamId` to match against — the sidebar's team list and due
 * badges above all, which aggregate across the whole document.
 *
 * Deliberately ignores `scope.teamId`: "only team X changed" is still a change
 * this kind of listener has to react to. Same conservative contract as
 * `scopeAffects` otherwise — an absent scope or absent `sections` means yes.
 */
export function scopeTouchesSections(
  scope: ChangeScope | null | undefined,
  sections: readonly Section[]
): boolean {
  if (!scope) return true
  if (scope.sections === undefined) return true
  return scope.sections.some((s) => sections.includes(s))
}
