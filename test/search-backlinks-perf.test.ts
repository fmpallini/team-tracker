// test/search-backlinks-perf.test.ts — regression guard for the cost shape
// of backlink lookups. Before backlinksFor existed, every chip render (e.g.
// action-items.ts's renderCard, once per kanban card) re-walked every
// free-text field in the team from scratch. backlinksFor's shared,
// rev-cached index must instead pay that per-team scan once and serve
// repeat lookups from cache, so its cost stays ~flat as the number of
// lookups grows. The "cold" baseline below reproduces the old cost shape by
// building a fresh index on every call (no cache reuse across calls) — the
// same scan createSearchIndex does internally, just paid every time instead
// of once. This is a relative-timing comparison (not an absolute ms
// budget), so it stays meaningful across slower/faster machines and CI
// runners: both shapes run back-to-back against the same fixture, and only
// their ratio is asserted.
import { createSearchIndex, backlinksFor } from '../src/core/search'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

const DAILY_NOTE_COUNT = 150
const ACTION_ITEM_COUNT = 150
const LOOKUP_COUNT = 150

function largeFixture(): Doc {
  const doc = createEmptyDocument('en-US')
  const team: Team = {
    id: 't1', name: 'Alpha', emoji: '🧭', stakeholders: [], members: [],
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
  doc.teams.push(team)
  return doc
}

function timeIt(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

test('backlinksFor scales far better than an uncached lookup under repeat calls', () => {
  const doc = largeFixture()

  // "Cold" baseline: a fresh SearchIndex (and therefore a fresh per-team
  // scan) on every single lookup — the cost shape the old per-render
  // collectBacklinks call had, with no cache to reuse across calls.
  const coldMs = timeIt(() => {
    for (let i = 0; i < LOOKUP_COUNT; i++) {
      const index = createSearchIndex(() => doc, () => 0)
      expect(index.backlinks('t1', 'action', 'a0')).toHaveLength(1)
    }
  })

  // Real usage shape: one Store, one shared cached index behind
  // backlinksFor — the first call pays the scan, the rest are cache hits.
  const store = createStore(doc)
  const cachedMs = timeIt(() => {
    for (let i = 0; i < LOOKUP_COUNT; i++) {
      expect(backlinksFor(store, 't1', 'action', 'a0')).toHaveLength(1)
    }
  })

  // Generous margin (not a tight bound) so this stays robust on slower CI
  // runners while still catching a regression back to a rebuild-per-call shape.
  expect(cachedMs).toBeLessThan(coldMs / 3)
})
