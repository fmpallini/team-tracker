import { locsConflict, openLoc, navigateHistory, currentLoc, lastLocForTeam, latestReachableIndex, reachableHistory } from '../src/core/nav'
import type { Loc, PaneState } from '../src/core/types'

const daily = (team: string, date: string): Loc => ({ teamId: team, ref: { kind: 'daily', date } })
const actions = (team: string): Loc => ({ teamId: team, ref: { kind: 'actions' } })
const person = (team: string, id: string): Loc => ({ teamId: team, ref: { kind: 'person', personId: id, group: 'members' } })
const pane = (...locs: Loc[]): PaneState => ({ history: locs, index: locs.length - 1 })

test('conflict rules', () => {
  expect(locsConflict(daily('t1', '2026-07-02'), daily('t1', '2026-07-02'))).toBe(true)
  expect(locsConflict(daily('t1', '2026-07-02'), daily('t1', '2026-07-01'))).toBe(false)
  expect(locsConflict(person('t1', 'p1'), person('t1', 'p2'))).toBe(false)
  expect(locsConflict(person('t1', 'p1'), person('t1', 'p1'))).toBe(true)
  expect(locsConflict(actions('t1'), actions('t1'))).toBe(true)
  expect(locsConflict(actions('t1'), actions('t2'))).toBe(false)
  expect(locsConflict(actions('t1'), null)).toBe(false)
})

test('openLoc pushes and truncates forward', () => {
  let p = pane(actions('t1'))
  const r = openLoc(p, daily('t1', '2026-07-02'), null)
  expect(r.type).toBe('opened')
  p = (r as any).pane
  expect(p.history.length).toBe(2); expect(p.index).toBe(1)
  const back = navigateHistory(p, -1, null, 't1')!
  const r2 = openLoc(back, daily('t1', '2026-07-01'), null)
  expect((r2 as any).pane.history.map((l: Loc) => (l.ref as any).date ?? l.ref.kind))
    .toEqual(['actions', '2026-07-01'])
})

test('openLoc conflicting target focuses other pane', () => {
  const r = openLoc(pane(), daily('t1', '2026-07-02'), daily('t1', '2026-07-02'))
  expect(r.type).toBe('focusOther')
})

test('navigateHistory skips conflicting entries', () => {
  const p = pane(daily('t1', '2026-07-01'), actions('t1'), daily('t1', '2026-07-02'))
  // outro painel está mostrando actions t1 → voltar deve pular actions e cair em 01/07
  const back = navigateHistory(p, -1, actions('t1'), 't1')!
  expect(currentLoc(back)).toEqual(daily('t1', '2026-07-01'))
})

test('navigateHistory returns null when nothing valid', () => {
  const p = pane(daily('t1', '2026-07-02'))
  expect(navigateHistory(p, -1, null, 't1')).toBeNull()
})

describe('lastLocForTeam', () => {
  test('finds the most recent Loc belonging to the given team', () => {
    const p = pane(actions('t1'), daily('t2', '2026-07-01'), person('t1', 'p1'), daily('t2', '2026-07-02'))
    expect(lastLocForTeam(p, 't1')).toEqual(person('t1', 'p1'))
    expect(lastLocForTeam(p, 't2')).toEqual(daily('t2', '2026-07-02'))
  })

  test('returns null when the pane never held that team', () => {
    const p = pane(actions('t1'))
    expect(lastLocForTeam(p, 't3')).toBeNull()
  })

  test('returns null for an empty pane', () => {
    expect(lastLocForTeam(pane(), 't1')).toBeNull()
  })
})

describe('team-scoped history walk', () => {
  test("navigateHistory skips other teams' entries in both directions", () => {
    const p: PaneState = { history: [actions('t1'), actions('t2'), daily('t1', '2026-07-01'), actions('t2'), daily('t1', '2026-07-02')], index: 2 }
    expect(navigateHistory(p, -1, null, 't1')!.index).toBe(0)
    expect(navigateHistory(p, 1, null, 't1')!.index).toBe(4)
    expect(navigateHistory(p, -1, null, 't2')!.index).toBe(1)
  })

  test("returns null when only other teams' entries lie that way, or with no active team", () => {
    const p: PaneState = { history: [actions('t2'), daily('t1', '2026-07-01')], index: 1 }
    expect(navigateHistory(p, -1, null, 't1')).toBeNull()
    expect(navigateHistory(p, -1, null, null)).toBeNull()
  })

  test('skips an entry that is the very spot the pane is already on (team switch away and back repeats it)', () => {
    // t1: A, B, C — switched to t2 (X) and back to t1, which re-pushed C.
    const p: PaneState = { history: [actions('t1'), daily('t1', '2026-07-01'), person('t1', 'p1'), actions('t2'), person('t1', 'p1')], index: 4 }
    expect(navigateHistory(p, -1, null, 't1')!.index).toBe(1)
  })

  test("openLoc drops only the target team's forward entries, keeping other teams' (their last-used module survives)", () => {
    const p: PaneState = { history: [actions('t1'), daily('t1', '2026-07-01'), actions('t2'), daily('t1', '2026-07-02')], index: 0 }
    const r = openLoc(p, person('t1', 'p1'), null)
    if (r.type !== 'opened') throw new Error('expected opened')
    expect(r.pane.history).toEqual([actions('t1'), actions('t2'), person('t1', 'p1')])
    expect(r.pane.index).toBe(2)
    expect(lastLocForTeam(r.pane, 't2')).toEqual(actions('t2'))
  })
})

describe('latestReachableIndex', () => {
  test('newest entry of the team ahead of the current index', () => {
    const p: PaneState = { history: [actions('t1'), daily('t1', '2026-07-01'), daily('t1', '2026-07-02')], index: 0 }
    expect(latestReachableIndex(p, null, 't1')).toBe(2)
  })

  test("skips other teams' entries and a conflicting newest entry", () => {
    const p: PaneState = { history: [actions('t1'), daily('t1', '2026-07-01'), person('t1', 'p1'), actions('t2')], index: 0 }
    expect(latestReachableIndex(p, person('t1', 'p1'), 't1')).toBe(1)
  })

  test('-1 at the newest entry, when everything ahead is unreachable, or with no active team', () => {
    expect(latestReachableIndex(pane(actions('t1'), daily('t1', '2026-07-01')), null, 't1')).toBe(-1)
    const p: PaneState = { history: [daily('t1', '2026-07-01'), actions('t1')], index: 0 }
    expect(latestReachableIndex(p, actions('t1'), 't1')).toBe(-1)
    expect(latestReachableIndex(p, null, null)).toBe(-1)
    // the only newer entry repeats the current spot
    const q: PaneState = { history: [actions('t1'), actions('t2'), actions('t1')], index: 0 }
    expect(latestReachableIndex(q, null, 't1')).toBe(-1)
  })
})

describe('reachableHistory', () => {
  test("lists the team's entries newest first and flags the current one", () => {
    const p: PaneState = { history: [actions('t1'), actions('t2'), daily('t1', '2026-07-01'), person('t1', 'p1')], index: 2 }
    const out = reachableHistory(p, null, 't1')
    expect(out.map((e) => e.index)).toEqual([3, 2, 0])
    expect(out.map((e) => e.current)).toEqual([false, true, false])
  })

  test('drops entries conflicting with the other pane but keeps the current one', () => {
    const p: PaneState = { history: [actions('t1'), daily('t1', '2026-07-01'), actions('t1')], index: 2 }
    expect(reachableHistory(p, actions('t1'), 't1').map((e) => e.index)).toEqual([2, 1])
  })

  test('collapses consecutive repeats of one location, preferring the current entry as its representative', () => {
    const repeated: PaneState = { history: [actions('t1'), daily('t1', '2026-07-01'), actions('t2'), daily('t1', '2026-07-01')], index: 1 }
    const out = reachableHistory(repeated, null, 't1')
    expect(out.map((e) => e.index)).toEqual([1, 0])
    expect(out[0]!.current).toBe(true)
    const notCurrent: PaneState = { history: [daily('t1', '2026-07-01'), actions('t2'), daily('t1', '2026-07-01'), actions('t1')], index: 3 }
    expect(reachableHistory(notCurrent, null, 't1').map((e) => e.loc.ref.kind)).toEqual(['actions', 'daily'])
  })

  test('empty with no active team', () => {
    expect(reachableHistory(pane(actions('t1')), null, null)).toEqual([])
  })
})
