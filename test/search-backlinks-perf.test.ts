// test/search-backlinks-perf.test.ts — regression guard for the cost shape
// of backlink lookups. Every chip render (e.g. action-items.ts's renderCard,
// once per kanban card) calls SearchIndex.backlinks(). A single document-wide
// index (ui/panes.ts's createPaneManager builds one and wires it into every
// module's ModuleCtx) must pay the per-team scan once and serve repeat
// lookups from cache, so its cost stays ~flat as the number of lookups
// grows — and a scoped store.update() must drop only the affected team's
// cache entry, not every team's. The "cold" baseline below reproduces the
// no-cache-reuse cost shape by building a fresh index on every call — the
// same scan createSearchIndex does internally, just paid every time instead
// of once. These are relative-timing comparisons (not absolute ms budgets),
// so they stay meaningful across slower/faster machines and CI runners: both
// shapes run back-to-back against the same fixture, and only their ratio is
// asserted.
import { createSearchIndex } from '../src/core/search'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

const DAILY_NOTE_COUNT = 150
const ACTION_ITEM_COUNT = 150
const LOOKUP_COUNT = 150

function buildLargeTeam(id: string, name: string): Team {
  const team: Team = {
    id, name, emoji: '🧭', stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  for (let i = 0; i < DAILY_NOTE_COUNT; i++) {
    const date = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}-${i}`
    team.dailyNotes[date] = `Standup notes for day ${i}. Discussed rollout plans, blockers, and follow-ups. `.repeat(4)
  }
  for (let i = 0; i < ACTION_ITEM_COUNT; i++) {
    team.actionItems.push({
      id: `a${i}`, summary: `Task number ${i} covering rollout work`, status: 'todo', color: 'ledger',
      dueDate: null, assignee: 'Ana',
      notes: `Some longer notes about task ${i} with background context and details. `.repeat(4),
      order: i,
    })
  }
  // A single mention buried in the last daily note — the one thing both
  // paths must actually find on every lookup below.
  const lastDate = Object.keys(team.dailyNotes).pop()!
  team.dailyNotes[lastDate] += ' Blocked on @[Task number 0 covering rollout work](action:a0) landing first.'
  return team
}

function largeFixture(): Doc {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(buildLargeTeam('t1', 'Alpha'))
  return doc
}

/** Mirrors the wiring ui/panes.ts's createPaneManager does once per document. */
function wiredIndex(store: ReturnType<typeof createStore>) {
  const index = createSearchIndex(() => store.doc, () => store.rev)
  store.subscribe((scope) => index.invalidate(scope))
  return index
}

function timeIt(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

test('a shared index scales far better than an uncached lookup under repeat calls', () => {
  const doc = largeFixture()

  // "Cold" baseline: a fresh SearchIndex (and therefore a fresh per-team
  // scan) on every single lookup — the cost shape a per-render lookup would
  // have with no cache to reuse across calls.
  const coldMs = timeIt(() => {
    for (let i = 0; i < LOOKUP_COUNT; i++) {
      const index = createSearchIndex(() => doc, () => 0)
      expect(index.backlinks('t1', 'action', 'a0')).toHaveLength(1)
    }
  })

  // Real usage shape: one Store, one shared cached index (as wired into
  // every module's ModuleCtx) — the first call pays the scan, the rest are
  // cache hits.
  const store = createStore(doc)
  const index = wiredIndex(store)
  const cachedMs = timeIt(() => {
    for (let i = 0; i < LOOKUP_COUNT; i++) {
      expect(index.backlinks('t1', 'action', 'a0')).toHaveLength(1)
    }
  })

  // Generous margin (not a tight bound) so this stays robust on slower CI
  // runners while still catching a regression back to a rebuild-per-call shape.
  expect(cachedMs).toBeLessThan(coldMs / 3)
})

test('a cold backlinks() lookup skips the stripMd/normalize pass that only search() needs', () => {
  const doc = largeFixture()

  // backlinks() only needs a raw-text mention regex scan. search()
  // additionally runs stripMd (several regexes per line) + normalize (an NFD
  // pass) over every field of every candidate. Building both halves together
  // (the old single TeamIndex) made a chip render pay search()'s cost; the
  // split means a cold backlinks() lookup is materially cheaper.
  const REPS = 40
  const backlinksMs = timeIt(() => {
    for (let i = 0; i < REPS; i++) {
      const index = createSearchIndex(() => doc, () => 0)
      expect(index.backlinks('t1', 'action', 'a0')).toHaveLength(1)
    }
  })
  const searchMs = timeIt(() => {
    for (let i = 0; i < REPS; i++) {
      const index = createSearchIndex(() => doc, () => 0)
      expect(index.search('rollout', 't1').length).toBeGreaterThan(0)
    }
  })

  // Generous margin (same reasoning as the other tests here): near-parity
  // would mean backlinks() is still doing the strip/normalize work.
  expect(backlinksMs).toBeLessThan(searchMs / 2)
})

test('scoped invalidation makes reading an unedited team far cheaper than reading the team being edited', () => {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(buildLargeTeam('t1', 'Alpha'), buildLargeTeam('t2', 'Beta'))
  const store = createStore(doc)
  const index = wiredIndex(store)

  // Warm both teams' cache entries once before timing either loop.
  expect(index.backlinks('t1', 'action', 'a0')).toHaveLength(1)
  expect(index.backlinks('t2', 'action', 'a0')).toHaveLength(1)

  const EDIT_COUNT = 60
  let toggle = false
  function editT1(): void {
    toggle = !toggle
    store.update((d) => {
      d.teams[0]!.generalNotes = toggle ? 'noise a' : 'noise b'
    }, { teamId: 't1', sections: ['notes'] })
  }

  // Each edit to t1 forces t1's own next lookup to pay a real rebuild —
  // that's correct, not a regression.
  const editedTeamMs = timeIt(() => {
    for (let i = 0; i < EDIT_COUNT; i++) {
      editT1()
      expect(index.backlinks('t1', 'action', 'a0')).toHaveLength(1)
    }
  })

  // t2 was never touched by any of those edits. With scoped invalidation,
  // its cache entry survives every one of them — these should all be cache
  // hits, not full team-text rescans.
  const untouchedTeamMs = timeIt(() => {
    for (let i = 0; i < EDIT_COUNT; i++) {
      editT1()
      expect(index.backlinks('t2', 'action', 'a0')).toHaveLength(1)
    }
  })

  // Generous margin, same reasoning as the test above.
  expect(untouchedTeamMs).toBeLessThan(editedTeamMs / 3)
})
