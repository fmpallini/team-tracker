// src/core/favorites.ts — pure helpers for Doc.favorites (the pane-bar star and
// the fast switch's Favorites section). A favorite is a team + module location; the
// `itemId` of an actions/milestones/risks ref is dropped, so one opens the
// module, not a card. No DOM, no store: callers wrap mutations in store.update.
import type { Doc, Favorite, Loc, ModuleRef } from './types'
import { findTeam } from './document'

/** The ref a favorite stores: `itemId` removed, everything else kept. */
export function normalizeRef(ref: ModuleRef): ModuleRef {
  switch (ref.kind) {
    case 'daily': return { kind: 'daily', date: ref.date }
    case 'person': return { kind: 'person', personId: ref.personId, group: ref.group }
    case 'general': return { kind: 'general' }
    case 'stakeholders': return { kind: 'stakeholders' }
    case 'members': return { kind: 'members' }
    case 'actions': return { kind: 'actions' }
    case 'milestones': return { kind: 'milestones' }
    case 'risks': return { kind: 'risks' }
  }
}

/** The single place that decides whether two locations are "the same favorite". */
export function favoriteKey(loc: Loc): string {
  const r = loc.ref
  const detail = r.kind === 'daily' ? r.date : r.kind === 'person' ? r.personId : ''
  return `${loc.teamId}|${r.kind}|${detail}`
}

export function isFavorite(doc: Doc, loc: Loc): boolean {
  const key = favoriteKey(loc)
  return doc.favorites.some((f) => favoriteKey(f) === key)
}

/** Adds the location if absent, removes it if present. Returns whether it is now a favorite. Mutates `doc` — call inside `store.update`. */
export function toggleFavorite(doc: Doc, loc: Loc): boolean {
  const key = favoriteKey(loc)
  const at = doc.favorites.findIndex((f) => favoriteKey(f) === key)
  if (at !== -1) {
    doc.favorites.splice(at, 1)
    return false
  }
  doc.favorites.push({ teamId: loc.teamId, ref: normalizeRef(loc.ref) })
  return true
}

/**
 * Whether a favorite points at something that no longer exists: its team is
 * gone, or it is a person favorite whose person is gone. Ids are never
 * reused, so such an entry is inert; it is hidden from the fast switch (liveFavorites)
 * and removed for good by the Prefs → Data cleanup (core/cleanup.ts).
 */
export function isFavoriteOrphaned(doc: Doc, fav: Favorite): boolean {
  const team = findTeam(doc, fav.teamId)
  if (!team) return true
  const r = fav.ref
  if (r.kind === 'person') {
    // Belt and braces: validateDoc rejects a bad group, but a render path must never throw.
    const list: unknown = team[r.group]
    if (!Array.isArray(list)) return true
    return !(list as { id: string }[]).some((p) => p.id === r.personId)
  }
  return false
}

export function liveFavorites(doc: Doc): Favorite[] {
  return doc.favorites.filter((f) => !isFavoriteOrphaned(doc, f))
}
