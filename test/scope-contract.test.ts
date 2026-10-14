// test/scope-contract.test.ts — the scope-contract auditor (test/scope-contract.ts)
// itself: that it flags every way a mutation can exceed its declared scope, and
// stays quiet for the honest cases the real call sites produce. The auditor is
// what stands behind "a scoped store.update() changed only what it said", so a
// check that silently passes everything would be worse than none.
//
// Note: the suite-wide setup (test/setup-scope-contract.ts) wraps every
// createStore() already; the tests that lie on purpose therefore catch their
// violations with expectScopeViolations(), which keeps them out of afterEach.
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'
import type { ChangeScope, Section } from '../src/core/scope'
import {
  expectScopeViolations, navViolations, scopeViolations, setScopeContractEnabled, snapshot, wrapStore,
} from './scope-contract'

function makeDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  for (const id of ['a', 'b', 'c']) {
    const t = createEmptyTeam(id, `Team ${id}`, '🚀', 'en-US')
    t.dailyNotes['2026-01-01'] = `note ${id}`
    t.generalNotes = `general ${id}`
    t.members.push({ id: `${id}-m`, name: 'Ana', role: '', parentId: null, order: 0, notes: 'person notes' })
    t.actionItems.push({ id: `${id}-a`, summary: 'item', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: '' })
    t.milestones.push({ id: `${id}-ms`, date: '2026-01-01', title: 'm', done: false, followup: '' })
    t.risks.push({ id: `${id}-r`, title: 'r', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
    doc.teams.push(t)
  }
  return doc
}

/** What the auditor says about `mutate` run under `scope`. */
function audit(scope: ChangeScope | undefined, mutate: (d: Doc) => void): string[] {
  const doc = makeDoc()
  const before = snapshot(doc)
  mutate(doc)
  return scopeViolations(before, snapshot(doc), scope)
}

type Case = [name: string, sections: Section[], mutate: (d: Doc) => void]

describe('scopeViolations — honest scopes pass', () => {
  test('an unscoped or empty scope is unrestricted', () => {
    const wide = (d: Doc): void => { d.teams[0]!.name = 'x'; d.teams[2]!.risks.length = 0; d.prefs.fontSize = 'XL' }
    expect(audit(undefined, wide)).toEqual([])
    expect(audit({}, wide)).toEqual([])
  })

  test.each<Case>([
    ['notes', ['notes'], (d: Doc) => { d.teams[1]!.dailyNotes['2026-02-02'] = 'new' }],
    ['general notes', ['notes'], (d: Doc) => { d.teams[1]!.generalNotes = 'changed' }],
    ['person notes under notes', ['notes'], (d: Doc) => { d.teams[1]!.members[0]!.notes = 'changed' }],
    ['person notes under people', ['people'], (d: Doc) => { d.teams[1]!.members[0]!.notes = 'changed' }],
    ['a rename of a person', ['people'], (d: Doc) => { d.teams[1]!.members[0]!.name = 'Bia' }],
    ['an action item', ['actions'], (d: Doc) => { d.teams[1]!.actionItems[0]!.summary = 'changed' }],
    ['action columns', ['actions'], (d: Doc) => { d.teams[1]!.actionColumns = [] }],
    ['a milestone', ['milestones'], (d: Doc) => { d.teams[1]!.milestones[0]!.done = true }],
    ['a risk', ['risks'], (d: Doc) => { d.teams[1]!.risks[0]!.closed = true }],
    ['a team rename', ['teams'], (d: Doc) => { d.teams[1]!.name = 'renamed' }],
  ])('%s, scoped to its team and section', (_, sections, mutate) => {
    expect(audit({ teamId: 'b', sections }, mutate)).toEqual([])
  })

  test('a team-only scope may change any section of that team (the delete-with-unlink shape)', () => {
    expect(audit({ teamId: 'b' }, (d) => {
      const t = d.teams[1]!
      t.dailyNotes['2026-01-01'] = 'unlinked'; t.members[0]!.notes = 'unlinked'; t.actionItems.length = 0; t.risks.length = 0
    })).toEqual([])
  })

  test('a section-only scope may change that section in any team', () => {
    expect(audit({ sections: ['actions'] }, (d) => { for (const t of d.teams) t.actionItems.length = 0 })).toEqual([])
  })

  test("prefs and templates are fine when named", () => {
    expect(audit({ sections: ['prefs'] }, (d) => { d.prefs.fontSize = 'XL'; d.prefs.locale = 'pt-BR' })).toEqual([])
    expect(audit({ sections: ['templates'] }, (d) => { d.templates.push({ id: 't', name: 'T', scope: 'any', body: 'b' }) })).toEqual([])
  })

  test("adding, removing and reordering teams are fine under 'teams'", () => {
    expect(audit({ sections: ['teams'] }, (d) => { d.teams.reverse(); d.teams.pop() })).toEqual([])
  })

  test('an update that changes nothing is honest under any scope', () => {
    expect(audit({ teamId: 'a', sections: ['risks'] }, () => {})).toEqual([])
  })

  test("replacing the named team's object (the undo restore) is fine", () => {
    expect(audit({ teamId: 'b' }, (d) => { d.teams[1] = structuredClone(d.teams[1]!) })).toEqual([])
  })
})

describe('scopeViolations — lies are caught', () => {
  test('another team changed under a teamId scope', () => {
    const v = audit({ teamId: 'a', sections: ['notes'] }, (d) => { d.teams[1]!.dailyNotes['2026-01-01'] = 'sneaky' })
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('team "b"')
    expect(v[0]).toContain('names team "a"')
  })

  test('another team changed under a team-only scope', () => {
    expect(audit({ teamId: 'a' }, (d) => { d.teams[2]!.generalNotes = 'sneaky' })).toHaveLength(1)
  })

  test.each<[...Case, string]>([
    ['notes edited under actions', ['actions'], (d: Doc) => { d.teams[0]!.dailyNotes['2026-01-01'] = 'x' }, 'text'],
    ['an action edited under notes', ['notes'], (d: Doc) => { d.teams[0]!.actionItems[0]!.summary = 'x' }, 'actions'],
    ['a milestone edited under risks', ['risks'], (d: Doc) => { d.teams[0]!.milestones[0]!.title = 'x' }, 'milestones'],
    ['a risk edited under milestones', ['milestones'], (d: Doc) => { d.teams[0]!.risks[0]!.title = 'x' }, 'risks'],
    ['a rename under notes', ['notes'], (d: Doc) => { d.teams[0]!.name = 'x' }, 'meta'],
    ['an emoji change under people', ['people'], (d: Doc) => { d.teams[0]!.emoji = '🎯' }, 'meta'],
  ])('%s', (_, sections, mutate, group) => {
    const v = audit({ teamId: 'a', sections }, mutate)
    expect(v).toHaveLength(1)
    expect(v[0]).toContain(group)
  })

  test("prefs changed without naming 'prefs' — including the locale", () => {
    expect(audit({ teamId: 'a', sections: ['notes'] }, (d) => { d.prefs.locale = 'pt-BR' })).toHaveLength(1)
    expect(audit({ sections: ['notes'] }, (d) => { d.prefs.fontSize = 'XL' })).toHaveLength(1)
    expect(audit({ teamId: 'a' }, (d) => { d.prefs.fontSize = 'XL' })).toHaveLength(1) // prefs are not team data
  })

  test("templates changed without naming 'templates'", () => {
    expect(audit({ sections: ['prefs'] }, (d) => { d.templates.push({ id: 't', name: 'T', scope: 'any', body: 'b' }) })).toHaveLength(1)
  })

  test("a team added, removed or reordered without naming 'teams'", () => {
    expect(audit({ teamId: 'a', sections: ['notes'] }, (d) => { d.teams.push(createEmptyTeam('z', 'Z', '🆕', 'en-US')) })).toHaveLength(1)
    expect(audit({ teamId: 'a', sections: ['notes'] }, (d) => { d.teams.splice(1, 1) })).toHaveLength(1)
    expect(audit({ teamId: 'a', sections: ['notes'] }, (d) => { d.teams.reverse() })).toHaveLength(1)
    expect(audit({ sections: ['prefs'] }, (d) => { d.teams.reverse() })).toHaveLength(1)
  })

  test('every violation is reported, not just the first', () => {
    const v = audit({ teamId: 'a', sections: ['notes'] }, (d) => {
      d.teams[0]!.actionItems.length = 0; d.teams[1]!.risks.length = 0; d.prefs.fontSize = 'XL'
    })
    expect(v).toHaveLength(3)
  })
})

describe('navViolations', () => {
  const nav = (mutate: (d: Doc) => void): string[] => {
    const doc = makeDoc()
    const before = snapshot(doc)
    mutate(doc)
    return navViolations(before, snapshot(doc))
  }

  test('changes to doc.nav are fine', () => {
    expect(nav((d) => { d.nav.focusedPane = 1; d.nav.activeTeamId = 'b'; d.nav.split = true })).toEqual([])
  })

  test('content, prefs, templates and the team list are not', () => {
    expect(nav((d) => { d.teams[0]!.dailyNotes['2026-01-01'] = 'x' })).toHaveLength(1)
    expect(nav((d) => { d.teams[0]!.name = 'x' })).toHaveLength(1)
    expect(nav((d) => { d.prefs.fontSize = 'XL' })).toHaveLength(1)
    expect(nav((d) => { d.templates.push({ id: 't', name: 'T', scope: 'any', body: 'b' }) })).toHaveLength(1)
    expect(nav((d) => { d.teams.pop() })).toHaveLength(1)
  })
})

describe('wrapStore', () => {
  test('createStore() in this suite is already audited (the setup file installs it)', () => {
    const store = createStore(makeDoc())
    const v = expectScopeViolations(() => {
      store.update((d) => { d.teams[1]!.generalNotes = 'x' }, { teamId: 'a', sections: ['notes'] })
    })
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('scope-contract.test.ts') // the call site is named
  })

  test('honest updates leave the log empty and still behave exactly like the store', () => {
    const store = createStore(makeDoc())
    const seen: (ChangeScope | null)[] = []
    store.subscribe((s) => seen.push(s))
    const rev = store.rev
    expect(expectScopeViolations(() => {
      store.update((d) => { d.teams[0]!.generalNotes = 'x' }, { teamId: 'a', sections: ['notes'] })
      store.update((d) => { d.teams[0]!.name = 'y' })
    })).toEqual([])
    expect(store.doc.teams[0]!.generalNotes).toBe('x')
    expect(store.rev).toBe(rev + 2)
    expect(store.dirty).toBe(true)
    expect(seen).toEqual([{ teamId: 'a', sections: ['notes'] }, null])
  })

  test('live getters stay live and updateNav is audited', () => {
    const store = createStore(makeDoc())
    expect(store.doc).toBe(store.doc)
    const v = expectScopeViolations(() => {
      store.updateNav((d) => { d.nav.focusedPane = 1 })
      store.updateNav((d) => { d.teams[0]!.generalNotes = 'content in a nav update' })
    })
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('updateNav changed team "a"')
  })

  test('composes with vi.spyOn (a spy installed on the store still calls through the audit)', () => {
    const store = createStore(makeDoc())
    const spy = vi.spyOn(store, 'update')
    const v = expectScopeViolations(() => {
      store.update((d) => { d.teams[1]!.generalNotes = 'x' }, { teamId: 'a', sections: ['notes'] })
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(v).toHaveLength(1)
  })

  test('a callback that throws is not swallowed, and nothing is logged for it', () => {
    const store = createStore(makeDoc())
    expect(() => expectScopeViolations(() => {
      store.update(() => { throw new Error('boom') }, { teamId: 'a', sections: ['notes'] })
    })).toThrow('boom')
  })

  test('a read-only store runs no callback, so there is nothing to audit', () => {
    const store = createStore(makeDoc())
    store.setReadOnly(true, { silent: true })
    expect(expectScopeViolations(() => {
      store.update((d) => { d.teams[1]!.generalNotes = 'x' }, { teamId: 'a', sections: ['notes'] })
    })).toEqual([])
  })

  test('can be switched off for a file or a block, and back on', () => {
    const store = createStore(makeDoc())
    setScopeContractEnabled(false)
    try {
      expect(expectScopeViolations(() => {
        store.update((d) => { d.teams[1]!.generalNotes = 'x' }, { teamId: 'a', sections: ['notes'] })
        store.updateNav((d) => { d.teams[2]!.generalNotes = 'y' })
      })).toEqual([])
    } finally { setScopeContractEnabled(true) }
    expect(expectScopeViolations(() => {
      store.update((d) => { d.teams[1]!.generalNotes = 'z' }, { teamId: 'a', sections: ['notes'] })
    })).toHaveLength(1)
  })

  test('wrapStore can be applied to a bare store and returns the same object', () => {
    const store = createStore(makeDoc())
    expect(wrapStore(store)).toBe(store)
  })
})
