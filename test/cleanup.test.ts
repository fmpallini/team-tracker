import { countCleanupTargets, applyCleanup } from '../src/core/cleanup'
import { createEmptyDocument } from '../src/core/document'
import type { ActionItem, Doc, Milestone, Risk, Team } from '../src/core/types'

function item(overrides: Partial<ActionItem>): ActionItem {
  return { id: 'i1', summary: 'Do thing', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger', ...overrides }
}
function milestone(overrides: Partial<Milestone>): Milestone {
  return { id: 'm1', date: '2026-07-01', title: 'M', done: false, followup: '', ...overrides }
}
function risk(overrides: Partial<Risk>): Risk {
  return { id: 'r1', title: 'R', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false, ...overrides }
}
function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}
function doc(teams: Team[]): Doc {
  const d = createEmptyDocument('en-US')
  d.teams = teams
  return d
}

const TODAY = '2026-07-26'

test('counts and removes done/cancelled action items, keeps active ones', () => {
  const d = doc([team({
    actionItems: [
      item({ id: 'todo', status: 'todo' }),
      item({ id: 'wip', status: 'wip' }),
      item({ id: 'done', status: 'done' }),
      item({ id: 'cancelled', status: 'cancelled' }),
    ],
  })])
  expect(countCleanupTargets(d, 30, TODAY)).toEqual({ actions: 2, milestones: 0, risks: 0, dailyNotes: 0 })
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.actionItems.map((a) => a.id)).toEqual(['todo', 'wip'])
})

test('counts and removes completed milestones, keeps open ones', () => {
  const d = doc([team({
    milestones: [milestone({ id: 'open', done: false }), milestone({ id: 'closed', done: true })],
  })])
  expect(countCleanupTargets(d, 30, TODAY).milestones).toBe(1)
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.milestones.map((m) => m.id)).toEqual(['open'])
})

test('counts and removes closed risks, keeps open ones', () => {
  const d = doc([team({
    risks: [risk({ id: 'open', closed: false }), risk({ id: 'closed', closed: true })],
  })])
  expect(countCleanupTargets(d, 30, TODAY).risks).toBe(1)
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.risks.map((r) => r.id)).toEqual(['open'])
})

test('daily note exactly `days` old survives; one day older is removed', () => {
  const d = doc([team({
    dailyNotes: {
      '2026-06-26': 'exactly 30 days old', // survives
      '2026-06-25': '31 days old', // removed
    },
  })])
  expect(countCleanupTargets(d, 30, TODAY).dailyNotes).toBe(1)
  applyCleanup(d, 30, TODAY)
  expect(Object.keys(d.teams[0]!.dailyNotes)).toEqual(['2026-06-26'])
})

test('zero matches across an empty document', () => {
  const d = doc([team()])
  expect(countCleanupTargets(d, 30, TODAY)).toEqual({ actions: 0, milestones: 0, risks: 0, dailyNotes: 0 })
})

test('purging a done action item unlinks its @mentions elsewhere in the team', () => {
  const d = doc([team({
    actionItems: [item({ id: 'a1', summary: 'Fix bug', status: 'done' })],
    milestones: [milestone({ id: 'm1', followup: 'blocked by @[Fix bug](action:a1)' })],
    dailyNotes: { '2026-07-20': 'see @[Fix bug](action:a1)' },
  })])
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.actionItems).toEqual([])
  expect(d.teams[0]!.milestones[0]!.followup).toBe('blocked by ~Fix bug~')
  expect(d.teams[0]!.dailyNotes['2026-07-20']).toBe('see ~Fix bug~')
})

test('purging a done milestone unlinks its @mentions using the milestone\'s current title', () => {
  const d = doc([team({
    milestones: [milestone({ id: 'm1', title: 'Ship v2', done: true })],
    risks: [risk({ id: 'r1', followup: 'tracked by @[Ship v1](milestone:m1)' })], // stale label from before a rename
  })])
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.milestones).toEqual([])
  expect(d.teams[0]!.risks[0]!.followup).toBe('tracked by ~Ship v2~')
})

test('purging a closed risk unlinks its @mentions', () => {
  const d = doc([team({
    risks: [risk({ id: 'r1', title: 'Vendor lock-in', closed: true })],
    actionItems: [item({ id: 'a1', notes: 'mitigates @[Vendor lock-in](risk:r1)' })],
  })])
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.risks).toEqual([])
  expect(d.teams[0]!.actionItems[0]!.notes).toBe('mitigates ~Vendor lock-in~')
})

test('applies across multiple teams independently', () => {
  const d = doc([
    team({ id: 'A', actionItems: [item({ id: 'a', status: 'done' })] }),
    team({ id: 'B', actionItems: [item({ id: 'b', status: 'todo' })], milestones: [milestone({ id: 'm', done: true })] }),
  ])
  const counts = countCleanupTargets(d, 30, TODAY)
  expect(counts.actions).toBe(1)
  expect(counts.milestones).toBe(1)
  applyCleanup(d, 30, TODAY)
  expect(d.teams[0]!.actionItems).toEqual([])
  expect(d.teams[1]!.actionItems.map((a) => a.id)).toEqual(['b'])
  expect(d.teams[1]!.milestones).toEqual([])
})
