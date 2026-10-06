import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { favoriteKey, normalizeRef, isFavorite, toggleFavorite, isFavoriteOrphaned, liveFavorites } from '../src/core/favorites'
import type { Doc, Favorite, Loc } from '../src/core/types'

function docWithTeam(): Doc {
  const d = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Alpha', '🚀', 'en-US')
  team.members.push({ id: 'p1', name: 'Ann', role: '', parentId: null, order: 0, notes: '' })
  team.stakeholders.push({ id: 's1', name: 'Bo', role: '', parentId: null, order: 0, notes: '' })
  d.teams.push(team)
  return d
}

const risks: Loc = { teamId: 'T1', ref: { kind: 'risks' } }
const ann: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } }
const day: Loc = { teamId: 'T1', ref: { kind: 'daily', date: '2026-10-06' } }

describe('normalizeRef', () => {
  test('strips itemId from actions, milestones and risks', () => {
    expect(normalizeRef({ kind: 'actions', itemId: 'a1' })).toEqual({ kind: 'actions' })
    expect(normalizeRef({ kind: 'milestones', itemId: 'm1' })).toEqual({ kind: 'milestones' })
    expect(normalizeRef({ kind: 'risks', itemId: 'r1' })).toEqual({ kind: 'risks' })
  })
  test('keeps the person and the daily date', () => {
    expect(normalizeRef(ann.ref)).toEqual(ann.ref)
    expect(normalizeRef(day.ref)).toEqual(day.ref)
  })
})

describe('favoriteKey', () => {
  test('ignores itemId', () => {
    expect(favoriteKey({ teamId: 'T1', ref: { kind: 'risks', itemId: 'r9' } })).toBe(favoriteKey(risks))
  })
  test('distinguishes team, kind, person and date', () => {
    const keys = new Set([
      favoriteKey(risks),
      favoriteKey({ teamId: 'T2', ref: { kind: 'risks' } }),
      favoriteKey({ teamId: 'T1', ref: { kind: 'actions' } }),
      favoriteKey(ann),
      favoriteKey({ teamId: 'T1', ref: { kind: 'person', personId: 'p2', group: 'members' } }),
      favoriteKey(day),
      favoriteKey({ teamId: 'T1', ref: { kind: 'daily', date: '2026-10-07' } }),
    ])
    expect(keys.size).toBe(7)
  })
})

describe('toggleFavorite / isFavorite', () => {
  test('adds, reports true, then removes and reports false', () => {
    const d = docWithTeam()
    expect(isFavorite(d, risks)).toBe(false)
    expect(toggleFavorite(d, risks)).toBe(true)
    expect(isFavorite(d, risks)).toBe(true)
    expect(toggleFavorite(d, risks)).toBe(false)
    expect(d.favorites).toEqual([])
  })
  test('stores the normalized ref and treats an itemId variant as the same favorite', () => {
    const d = docWithTeam()
    toggleFavorite(d, { teamId: 'T1', ref: { kind: 'risks', itemId: 'r1' } })
    expect(d.favorites).toEqual([{ teamId: 'T1', ref: { kind: 'risks' } }])
    expect(isFavorite(d, risks)).toBe(true)
  })
  test('keeps insertion order', () => {
    const d = docWithTeam()
    toggleFavorite(d, day)
    toggleFavorite(d, risks)
    expect(d.favorites.map((f) => f.ref.kind)).toEqual(['daily', 'risks'])
  })
})

describe('isFavoriteOrphaned / liveFavorites', () => {
  test('a favorite of a missing team is orphaned', () => {
    const d = docWithTeam()
    expect(isFavoriteOrphaned(d, { teamId: 'GONE', ref: { kind: 'risks' } })).toBe(true)
  })
  test('a person favorite is orphaned when the person is gone, alive while present', () => {
    const d = docWithTeam()
    expect(isFavoriteOrphaned(d, ann)).toBe(false)
    d.teams[0]!.members = []
    expect(isFavoriteOrphaned(d, ann)).toBe(true)
  })
  test('a person favorite with a malformed group is orphaned instead of throwing', () => {
    const d = docWithTeam()
    const bad = { teamId: d.teams[0]!.id, ref: { kind: 'person', personId: 'x' } } as unknown as Favorite
    expect(isFavoriteOrphaned(d, bad)).toBe(true)
  })
  test('daily and module favorites of an existing team are never orphaned', () => {
    const d = docWithTeam()
    expect(isFavoriteOrphaned(d, day)).toBe(false)
    expect(isFavoriteOrphaned(d, risks)).toBe(false)
  })
  test('liveFavorites drops orphans, keeps order', () => {
    const d = docWithTeam()
    d.favorites = [day, { teamId: 'GONE', ref: { kind: 'risks' } }, ann]
    expect(liveFavorites(d)).toEqual([day, ann])
  })
})
