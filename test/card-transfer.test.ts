import {
  duplicateActionItem, duplicateMilestone, duplicateRisk,
  transferActionItem, transferMilestone, transferRisk,
} from '../src/core/card-transfer'
import type { Team } from '../src/core/types'

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 't1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

describe('duplicateActionItem', () => {
  test('appends a copy with a new id and order at the end', () => {
    const tm = team({ actionItems: [
      { id: 'a1', summary: 'Do thing', notes: 'ping @[Ana](person:p1)', status: 'todo', dueDate: null, assignee: 'Bob', color: 'ledger', order: 0 },
    ] })
    duplicateActionItem(tm, 'a1')
    expect(tm.actionItems).toHaveLength(2)
    const copy = tm.actionItems[1]!
    expect(copy.id).not.toBe('a1')
    expect(copy.summary).toBe('Do thing')
    expect(copy.assignee).toBe('Bob')
    expect(copy.notes).toBe('ping @[Ana](person:p1)') // same-team duplicate: refs stay live
    expect(copy.order).toBe(1)
  })

  test('no-ops when the id is not found', () => {
    const tm = team()
    duplicateActionItem(tm, 'missing')
    expect(tm.actionItems).toHaveLength(0)
  })
})

describe('duplicateMilestone', () => {
  test('appends a copy with a new id', () => {
    const tm = team({ milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix](action:a1)' }] })
    duplicateMilestone(tm, 'm1')
    expect(tm.milestones).toHaveLength(2)
    expect(tm.milestones[1]!.id).not.toBe('m1')
    expect(tm.milestones[1]!.title).toBe('Ship')
    expect(tm.milestones[1]!.followup).toBe('blocked by @[Fix](action:a1)')
  })
})

describe('duplicateRisk', () => {
  test('appends a copy with a new id and order at the end', () => {
    const tm = team({ risks: [{ id: 'r1', title: 'Vendor delay', chance: 2, impact: 2, plan: 'mitigate', followup: '', order: 0, closed: false }] })
    duplicateRisk(tm, 'r1')
    expect(tm.risks).toHaveLength(2)
    expect(tm.risks[1]!.id).not.toBe('r1')
    expect(tm.risks[1]!.order).toBe(1)
  })
})

describe('transferActionItem', () => {
  function twoTeams(): [Team, Team] {
    return [
      team({ id: 'from', actionItems: [{ id: 'a1', summary: 'Do thing', notes: 'ping @[Ana](person:p1)', status: 'todo', dueDate: null, assignee: 'Bob', color: 'ledger', order: 0 }] }),
      team({ id: 'to' }),
    ]
  }

  test('copy: appends a stripped-refs copy to the target team, leaves source untouched', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'a1', 'from', 'to', 'copy')
    expect(from.actionItems).toHaveLength(1) // untouched
    expect(to.actionItems).toHaveLength(1)
    const copy = to.actionItems[0]!
    expect(copy.id).not.toBe('a1')
    expect(copy.notes).toBe('ping Ana') // ref flattened to plain text
    expect(copy.assignee).toBe('Bob') // already plain text, untouched
    expect(copy.order).toBe(0)
  })

  test('move: appends to target and removes from source', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'a1', 'from', 'to', 'move')
    expect(from.actionItems).toHaveLength(0)
    expect(to.actionItems).toHaveLength(1)
  })

  test('move: unlinks dangling refs to the moved item elsewhere in the source team', () => {
    const [from, to] = twoTeams()
    from.actionItems.push({ id: 'a2', summary: 'Follow up', notes: 'see @[Do thing](action:a1)', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 1 })
    transferActionItem([from, to], 'a1', 'from', 'to', 'move')
    expect(from.actionItems).toHaveLength(1)
    expect(from.actionItems[0]!.notes).toBe('see Do thing') // ref flattened, not left dangling
  })

  test('no-ops when the item id is not found', () => {
    const [from, to] = twoTeams()
    transferActionItem([from, to], 'missing', 'from', 'to', 'copy')
    expect(to.actionItems).toHaveLength(0)
  })
})

describe('transferMilestone', () => {
  test('copy strips refs from followup', () => {
    const from = team({ id: 'from', milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix](action:a1)' }] })
    const to = team({ id: 'to' })
    transferMilestone([from, to], 'm1', 'from', 'to', 'copy')
    expect(to.milestones[0]!.followup).toBe('blocked by Fix')
    expect(from.milestones).toHaveLength(1)
  })

  test('move removes from source', () => {
    const from = team({ id: 'from', milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: '' }] })
    const to = team({ id: 'to' })
    transferMilestone([from, to], 'm1', 'from', 'to', 'move')
    expect(from.milestones).toHaveLength(0)
    expect(to.milestones).toHaveLength(1)
  })

  test('move: unlinks dangling refs to the moved milestone elsewhere in the source team', () => {
    const from = team({
      id: 'from',
      milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship', done: false, followup: '' }],
      dailyNotes: { '2026-07-20': 'waiting on @[Ship](milestone:m1)' },
    })
    const to = team({ id: 'to' })
    transferMilestone([from, to], 'm1', 'from', 'to', 'move')
    expect(from.milestones).toHaveLength(0)
    expect(from.dailyNotes['2026-07-20']).toBe('waiting on Ship') // ref flattened, not left dangling
  })
})

describe('transferRisk', () => {
  test('copy strips refs from followup and resets order', () => {
    const from = team({ id: 'from', risks: [{ id: 'r1', title: 'Vendor delay', chance: 2, impact: 2, plan: 'mitigate', followup: 'see @[Ana](person:p1)', order: 3, closed: false }] })
    const to = team({ id: 'to', risks: [{ id: 'r0', title: 'Existing', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }] })
    transferRisk([from, to], 'r1', 'from', 'to', 'copy')
    expect(to.risks).toHaveLength(2)
    const copy = to.risks[1]!
    expect(copy.followup).toBe('see Ana')
    expect(copy.order).toBe(1)
    expect(from.risks).toHaveLength(1)
  })

  test('move removes from source', () => {
    const from = team({ id: 'from', risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }] })
    const to = team({ id: 'to' })
    transferRisk([from, to], 'r1', 'from', 'to', 'move')
    expect(from.risks).toHaveLength(0)
  })

  test('move: unlinks dangling refs to the moved risk elsewhere in the source team', () => {
    const from = team({
      id: 'from',
      risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      dailyNotes: { '2026-07-20': 'tracking @[Vendor delay](risk:r1)' },
    })
    const to = team({ id: 'to' })
    transferRisk([from, to], 'r1', 'from', 'to', 'move')
    expect(from.risks).toHaveLength(0)
    expect(from.dailyNotes['2026-07-20']).toBe('tracking Vendor delay') // ref flattened, not left dangling
  })
})
