// Nav-only mutations (store.updateNav — pane focus, history steps, team switch)
// bump store.rev without describing a content change. The search index used to
// treat that undescribed rev move as "anything may have changed" and drop every
// team's caches on the next read, so each pane click threw away the expensive
// strip + normalize pass. These tests pin the contract that fixes it, using
// real wiring (createPaneManager owns the index). Cost metric: collectCandidates
// formats one title per daily note (i18n.formatDate), so counting those calls
// counts how many candidates were (re)collected for a cache rebuild.
import { vi } from 'vitest'

vi.mock('../src/core/i18n', async (orig) => {
  const mod = await orig<typeof import('../src/core/i18n')>()
  return { ...mod, formatDate: vi.fn(mod.formatDate) }
})

import { formatDate } from '../src/core/i18n'
import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createSearchIndex, type SearchIndex } from '../src/core/search'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const TEAMS = 6
const NOTES = 20

function setup(): { store: Store; pm: PaneManager; index: SearchIndex } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  for (let t = 0; t < TEAMS; t++) {
    const team = createEmptyTeam(`t${t}`, `Team ${t}`, '🚀', 'en-US')
    team.actionItems.push({ id: `a${t}`, summary: `Item ${t}`, status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: '' })
    for (let d = 0; d < NOTES; d++) {
      const date = `2026-06-${String(d + 1).padStart(2, '0')}`
      team.dailyNotes[date] = `Note ${date} team ${t} mentions @[Item ${t}](action:a${t}) and some body text`
    }
    doc.teams.push(team)
  }
  doc.nav.activeTeamId = 't0'
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US') as PaneManager & { searchIndex: SearchIndex }
  return { store, pm, index: pm.searchIndex }
}

const strips = (): number => vi.mocked(formatDate).mock.calls.length
const resetStrips = (): void => { vi.mocked(formatDate).mockClear() }

afterEach(() => { document.body.innerHTML = '' })

test('baseline: a full-document search collects every candidate once, a repeat collects none', () => {
  const { index } = setup()
  resetStrips()
  index.search('zzznomatch', null)
  const cold = strips()
  expect(cold).toBeGreaterThanOrEqual(TEAMS * NOTES)
  resetStrips()
  index.search('zzznomatch2', null)
  expect(strips()).toBe(0)
})

test('a nav-only mutation keeps the prepared search candidates (no re-strip on the next query)', () => {
  const { store, index } = setup()
  index.search('zzznomatch', null)
  resetStrips()

  store.updateNav((d) => { d.nav.focusedPane = d.nav.focusedPane === 0 ? 1 : 0 })
  index.search('zzznomatch2', null)

  console.log(`[metric] candidates re-collected after one nav mutation: ${strips()}`)
  expect(strips()).toBe(0)
})

test('a nav-only mutation keeps the cached backlinks (same array reference)', () => {
  const { store, index } = setup()
  const before = index.backlinks('t1', 'action', 'a1')
  expect(before.length).toBe(NOTES)

  store.updateNav((d) => { d.nav.focusedPane = 1 })
  store.updateNav((d) => { d.nav.focusedPane = 0 })

  expect(index.backlinks('t1', 'action', 'a1')).toBe(before)
})

test('many consecutive nav mutations never cost a re-strip', () => {
  const { store, index } = setup()
  index.search('zzznomatch', null)
  resetStrips()
  for (let i = 0; i < 25; i++) {
    store.updateNav((d) => { d.nav.focusedPane = i % 2 === 0 ? 1 : 0 })
    index.search(`zzznomatch${i}`, null)
  }
  expect(strips()).toBe(0)
})

test('a scoped content edit after a nav mutation still invalidates just that team', () => {
  const { store, index } = setup()
  const t2Before = index.backlinks('t2', 'action', 'a2')
  store.updateNav((d) => { d.nav.focusedPane = 1 })

  store.update((d) => {
    d.teams[1]!.dailyNotes['2026-06-01'] = 'no mention any more'
  }, { teamId: 't1', sections: ['notes'] })

  expect(index.backlinks('t1', 'action', 'a1')).toHaveLength(NOTES - 1) // edited team refreshed
  expect(index.backlinks('t2', 'action', 'a2')).toBe(t2Before)          // untouched team still cached
})

test('an unscoped content edit after a nav mutation clears everything', () => {
  const { store, index } = setup()
  index.search('zzznomatch', null)
  store.updateNav((d) => { d.nav.focusedPane = 1 })
  resetStrips()

  store.update((d) => { d.teams[0]!.name = 'Renamed' })
  index.search('zzznomatch2', null)
  expect(strips()).toBeGreaterThanOrEqual(TEAMS * NOTES)
})

test('search sees an edit made between two nav mutations (no stale hit served)', () => {
  const { store, index } = setup()
  expect(index.search('freshword', null)).toHaveLength(0)
  store.updateNav((d) => { d.nav.focusedPane = 1 })
  store.update((d) => {
    d.teams[2]!.dailyNotes['2026-06-01'] = 'a freshword appears'
  }, { teamId: 't2', sections: ['notes'] })
  store.updateNav((d) => { d.nav.focusedPane = 0 })

  const hits = index.search('freshword', null)
  expect(hits).toHaveLength(1)
  expect(hits[0]!.loc.teamId).toBe('t2')
})

test('replaceDoc after nav mutations serves the new document, not cached candidates', () => {
  const { store, index } = setup()
  index.search('zzznomatch', null)
  store.updateNav((d) => { d.nav.focusedPane = 1 })

  const replacement = createEmptyDocument('en-US')
  const team = createEmptyTeam('x1', 'Other', '🎯', 'en-US')
  team.dailyNotes['2026-06-01'] = 'replacement-only needle'
  replacement.teams.push(team)
  store.replaceDoc(replacement)

  expect(index.search('needle', null).map((r) => r.loc.teamId)).toEqual(['x1'])
})

test('a content edit landing inside a subscriber-triggered nav mutation is still described', () => {
  // A subscriber that itself calls updateNav (the team-delete resync does) must
  // not make the index believe the content edit was already accounted for.
  const { store, index } = setup()
  index.search('zzznomatch', null)
  const unsub = store.subscribe(() => { store.updateNav((d) => { d.nav.focusedPane = 1 }) })

  store.update((d) => {
    d.teams[3]!.dailyNotes['2026-06-01'] = 'inside-edit needle'
  }, { teamId: 't3', sections: ['notes'] })
  unsub()

  expect(index.search('needle', null).map((r) => r.loc.teamId)).toEqual(['t3'])
})

describe('acknowledgeNav on a bare index (rev bookkeeping)', () => {
  function bare() {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('t0', 'Team 0', '🚀', 'en-US')
    team.dailyNotes['2026-06-01'] = 'needle one'
    doc.teams.push(team)
    let rev = 0
    const index = createSearchIndex(() => doc, () => rev)
    return { doc, index, bump: () => { rev++ }, team }
  }

  test('an undescribed rev move is still dropped (the safe default)', () => {
    const { index, bump, team } = bare()
    expect(index.search('needle', null)).toHaveLength(1)
    bump()
    team.dailyNotes['2026-06-02'] = 'needle two' // content changed, nobody said so
    expect(index.search('needle', null)).toHaveLength(2)
  })

  test('acknowledged exactly one rev ahead keeps the caches', () => {
    const { index, bump } = bare()
    index.search('needle', null)
    resetStrips()
    bump(); index.acknowledgeNav()
    index.search('needle two', null)
    expect(strips()).toBe(0)
  })

  test('acknowledgement is ignored when two revs went by (an undescribed change is in between)', () => {
    const { index, bump, team } = bare()
    index.search('needle', null)
    bump() // undescribed content change
    team.dailyNotes['2026-06-02'] = 'needle two'
    bump(); index.acknowledgeNav() // nav lands on top of it
    expect(index.search('needle', null)).toHaveLength(2)
  })

  test('acknowledging before the first read is harmless', () => {
    const { index, bump } = bare()
    bump(); index.acknowledgeNav()
    expect(index.search('needle', null)).toHaveLength(1)
  })
})
