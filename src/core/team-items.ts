// src/core/team-items.ts — lookup and in-place patching of the id-keyed
// entities a team owns (action items, milestones, risks). The three card
// modules each patch a single field of one entity the same way: find the team,
// find the entity in its collection, mutate it if it's still there, notify with
// a scope. Centralised here so that "if it's gone, do nothing" is stated once.
import type { Doc, Team } from './types'
import type { Store } from './store'
import type { ChangeScope } from './scope'
import { findTeam } from './document'

export type TeamItemCollection = 'actionItems' | 'milestones' | 'risks'

export function findTeamItem<K extends TeamItemCollection>(
  doc: Doc,
  teamId: string,
  collection: K,
  id: string,
): Team[K][number] | undefined {
  const list = findTeam(doc, teamId)?.[collection] as ({ id: string } & Team[K][number])[] | undefined
  return list?.find((e) => e.id === id)
}

/**
 * Runs `mutate` on the entity inside one `store.update`. A missing team or
 * entity (deleted meanwhile) is a silent no-op, but the update — and its
 * notification — still happens, exactly like the hand-written
 * `if (found) found.x = …` blocks this replaces.
 *
 * `scope` is required rather than defaulted: whether a field edit may narrow to
 * `sections` is a per-field decision (a title feeds @mention labels team-wide,
 * so it stays `{ teamId }` — see core/scope.ts).
 */
export function patchTeamItem<K extends TeamItemCollection>(
  store: Store,
  teamId: string,
  collection: K,
  id: string,
  mutate: (item: Team[K][number]) => void,
  scope: ChangeScope,
): void {
  store.update((d) => {
    const found = findTeamItem(d, teamId, collection, id)
    if (found) mutate(found)
  }, scope)
}
