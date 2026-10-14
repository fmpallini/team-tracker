// test/search-incremental.test.ts — the search index re-derives only what an edit
// touched.
//
// An invalidation marks a team stale instead of discarding it; the next read
// re-collects the team's fields (cheap) and reuses the prepared form of every
// field whose text is unchanged, so the expensive stripMd + normalize pass runs
// for the edited fields alone. These tests pin both halves of that contract on
// a rich multi-team document (test/search-fixture.ts):
//
//  - cost: how many fields were re-prepared after each kind of change, counted
//    deterministically (normalize() lowercases exactly once per field it
//    prepares, so String.prototype.toLowerCase calls, taken relative to a no-op
//    rebuild, are the prepared-field count) plus a relative timing guard;
//  - behaviour: every result, title, snippet and backlink is what an index
//    built from scratch would return.
//
// The randomized version of the behaviour half lives in
// test/search-differential.test.ts.
import { vi } from 'vitest'

// collectCandidates formats one title per daily note, so counting formatDate
// calls counts how many daily-note fields a rebuild re-collected.
vi.mock('../src/core/i18n', async (orig) => {
  const mod = await orig<typeof import('../src/core/i18n')>()
  return { ...mod, formatDate: vi.fn(mod.formatDate) }
})

import { createSearchIndex, searchDocument, type SearchIndex } from '../src/core/search'
import { createStore, type Store } from '../src/core/store'
import { formatDate } from '../src/core/i18n'
import { buildRichDoc, dateKey, type RichDocShape } from './search-fixture'
import { expectScopeViolations, setScopeContractEnabled } from './scope-contract'

const SHAPE: RichDocShape = { teams: 4, dailyNotes: 30, people: 6, actions: 20, milestones: 10, risks: 10 }
// Daily notes + one general note per team, plus every other searchable field.
const FIELDS_PER_TEAM = SHAPE.dailyNotes + 1 + SHAPE.people + SHAPE.actions + SHAPE.milestones + SHAPE.risks
const TOTAL_FIELDS = SHAPE.teams * FIELDS_PER_TEAM

/** Mirrors ui/panes.ts's wiring of the index to the store. */
function setup(shape: RichDocShape = SHAPE): { store: Store; index: SearchIndex } {
  const store = createStore(buildRichDoc(shape))
  const index = createSearchIndex(() => store.doc, () => store.rev)
  store.subscribe((scope) => index.invalidate(scope))
  store.onMutate((kind) => { if (kind === 'nav') index.acknowledgeNav() })
  return { store, index }
}

const lowerCase = vi.spyOn(String.prototype, 'toLowerCase')
afterAll(() => { lowerCase.mockRestore() })

const collected = (): number => vi.mocked(formatDate).mock.calls.length
const resetCollected = (): void => { vi.mocked(formatDate).mockClear() }

let queryCounter = 0
/** A query no field matches and that is never a prefix-extension of an earlier one (so narrowing can't shortcut the rebuild). */
const miss = (): string => `qzx${queryCounter++}`

/** toLowerCase calls made by `fn` — one per `normalize()`, i.e. per prepared field plus one per query. */
function lowers(fn: () => void): number {
  lowerCase.mockClear()
  fn()
  return lowerCase.mock.calls.length
}

/**
 * Fields prepared by the next full search, beyond the fixed overhead of
 * collecting every field. The overhead is measured, not assumed: a no-op
 * rebuild of the same index pays exactly it.
 */
function preparedBy(store: Store, index: SearchIndex, change: () => void): number {
  const baseline = ((): number => {
    store.update(() => {}) // unscoped no-op: every team goes stale, nothing changed
    return lowers(() => { index.search(miss(), null) })
  })()
  change()
  return lowers(() => { index.search(miss(), null) }) - baseline
}

const firstDate = (store: Store, teamIdx: number): string => Object.keys(store.doc.teams[teamIdx]!.dailyNotes)[3]!

describe('what an edit re-prepares', () => {
  test('a cold index prepares every field once; a no-op rebuild prepares none', () => {
    const { store, index } = setup()
    const noop = (): number => { store.update(() => {}); return lowers(() => { index.search(miss(), null) }) }
    const cold = lowers(() => { index.search(miss(), null) })
    const afterNoop = noop()
    expect(cold - afterNoop).toBe(TOTAL_FIELDS)
    // Nothing changed, so a stale rebuild is pure re-collection.
    expect(noop()).toBe(afterNoop)
  })

  test('editing one daily note prepares that note only', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    const date = firstDate(store, 1)
    const prepared = preparedBy(store, index, () => {
      store.update((d) => { d.teams[1]!.dailyNotes[date] = 'a brand new sentence about zeppelins' }, { teamId: 't1', sections: ['notes'] })
    })
    expect(prepared).toBe(1)
  })

  test('adding, editing and deleting fields each prepare only the changed field', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[0]!.dailyNotes['2030-01-01'] = 'fresh note' }, { teamId: 't0', sections: ['notes'] })
    })).toBe(1)
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[2]!.actionItems[4]!.notes = 'edited action notes' }, { teamId: 't2', sections: ['actions'] })
    })).toBe(1)
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[3]!.milestones.splice(2, 1) }, { teamId: 't3', sections: ['milestones'] })
    })).toBe(0)
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[1]!.members[0]!.notes = 'edited person notes' }, { teamId: 't1', sections: ['people'] })
    })).toBe(1)
    // Name and role are part of a person's searchable text: one person, one field.
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[1]!.members[0]!.name = 'Renamed Person' }, { teamId: 't1', sections: ['people'] })
    })).toBe(1)
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[1]!.members[0]!.role = 'Staff Zeppelin Pilot' }, { teamId: 't1', sections: ['people'] })
    })).toBe(1)
  })

  test('an edit that restores the previous text re-prepares nothing it did not have to', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    const date = firstDate(store, 0)
    const original = store.doc.teams[0]!.dailyNotes[date]!
    store.update((d) => { d.teams[0]!.dailyNotes[date] = 'temporary' }, { teamId: 't0', sections: ['notes'] })
    index.search(miss(), null)
    // Back to a string equal to the one the cache held two edits ago: it was
    // replaced by 'temporary', so this is one re-prepare, not zero — and never more.
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[0]!.dailyNotes[date] = original }, { teamId: 't0', sections: ['notes'] })
    })).toBe(1)
  })

  test('a scoped edit re-collects only the edited team', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    store.update((d) => { d.teams[2]!.dailyNotes['2030-01-01'] = 'x' }, { teamId: 't2', sections: ['notes'] })
    resetCollected()
    index.search(miss(), null)
    expect(collected()).toBe(SHAPE.dailyNotes + 1) // t2's daily notes, the new one included — no other team's
  })

  test('preference changes that do not touch the locale leave the caches alone', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    store.update((d) => { d.prefs.fontSize = d.prefs.fontSize === 'M' ? 'L' : 'M' }, { sections: ['prefs'] })
    store.update((d) => { d.prefs.theme = 'dark' }, { sections: ['prefs'] })
    store.update((d) => { d.templates.push({ id: 'tp', name: 'T', scope: 'any', body: 'b' }) }, { sections: ['templates'] })
    resetCollected()
    expect(lowers(() => { index.search(miss(), null) })).toBe(1) // the query itself: nothing prepared…
    expect(collected()).toBe(0) // …and nothing even re-collected
  })

  test('a locale change re-collects but prepares nothing, and retitles daily notes', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    const date = firstDate(store, 0)
    resetCollected()
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.prefs.locale = 'en-US' }, { sections: ['prefs'] })
    })).toBe(0)
    expect(collected()).toBeGreaterThanOrEqual(SHAPE.teams * SHAPE.dailyNotes) // every title reformatted

    // The title comes from the new locale, matching an index built from scratch.
    const noteText = store.doc.teams[0]!.dailyNotes[date]!.split('\n')[0]!.replace(/^# /, '')
    const fresh = searchDocument(store.doc, noteText, 't0')
    expect(fresh.length).toBeGreaterThan(0)
    expect(index.search(noteText, 't0')).toEqual(fresh)
  })

  test('a locale change made through a scope that does not name prefs is still caught', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    // A deliberate lie: the locale moves under a scope that names notes only.
    // The suite-wide scope audit would flag it; here that is the point.
    const flagged = expectScopeViolations(() => {
      store.update((d) => { d.prefs.locale = 'en-US' }, { teamId: 't0', sections: ['notes'] })
    })
    expect(flagged.join(' ')).toContain("prefs changed but the scope does not name 'prefs'")
    const text = 'zeppelin-locale-probe'
    store.update((d) => { d.teams[3]!.generalNotes = text }, { teamId: 't3', sections: ['notes'] })
    expect(index.search(text, null)).toEqual(searchDocument(store.doc, text, null))
    const general = index.search(text, null)[0]!
    expect(general.title).toBe(searchDocument(store.doc, text, null)[0]!.title) // 'General notes', not the pt-BR label
  })

  test('renaming a team re-labels its results without preparing any field', () => {
    const { store, index } = setup()
    const needle = 'zeppelin-rename-probe'
    store.update((d) => { d.teams[1]!.generalNotes = needle }, { teamId: 't1', sections: ['notes'] })
    expect(index.search(needle, null)[0]!.teamName).toBe('Equipe 1')
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams[1]!.name = 'Renomeada' }, { teamId: 't1', sections: ['teams'] })
    })).toBe(0)
    expect(index.search(needle, null)[0]!.teamName).toBe('Renomeada')
  })

  test('an update with no scope re-collects everything and prepares only what differs', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    expect(preparedBy(store, index, () => {
      store.update((d) => {
        d.teams[0]!.dailyNotes['2031-02-02'] = 'unscoped edit one'
        d.teams[2]!.risks[1]!.followup = 'unscoped edit two'
      })
    })).toBe(2)
  })

  test('a change nobody described (no invalidate, rev moved) is still seen, and still incremental', () => {
    const doc = buildRichDoc(SHAPE)
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)
    index.search(miss(), null)
    const noopCost = ((): number => { rev++; return lowers(() => { index.search(miss(), null) }) })()
    rev++
    doc.teams[1]!.dailyNotes['2032-03-03'] = 'undescribed zeppelin edit'
    const cost = lowers(() => { index.search('undescribed zeppelin', null) })
    // One prepared field and the same single query, plus the same collection overhead
    // (the query here has two terms but is normalized once).
    expect(cost - noopCost).toBe(1)
    expect(index.search('undescribed zeppelin', null)).toHaveLength(1)
  })
})

describe('results are what a from-scratch index returns', () => {
  const same = (store: Store, index: SearchIndex, query: string, scope: string | null = null): void => {
    expect(index.search(query, scope)).toEqual(searchDocument(store.doc, query, scope))
  }

  test('edited text is found and the old text is gone', () => {
    const { store, index } = setup()
    const date = firstDate(store, 2)
    store.doc.teams[2]!.dailyNotes[date] = 'obsolete-marker-aaa'
    store.update(() => {}, { teamId: 't2', sections: ['notes'] })
    expect(index.search('obsolete-marker-aaa', null)).toHaveLength(1)
    store.update((d) => { d.teams[2]!.dailyNotes[date] = 'replacement-marker-bbb' }, { teamId: 't2', sections: ['notes'] })
    expect(index.search('obsolete-marker-aaa', null)).toHaveLength(0)
    same(store, index, 'replacement-marker-bbb')
    expect(index.search('replacement-marker-bbb', null)[0]!.loc).toEqual({ teamId: 't2', ref: { kind: 'daily', date } })
  })

  test('result order is unchanged by incremental rebuilds (ties keep document order)', () => {
    const { store, index } = setup()
    index.search('rollout', null)
    for (let i = 0; i < 5; i++) {
      store.update((d) => { d.teams[i % SHAPE.teams]!.dailyNotes[dateKey(i)] = `rollout edit ${i}` }, { teamId: `t${i % SHAPE.teams}`, sections: ['notes'] })
      same(store, index, 'rollout')
      same(store, index, 'rollout edit')
      same(store, index, 'acao', 't1') // accent-insensitive
    }
  })

  test('deleting a team drops its results; restoring the id with new content serves the new content', () => {
    const { store, index } = setup()
    const marker = 'zeppelin-restore-probe'
    store.update((d) => { d.teams[1]!.generalNotes = marker }, { teamId: 't1', sections: ['notes'] })
    expect(index.search(marker, null)).toHaveLength(1)

    const removed = store.doc.teams[1]!
    store.update((d) => { d.teams.splice(1, 1) }, { sections: ['teams'] })
    expect(index.search(marker, null)).toHaveLength(0)
    expect(index.backlinks('t1', 'action', 't1-a0')).toEqual([])

    store.update((d) => { d.teams.splice(1, 0, { ...removed, generalNotes: 'restored-differently' }) }, { sections: ['teams'] })
    expect(index.search(marker, null)).toHaveLength(0)
    expect(index.search('restored-differently', null)).toHaveLength(1)
  })

  test('replaceDoc serves the new document even when team ids repeat', () => {
    const { store, index } = setup()
    index.search(miss(), null)
    const next = buildRichDoc(SHAPE, 7)
    store.replaceDoc(next)
    same(store, index, 'rollout')
    same(store, index, 'dependencia', 't2')
  })

  test('moving an item between teams (an unscoped update) is reflected on both sides', () => {
    const { store, index } = setup()
    const marker = 'zeppelin-transfer-probe'
    store.update((d) => { d.teams[0]!.actionItems[0]!.summary = marker }, { teamId: 't0', sections: ['actions'] })
    expect(index.search(marker, null)[0]!.loc.teamId).toBe('t0')
    store.update((d) => { d.teams[3]!.actionItems.push(...d.teams[0]!.actionItems.splice(0, 1)) })
    expect(index.search(marker, null).map((r) => r.loc.teamId)).toEqual(['t3'])
    same(store, index, marker)
  })

  test('narrowing still works across an edit (typing forward after a content change)', () => {
    const { store, index } = setup()
    index.search('ro', null)
    index.search('rol', null)
    store.update((d) => { d.teams[0]!.dailyNotes['2033-04-04'] = 'rolling thunder' }, { teamId: 't0', sections: ['notes'] })
    same(store, index, 'roll')
    same(store, index, 'rolling')
    same(store, index, 'rolling t')
  })
})

describe('teams the document no longer has', () => {
  // A deleted team's cache entry cannot be observed directly, but it can be
  // told apart by what happens when the same team comes back unchanged: an
  // entry that was kept is reused wholesale, one that was pruned is rebuilt.
  test("a deleted team's prepared text is released, not kept for a restore", () => {
    const { store, index } = setup()
    index.search(miss(), null)
    const removed = store.doc.teams[1]!
    store.update((d) => { d.teams.splice(1, 1) }, { sections: ['teams'] })
    index.search(miss(), null)
    expect(preparedBy(store, index, () => {
      store.update((d) => { d.teams.splice(1, 0, removed) }, { sections: ['teams'] })
    })).toBe(FIELDS_PER_TEAM)
  })

  test("a deleted team's backlink scans are released, not kept for a restore", () => {
    const { store, index } = setup()
    const target = store.doc.teams[1]!.actionItems[0]!.id
    const before = index.backlinks('t1', 'action', target)
    expect(before.length).toBeGreaterThan(0)
    const removed = store.doc.teams[1]!
    store.update((d) => { d.teams.splice(1, 1) }, { sections: ['teams'] })
    expect(index.backlinks('t1', 'action', target)).toEqual([])
    store.update((d) => { d.teams.splice(1, 0, removed) }, { sections: ['teams'] })
    const after = index.backlinks('t1', 'action', target)
    expect(after).toEqual(before)
    expect(after[0]).not.toBe(before[0]) // rebuilt, not the old entry resurrected
  })

  test('a team that was never read costs nothing to delete', () => {
    const { store, index } = setup()
    store.update((d) => { d.teams.splice(0, 1) }, { sections: ['teams'] })
    expect(index.search(miss(), null)).toEqual([])
    expect(index.backlinks('t0', 'action', 't0-a0')).toEqual([])
  })
})

describe('backlinks', () => {
  const sameBacklinks = (store: Store, index: SearchIndex): void => {
    const fresh = createSearchIndex(() => store.doc, () => 0)
    for (const team of store.doc.teams) {
      for (const a of team.actionItems.slice(0, 6)) expect(index.backlinks(team.id, 'action', a.id)).toEqual(fresh.backlinks(team.id, 'action', a.id))
      for (const m of team.milestones.slice(0, 4)) expect(index.backlinks(team.id, 'milestone', m.id)).toEqual(fresh.backlinks(team.id, 'milestone', m.id))
      for (const r of team.risks.slice(0, 4)) expect(index.backlinks(team.id, 'risk', r.id)).toEqual(fresh.backlinks(team.id, 'risk', r.id))
      for (const p of [...team.stakeholders, ...team.members]) expect(index.backlinks(team.id, 'person', p.id)).toEqual(fresh.backlinks(team.id, 'person', p.id))
    }
  }

  test('an unchanged source keeps its backlink objects across an edit elsewhere in the team', () => {
    const { store, index } = setup()
    const target = store.doc.teams[0]!.actionItems[0]!.id
    const before = index.backlinks('t0', 'action', target)
    expect(before.length).toBeGreaterThan(0)
    // Edit a field that mentions nothing (an unrelated action item's notes).
    store.update((d) => { d.teams[0]!.actionItems[19]!.notes = 'no mentions here' }, { teamId: 't0', sections: ['actions'] })
    const after = index.backlinks('t0', 'action', target)
    expect(after).toEqual(before)
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i])
  })

  test('adding, changing and removing a mention is picked up and ordering matches a fresh index', () => {
    const { store, index } = setup()
    const target = store.doc.teams[1]!.risks[0]!.id
    const baseline = index.backlinks('t1', 'risk', target).length
    const date = '2034-05-05'

    store.update((d) => { d.teams[1]!.dailyNotes[date] = `see @[Risk](risk:${target}) now` }, { teamId: 't1', sections: ['notes'] })
    expect(index.backlinks('t1', 'risk', target)).toHaveLength(baseline + 1)
    sameBacklinks(store, index)

    store.update((d) => { d.teams[1]!.dailyNotes[date] = `see @[Risk](risk:${target}) and again @[Risk](risk:${target})` }, { teamId: 't1', sections: ['notes'] })
    expect(index.backlinks('t1', 'risk', target)).toHaveLength(baseline + 2)

    store.update((d) => { d.teams[1]!.dailyNotes[date] = 'no mention any more' }, { teamId: 't1', sections: ['notes'] })
    expect(index.backlinks('t1', 'risk', target)).toHaveLength(baseline)
    sameBacklinks(store, index)
  })

  test('renaming a source item retitles its backlinks', () => {
    const { store, index } = setup()
    const oldName = store.doc.teams[0]!.members[0]!.name // read now: the store mutates this object in place
    const target = store.doc.teams[0]!.actionItems[1]!.id
    store.update((d) => { d.teams[0]!.members[0]!.notes = `owes @[x](action:${target}) a reply` }, { teamId: 't0', sections: ['people'] })
    expect(index.backlinks('t0', 'action', target).some((b) => b.title === oldName)).toBe(true)
    store.update((d) => { d.teams[0]!.members[0]!.name = 'Nome Novo' }, { teamId: 't0', sections: ['people'] })
    expect(index.backlinks('t0', 'action', target).some((b) => b.title === 'Nome Novo')).toBe(true)
    expect(index.backlinks('t0', 'action', target).some((b) => b.title === oldName)).toBe(false)
    sameBacklinks(store, index)
  })

  test('deleting a source or its team removes its backlinks', () => {
    const { store, index } = setup()
    const target = store.doc.teams[2]!.actionItems[0]!.id
    store.update((d) => { d.teams[2]!.dailyNotes['2035-06-06'] = `@[a](action:${target})` }, { teamId: 't2', sections: ['notes'] })
    const withMention = index.backlinks('t2', 'action', target).length
    store.update((d) => { delete d.teams[2]!.dailyNotes['2035-06-06'] }, { teamId: 't2', sections: ['notes'] })
    expect(index.backlinks('t2', 'action', target)).toHaveLength(withMention - 1)
    store.update((d) => { d.teams.splice(2, 1) }, { sections: ['teams'] })
    expect(index.backlinks('t2', 'action', target)).toEqual([])
    sameBacklinks(store, index)
  })
})

describe('cost relative to a cold build', () => {
  // Same reasoning as the other search-*.test.ts timing guards: relative, same
  // fixture, same machine, minimum of several runs — only the ratio is asserted.
  // Timed: the scope audit's snapshots would add their own cost to every update.
  beforeAll(() => setScopeContractEnabled(false))
  afterAll(() => setScopeContractEnabled(true))
  const BIG: RichDocShape = { teams: 8, dailyNotes: 60, people: 8, actions: 60, milestones: 30, risks: 30 }
  const timeIt = (fn: () => void): number => { const s = performance.now(); fn(); return performance.now() - s }
  const best = (reps: number, fn: () => void): number => { let b = Infinity; for (let i = 0; i < reps; i++) b = Math.min(b, timeIt(fn)); return b }

  test('one edit, a preference change and a rename are each a small fraction of a cold build', () => {
    const { store, index } = setup(BIG)
    const cold = timeIt(() => { index.search(miss(), null) })
    let n = 0
    const edit = best(8, () => {
      store.update((d) => { d.teams[3]!.dailyNotes[dateKey(5)] = `edited ${n++}` }, { teamId: 't3', sections: ['notes'] })
      index.search(miss(), null)
    })
    const pref = best(8, () => {
      store.update((d) => { d.prefs.fontSize = d.prefs.fontSize === 'M' ? 'L' : 'M' }, { sections: ['prefs'] })
      index.search(miss(), null)
    })
    const rename = best(8, () => {
      store.update((d) => { d.teams[2]!.name = `Equipe ${n++}` }, { teamId: 't2', sections: ['teams'] })
      index.search(miss(), null)
    })
    const unscoped = best(8, () => { store.update(() => {}); index.search(miss(), null) })
    console.log(`[metric] cold ${cold.toFixed(1)}ms | after one edit ${edit.toFixed(2)}ms | pref ${pref.toFixed(2)}ms | rename ${rename.toFixed(2)}ms | unscoped no-op ${unscoped.toFixed(2)}ms`)
    expect(edit).toBeLessThan(cold / 4)
    expect(pref).toBeLessThan(cold / 4)
    expect(rename).toBeLessThan(cold / 4)
    expect(unscoped).toBeLessThan(cold / 2)
  })
})
