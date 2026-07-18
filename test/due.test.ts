import { collectDueItems } from '../src/core/due'
import { createEmptyDocument } from '../src/core/document'
import type { ActionItem, Doc, Milestone, Team } from '../src/core/types'

function item(overrides: Partial<ActionItem>): ActionItem {
  return { id: 'i1', summary: 'Do thing', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger', ...overrides }
}
function milestone(overrides: Partial<Milestone>): Milestone {
  return { id: 'm1', date: '2026-07-01', title: 'M', done: false, followup: '', ...overrides }
}
function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}
function doc(teams: Team[], dueSoonDays = 3): Doc {
  const d = createEmptyDocument('en-US')
  d.prefs.dueSoonDays = dueSoonDays
  d.teams = teams
  return d
}

const TODAY = '2026-07-17'

test('a past-due action item lands in overdue', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: '2026-07-16' })] })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.ref)).toEqual([{ kind: 'actions', itemId: 'a' }])
  expect(dueSoon).toHaveLength(0)
})

test('an action item due exactly today lands in due-soon, not overdue', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: TODAY })] })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue).toHaveLength(0)
  expect(dueSoon.map((x) => x.loc.ref)).toEqual([{ kind: 'actions', itemId: 'a' }])
})

test('the last day of the due-soon window is included; the day after is excluded', () => {
  const d = doc([team({
    actionItems: [
      item({ id: 'in-window', dueDate: '2026-07-20' }),   // today + 3
      item({ id: 'past-window', dueDate: '2026-07-21' }),  // today + 4
    ],
  })], 3)
  const { dueSoon } = collectDueItems(d, TODAY)
  expect(dueSoon.map((x) => (x.loc.ref as any).itemId)).toEqual(['in-window'])
})

test('respects a non-default dueSoonDays', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: '2026-07-25' })] })], 10) // today + 8
  const { dueSoon } = collectDueItems(d, TODAY)
  expect(dueSoon.map((x) => (x.loc.ref as any).itemId)).toEqual(['a'])
})

test('done and cancelled action items are excluded even when overdue', () => {
  const d = doc([team({
    actionItems: [
      item({ id: 'done', dueDate: '2000-01-01', status: 'done' }),
      item({ id: 'cancelled', dueDate: '2000-01-01', status: 'cancelled' }),
    ],
  })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue).toHaveLength(0)
  expect(dueSoon).toHaveLength(0)
})

test('action items with no due date are excluded', () => {
  const d = doc([team({ actionItems: [item({ id: 'a', dueDate: null })] })])
  const { overdue, dueSoon } = collectDueItems(d, TODAY)
  expect(overdue).toHaveLength(0)
  expect(dueSoon).toHaveLength(0)
})

test('an overdue, not-done milestone lands in overdue; a done one is excluded', () => {
  const d = doc([team({
    milestones: [
      milestone({ id: 'open', date: '2026-07-01', done: false }),
      milestone({ id: 'closed', date: '2026-07-01', done: true }),
    ],
  })])
  const { overdue } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.ref)).toEqual([{ kind: 'milestones', itemId: 'open' }])
})

test('results are sorted ascending by date and carry team name + kind', () => {
  const d = doc([team({
    id: 'T1', name: 'Engineering',
    actionItems: [item({ id: 'later', dueDate: '2000-01-05' }), item({ id: 'earlier', dueDate: '2000-01-01' })],
  })])
  const { overdue } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => (x.loc.ref as any).itemId)).toEqual(['earlier', 'later'])
  expect(overdue[0]!.teamName).toBe('Engineering')
  expect(overdue[0]!.kind).toBe('action')
})

test('collects across multiple teams', () => {
  const d = doc([
    team({ id: 'A', name: 'A', actionItems: [item({ id: 'a', dueDate: '2000-01-01' })] }),
    team({ id: 'B', name: 'B', actionItems: [item({ id: 'b', dueDate: '2000-01-01' })] }),
  ])
  const { overdue } = collectDueItems(d, TODAY)
  expect(overdue.map((x) => x.loc.teamId).sort()).toEqual(['A', 'B'])
})
