import { searchDocument, normalize, teamRefCandidates, KIND_ICON, createSearchIndex } from '../src/core/search'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

const team = (id: string, name: string): Team => ({ id, name, emoji: '🧭', stakeholders: [], members: [],
  actionItems: [], milestones: [], risks: [], dailyNotes: {} })

function fixture() {
  const d = createEmptyDocument('pt-BR')
  const t1 = team('t1', 'Alpha'), t2 = team('t2', 'Beta')
  t1.dailyNotes['2026-07-01'] = '# Reunião\nDiscussão sobre **orçamento** anual'
  t1.generalNotes = 'Vendor contact: Acme Corp, renewal in março'
  t1.members.push({ id: 'p1', name: 'Ana', role: 'Dev', parentId: null, order: 0, notes: 'Promoção pendente' })
  t1.actionItems.push({ id: 'a1', summary: 'Fechar contrato', status: 'todo', color: 'ledger', dueDate: null, assignee: 'Ana', order: 0, notes: 'contrato assinado' })
  t1.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Entrega beta', done: false, followup: 'Cronograma atrasou muito' })
  t2.risks.push({ id: 'r1', title: 'Atraso fornecedor', chance: 2, impact: 3, plan: 'mitigate', followup: 'orcamento extra aprovado', order: 0, closed: false })
  d.teams.push(t1, t2)
  return d
}

test('normalize strips accents and case', () => {
  expect(normalize('Reunião ORÇAMENTO')).toBe('reuniao orcamento')
})

test('finds accent-insensitive within team scope', () => {
  const r = searchDocument(fixture(), 'orcamento', 't1')
  expect(r).toHaveLength(1)
  expect(r[0]!.loc.ref).toEqual({ kind: 'daily', date: '2026-07-01' })
  expect(r[0]!.snippet).toContain('orçamento')
  expect(r[0]!.snippet).not.toContain('**')
})

test('all-teams scope and AND terms', () => {
  expect(searchDocument(fixture(), 'orcamento', null)).toHaveLength(2)
  expect(searchDocument(fixture(), 'orcamento extra', null)).toHaveLength(1)
  expect(searchDocument(fixture(), 'orcamento zzz', null)).toHaveLength(0)
})

test('person notes searchable', () => {
  const r = searchDocument(fixture(), 'promocao', 't1')
  expect(r[0]!.loc.ref.kind).toBe('person')
  expect(r[0]!.title).toBe('Ana')
})

test('finds text inside action-item notes', () => {
  const r = searchDocument(fixture(), 'contrato', 't1')
  expect(r[0]!.loc.ref).toMatchObject({ kind: 'actions', itemId: 'a1' })
})

test('finds text inside milestone followups', () => {
  const r = searchDocument(fixture(), 'atrasou', 't1')
  expect(r[0]!.loc.ref).toMatchObject({ kind: 'milestones', itemId: 'm1' })
})

test('risks results carry the risk id', () => {
  const r = searchDocument(fixture(), 'fornecedor', 't2')
  expect(r[0]!.loc.ref).toMatchObject({ kind: 'risks', itemId: 'r1' })
})

test('teamRefCandidates extracts id+title for people/action items/milestones/risks', () => {
  const d = fixture()
  const t1 = d.teams.find((tm) => tm.id === 't1')!
  const candidates = teamRefCandidates(t1)
  expect(candidates.people).toEqual([{ id: 'p1', title: 'Ana' }])
  expect(candidates.actionItems).toEqual([{ id: 'a1', title: 'Fechar contrato' }])
  expect(candidates.milestones).toEqual([{ id: 'm1', title: 'Entrega beta' }])
  expect(candidates.risks).toEqual([]) // r1 lives on t2, not t1
})

test('teamRefCandidates returns all-empty lists for an undefined team', () => {
  expect(teamRefCandidates(undefined)).toEqual({ people: [], actionItems: [], milestones: [], risks: [] })
})

test('finds text inside a team\'s generalNotes', () => {
  const r = searchDocument(fixture(), 'acme', 't1')
  expect(r[0]!.loc.ref).toEqual({ kind: 'general' })
  expect(r[0]!.moduleKind).toBe('general')
})

test('a team with undefined generalNotes does not throw and never matches', () => {
  const d = fixture()
  const t1 = d.teams.find((tm) => tm.id === 't1')!
  delete (t1 as { generalNotes?: string }).generalNotes
  expect(() => searchDocument(d, 'anything', 't1')).not.toThrow()
})

test('KIND_ICON has an entry for every moduleKind used by search results', () => {
  const d = fixture()
  const results = searchDocument(d, 'orcamento', null)
  expect(results.length).toBeGreaterThan(0)
  for (const r of results) expect(KIND_ICON[r.moduleKind]).toBeTruthy()
})

function teamWithNote(id: string, name: string, note: string): Team {
  return {
    id, name, emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-08-01': note },
  }
}

test('the index returns the same results as searchDocument', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'deploy the **release** today'))
  const rev = 0
  const index = createSearchIndex(() => doc, () => rev)

  const first = index.search('release', null)
  expect(first.length).toBe(1)
  expect(first[0]!.snippet).toContain('release')
})

test('repeat searches at the same rev reuse the cache', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'alpha note'))
  const rev = 0
  const index = createSearchIndex(() => doc, () => rev)

  expect(index.search('alpha', null).length).toBe(1)
  // Mutate the doc WITHOUT bumping rev: a cached index must not see it.
  doc.teams[0]!.dailyNotes['2026-08-01'] = 'beta note'
  expect(index.search('beta', null).length).toBe(0)
})

test('bumping rev invalidates the cache', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'alpha note'))
  let rev = 0
  const index = createSearchIndex(() => doc, () => rev)

  expect(index.search('alpha', null).length).toBe(1)
  doc.teams[0]!.dailyNotes['2026-08-01'] = 'beta note'
  rev = 1
  expect(index.search('beta', null).length).toBe(1)
  expect(index.search('alpha', null).length).toBe(0)
})

test('team scoping still applies through the index', () => {
  const doc: Doc = createEmptyDocument('en-US')
  doc.teams.push(teamWithNote('t1', 'Alpha', 'shared word'))
  doc.teams.push(teamWithNote('t2', 'Beta', 'shared word'))
  const index = createSearchIndex(() => doc, () => 0)

  expect(index.search('shared', null).length).toBe(2)
  expect(index.search('shared', 't1').length).toBe(1)
  expect(index.search('shared', 't1')[0]!.teamName).toBe('Alpha')
})

describe('scope-driven cache invalidation', () => {
  function twoTeams(): Doc {
    const doc: Doc = createEmptyDocument('en-US')
    doc.teams.push(teamWithNote('t1', 'Alpha', 'alpha original'))
    doc.teams.push(teamWithNote('t2', 'Beta', 'beta original'))
    return doc
  }

  test('a scoped change to one team leaves the other team cached', () => {
    const doc = twoTeams()
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)

    expect(index.search('original', null).length).toBe(2)

    // t1 edited; t2 untouched. Only t1's cache entry may be dropped.
    doc.teams[0]!.dailyNotes['2026-08-01'] = 'alpha rewritten'
    doc.teams[1]!.dailyNotes['2026-08-01'] = 'beta rewritten' // simulates a stale cache
    rev = 1
    index.invalidate({ teamId: 't1', sections: ['notes'] })

    // t1 re-prepared: sees the new text.
    expect(index.search('rewritten', 't1').length).toBe(1)
    // t2 still served from cache: does NOT see its (untold) change.
    expect(index.search('rewritten', 't2').length).toBe(0)
  })

  test('a scope with no teamId clears everything', () => {
    const doc = twoTeams()
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)
    expect(index.search('original', null).length).toBe(2)

    doc.teams[0]!.dailyNotes['2026-08-01'] = 'alpha rewritten'
    doc.teams[1]!.dailyNotes['2026-08-01'] = 'beta rewritten'
    rev = 1
    index.invalidate({ sections: ['notes'] })

    expect(index.search('rewritten', null).length).toBe(2)
  })

  test('a change touching no searchable section drops nothing', () => {
    const doc = twoTeams()
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)
    expect(index.search('original', null).length).toBe(2)

    doc.teams[0]!.dailyNotes['2026-08-01'] = 'alpha rewritten'
    rev = 1
    index.invalidate({ teamId: 't1', sections: ['templates'] })

    expect(index.search('rewritten', null).length).toBe(0)
  })

  test('a rev bump nobody explained still clears everything (updateNav backstop)', () => {
    const doc = twoTeams()
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)
    expect(index.search('original', null).length).toBe(2)

    doc.teams[0]!.dailyNotes['2026-08-01'] = 'alpha rewritten'
    doc.teams[1]!.dailyNotes['2026-08-01'] = 'beta rewritten'
    rev = 1 // moved with no invalidate() call — e.g. store.updateNav()

    expect(index.search('rewritten', null).length).toBe(2)
  })

  test('several scoped invalidations between searches do not trigger the backstop', () => {
    const doc = twoTeams()
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)
    expect(index.search('original', null).length).toBe(2)

    doc.teams[0]!.dailyNotes['2026-08-01'] = 'alpha rewritten'
    rev = 1
    index.invalidate({ teamId: 't1', sections: ['notes'] })
    rev = 2
    index.invalidate({ teamId: 't1', sections: ['notes'] })

    doc.teams[1]!.dailyNotes['2026-08-01'] = 'beta rewritten' // untold change
    expect(index.search('rewritten', 't2').length).toBe(0) // t2 still cached
  })
})

import { backlinksFor } from '../src/core/search'
import { createStore } from '../src/core/store'

function backlinksFixture(): Doc {
  const d = createEmptyDocument('en-US')
  const t1 = team('t1', 'Alpha')
  t1.dailyNotes['2026-08-04'] = 'Started @[Migrate billing job](action:a1), needs review'
  t1.generalNotes = 'Vendor call notes, unrelated to @[Migrate billing job](action:a1) too'
  t1.members.push({ id: 'p1', name: 'Ana', role: 'Dev', parentId: null, order: 0, notes: 'Flagged @[Migrate billing job](action:a1) as blocking her sprint' })
  t1.actionItems.push({ id: 'a1', summary: 'Migrate billing job', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: '' })
  t1.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Beta', done: false, followup: 'Depends on @[Migrate billing job](action:a1) landing before Q3' })
  t1.risks.push({ id: 'r1', title: 'Queue backlog', chance: 2, impact: 2, plan: 'mitigate', followup: 'no mention here', order: 0, closed: false })
  d.teams.push(t1)
  return d
}

// backlinksFor is the cached, Store-backed reverse lookup for @-mentions:
// every mention of kind:targetId across a team's free-text fields, sourced
// from the same rev-keyed per-team cache createSearchIndex builds for
// search(), instead of re-walking every note field on every call.
describe('backlinksFor', () => {
  test('finds mentions across all 4 non-general note fields plus general notes', () => {
    const doc = backlinksFixture()
    const store = createStore(doc)
    const results = backlinksFor(store, 't1', 'action', 'a1')
    expect(results).toHaveLength(4)
    expect(results.map((r) => r.moduleKind).sort()).toEqual(['daily', 'general', 'milestones', 'person'])
  })

  test('a field with two mentions of the same target yields two entries', () => {
    const doc = backlinksFixture()
    doc.teams[0]!.dailyNotes['2026-08-04'] += ' — see also @[Migrate billing job](action:a1) again'
    const store = createStore(doc)
    const results = backlinksFor(store, 't1', 'action', 'a1')
    expect(results.filter((r) => r.moduleKind === 'daily')).toHaveLength(2)
  })

  test('no matches returns an empty array', () => {
    const doc = backlinksFixture()
    const store = createStore(doc)
    expect(backlinksFor(store, 't1', 'risk', 'r1')).toEqual([])
  })

  test('an unknown teamId returns an empty array', () => {
    const doc = backlinksFixture()
    const store = createStore(doc)
    expect(backlinksFor(store, 'nope', 'action', 'a1')).toEqual([])
  })

  test('snippet is markdown-stripped and the matched mention reads as its label', () => {
    const doc = backlinksFixture()
    const store = createStore(doc)
    const [hit] = backlinksFor(store, 't1', 'action', 'a1').filter((r) => r.moduleKind === 'person')
    expect(hit!.snippet).toContain('Migrate billing job')
    expect(hit!.snippet).not.toContain('@[')
    expect(hit!.title).toBe('Ana')
    expect(hit!.loc).toEqual({ teamId: 't1', ref: { kind: 'person', personId: 'p1', group: 'members' } })
  })

  test('day-kind target keys by ISO date string, not an item id', () => {
    const doc = backlinksFixture()
    doc.teams[0]!.risks[0]!.followup = 'Follow up on @[Aug 4](day:2026-08-04)'
    const store = createStore(doc)
    const results = backlinksFor(store, 't1', 'day', '2026-08-04')
    expect(results).toHaveLength(1)
    expect(results[0]!.moduleKind).toBe('risks')
  })

  test('repeated lookups at the same rev reuse the cache instead of re-scanning the team', () => {
    const doc = backlinksFixture()
    const store = createStore(doc)
    expect(backlinksFor(store, 't1', 'action', 'a1')).toHaveLength(4)
    // Mutate the doc WITHOUT going through store.update() (so rev doesn't
    // move): a cached lookup must not see it, same contract as
    // createSearchIndex's own "repeat searches at the same rev" test above.
    doc.teams[0]!.dailyNotes['2026-08-04'] = 'no mention now'
    expect(backlinksFor(store, 't1', 'action', 'a1')).toHaveLength(4)
  })

  test('a store.update() bumping rev refreshes the backlinks result', () => {
    const doc = backlinksFixture()
    const store = createStore(doc)
    expect(backlinksFor(store, 't1', 'action', 'a1')).toHaveLength(4)
    store.update((d) => {
      d.teams[0]!.dailyNotes['2026-08-04'] = 'no mention now'
    }, { teamId: 't1', sections: ['notes'] })
    expect(backlinksFor(store, 't1', 'action', 'a1')).toHaveLength(3)
  })

  test('two different stores get independent caches', () => {
    const doc1 = backlinksFixture()
    const doc2 = backlinksFixture()
    doc2.teams[0]!.dailyNotes['2026-08-04'] = 'no mention here'
    const store1 = createStore(doc1)
    const store2 = createStore(doc2)
    expect(backlinksFor(store1, 't1', 'action', 'a1')).toHaveLength(4)
    expect(backlinksFor(store2, 't1', 'action', 'a1')).toHaveLength(3)
  })
})
