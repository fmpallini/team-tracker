import { findTeamItem, patchTeamItem } from '../src/core/team-items'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { Team } from '../src/core/types'

function makeTeam(id: string, overrides: Partial<Team> = {}): Team {
  return {
    id, name: id, emoji: '🚀', stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup() {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(
    makeTeam('T1', {
      risks: [{ id: 'r1', title: 'A', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false }],
      milestones: [{ id: 'm1', date: '2026-01-01', title: 'M', done: false, followup: '' }],
      actionItems: [{ id: 'a1', summary: 'S', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger' }],
    }),
    makeTeam('T2', {
      risks: [{ id: 'r1', title: 'Same id, other team', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false }],
    }),
  )
  return { doc, store: createStore(doc) }
}

describe('findTeamItem', () => {
  test('finds an entity in each collection', () => {
    const { doc } = setup()
    expect(findTeamItem(doc, 'T1', 'risks', 'r1')?.title).toBe('A')
    expect(findTeamItem(doc, 'T1', 'milestones', 'm1')?.title).toBe('M')
    expect(findTeamItem(doc, 'T1', 'actionItems', 'a1')?.summary).toBe('S')
  })

  test('is scoped to the named team even when another team reuses the id', () => {
    const { doc } = setup()
    expect(findTeamItem(doc, 'T2', 'risks', 'r1')?.title).toBe('Same id, other team')
  })

  test('returns undefined for an unknown team or id', () => {
    const { doc } = setup()
    expect(findTeamItem(doc, 'nope', 'risks', 'r1')).toBeUndefined()
    expect(findTeamItem(doc, 'T1', 'risks', 'nope')).toBeUndefined()
  })
})

describe('patchTeamItem', () => {
  test('mutates only the targeted entity, marks dirty, and notifies with the given scope', () => {
    const { store } = setup()
    const scopes: unknown[] = []
    store.subscribe((scope) => scopes.push(scope))

    patchTeamItem(store, 'T1', 'risks', 'r1', (r) => { r.chance = 3 }, { teamId: 'T1', sections: ['risks'] })

    expect(store.doc.teams[0]!.risks[0]!.chance).toBe(3)
    expect(store.doc.teams[1]!.risks[0]!.chance).toBe(1)
    expect(store.dirty).toBe(true)
    expect(scopes).toEqual([{ teamId: 'T1', sections: ['risks'] }])
  })

  test('a missing entity or team is a silent no-op that never calls mutate', () => {
    const { store } = setup()
    const mutate = vi.fn()

    patchTeamItem(store, 'T1', 'risks', 'nope', mutate, { teamId: 'T1' })
    patchTeamItem(store, 'nope', 'risks', 'r1', mutate, { teamId: 'nope' })

    expect(mutate).not.toHaveBeenCalled()
  })

  test('a read-only store blocks the write', () => {
    const { store } = setup()
    store.setReadOnly(true)

    patchTeamItem(store, 'T1', 'milestones', 'm1', (m) => { m.done = true }, { teamId: 'T1', sections: ['milestones'] })

    expect(store.doc.teams[0]!.milestones[0]!.done).toBe(false)
  })
})
