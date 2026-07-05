import { locsConflict, openLoc, navigateHistory, currentLoc } from '../src/core/nav'
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
  const back = navigateHistory(p, -1, null)!
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
  const back = navigateHistory(p, -1, actions('t1'))!
  expect(currentLoc(back)).toEqual(daily('t1', '2026-07-01'))
})

test('navigateHistory returns null when nothing valid', () => {
  const p = pane(daily('t1', '2026-07-02'))
  expect(navigateHistory(p, -1, null)).toBeNull()
})
