// test/search-incremental-memory.test.ts — retention guard for the incremental
// search index.
//
// A stale cache entry is kept so the next read can reuse its prepared fields;
// every read then replaces it. Nothing from an earlier generation may outlive
// the read that superseded it, or a long editing session would grow the heap
// with every keystroke. This drives many edit/search/backlinks cycles over a
// rich document and asserts the heap settles instead of climbing.
//
// Turns on V8's gc hook from inside the worker (same approach as
// test/search-memory.test.ts), so `npm test` needs no extra flags.
import v8 from 'node:v8'
import vm from 'node:vm'
import { createSearchIndex } from '../src/core/search'
import { createStore } from '../src/core/store'
import { buildRichDoc } from './search-fixture'
import { setScopeContractEnabled } from './scope-contract'

// 1700 edit cycles over a multi-megabyte document: snapshotting the document
// around each update (the scope audit) would dominate the run, and it retains
// nothing, so it has no bearing on what is measured here.
beforeAll(() => setScopeContractEnabled(false))
afterAll(() => setScopeContractEnabled(true))

v8.setFlagsFromString('--expose_gc')
const collect = vm.runInNewContext('gc') as () => void

/** Heap in use, collected to a fixed point — one gc() under-collects, which reads back as an impossibly small delta. */
function heap(): number {
  let previous = Infinity
  for (let i = 0; i < 12; i++) {
    collect()
    const used = process.memoryUsage().heapUsed
    if (Math.abs(used - previous) < previous * 0.005) return used
    previous = used
  }
  return previous
}

test('repeated edit, search and backlink cycles do not grow the heap', () => {
  const store = createStore(buildRichDoc({ teams: 8, dailyNotes: 40, people: 8, actions: 50, milestones: 20, risks: 20 }))
  const index = createSearchIndex(() => store.doc, () => store.rev)
  store.subscribe((scope) => index.invalidate(scope))
  const cycle = (i: number): void => {
    const t = i % 8
    const date = Object.keys(store.doc.teams[t]!.dailyNotes)[3]!
    store.update((d) => { d.teams[t]!.dailyNotes[date] = `edit ${i % 40} rollout @[x](action:t0-a1) ${'y'.repeat(i % 40)}` }, { teamId: `t${t}`, sections: ['notes'] })
    index.search(`zz${i}`, null)
    index.backlinks(`t${t}`, 'action', 't0-a1')
  }

  // Warm every path first: the first cycles legitimately add entries and
  // grow Map capacity once.
  for (let i = 0; i < 200; i++) cycle(i)
  const settled = heap()
  for (let i = 200; i < 1700; i++) cycle(i)
  const grown = heap() - settled

  // 1500 further cycles. Measured growth is tens of KiB of one-off state; a
  // leak of even one superseded generation per cycle (a prepared team is
  // hundreds of KiB) would land orders of magnitude above this.
  expect(grown).toBeLessThan(512 * 1024)
})
