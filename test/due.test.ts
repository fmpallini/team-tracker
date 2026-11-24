import { collectDueItems, dueState, dueItemLabel, dueRelativeLabel, moduleDueSummary, teamDueSummary } from '../src/core/due'
import { createEmptyDocument } from '../src/core/document'
import type { ActionItem, Doc, Milestone, Person, Team } from '../src/core/types'

function item(overrides: Partial<ActionItem>): ActionItem {
  return { id: 'i1', summary: 'Do thing', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger', ...overrides }
}
function milestone(overrides: Partial<Milestone>): Milestone {
  return { id: 'm1', date: '2026-07-01', title: 'M', done: false, followup: '', ...overrides }
}
function person(overrides: Partial<Person>): Person {
  return { id: 'p1', name: 'Ana', role: '', parentId: null, order: 0, notes: '', ...overrides }
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

// The one "overdue by / in N days" wording, shared by the due panel and the fast switch.
describe('dueRelativeLabel', () => {
  test('a past date reads as overdue by the whole days since', () => {
    expect(dueRelativeLabel('en-US', '2026-07-19', '2026-07-20')).toBe('overdue by 1d')
    expect(dueRelativeLabel('pt-BR', '2026-07-10', '2026-07-20')).toBe('venceu há 10d')
  })
  test('today reads as in 0 days, a future date as in the days until', () => {
    expect(dueRelativeLabel('en-US', '2026-07-20', '2026-07-20')).toBe('in 0d')
    expect(dueRelativeLabel('pt-BR', '2026-07-23', '2026-07-20')).toBe('em 3d')
  })
})

describe('teamDueSummary', () => {
  test('counts overdue and due-soon together per team; a team is overdue when any item is late', () => {
    const d = doc([
      team({ id: 'A', actionItems: [item({ id: 'a1', dueDate: '2026-07-16' }), item({ id: 'a2', dueDate: '2026-07-18' })] }),
      team({ id: 'B', actionItems: [item({ id: 'b1', dueDate: '2026-07-18' })], milestones: [milestone({ date: '2026-07-19' })] }),
      team({ id: 'C', actionItems: [item({ id: 'c1', dueDate: '2026-12-01' })] }),
    ])
    const summary = teamDueSummary(collectDueItems(d, TODAY))
    expect(summary.get('A')).toEqual({ count: 2, overdue: true })
    expect(summary.get('B')).toEqual({ count: 2, overdue: false })
    expect(summary.has('C')).toBe(false)
  })
})

describe('1:1 due items', () => {
  // Default cadence 14 days: last 07-01 → due 07-15 (overdue), 07-04 → 07-18 (soon), 07-10 → 07-24 (not yet).
  test('overdue and due-soon 1:1s land in the buckets as kind person', () => {
    const d = doc([team({
      members: [
        person({ id: 'late', name: 'Late', lastOneOnOne: '2026-07-01' }),
        person({ id: 'soon', name: 'Soon', lastOneOnOne: '2026-07-04' }),
        person({ id: 'fine', name: 'Fine', lastOneOnOne: '2026-07-10' }),
        person({ id: 'never', name: 'Never' }),
      ],
      stakeholders: [person({ id: 'sh', name: 'Sam', lastOneOnOne: '2026-07-10', oneOnOneEveryDays: 7 })],
    })])
    const { overdue, dueSoon } = collectDueItems(d, TODAY)
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({
      loc: { teamId: 'T1', ref: { kind: 'person', personId: 'late', group: 'members' } },
      title: 'Late', date: '2026-07-15', kind: 'person', teamName: 'Team 1',
    })
    expect(dueSoon.map((x) => x.loc.ref)).toEqual([
      { kind: 'person', personId: 'sh', group: 'stakeholders' }, // 07-17: today
      { kind: 'person', personId: 'soon', group: 'members' },    // 07-18
    ])
  })

  test('a person with a malformed cadence or date is never due and nothing throws', () => {
    const d = doc([team({
      members: [
        person({ id: 'a', lastOneOnOne: 'garbage' }),
        person({ id: 'b', lastOneOnOne: '2000-01-01', oneOnOneEveryDays: '7' as unknown as number }),
        person({ id: 'c', lastOneOnOne: '2000-01-01', oneOnOneEveryDays: null }),
      ],
    })])
    d.prefs.oneOnOneDefaultDays = 0
    const { overdue, dueSoon } = collectDueItems(d, TODAY)
    expect(overdue).toHaveLength(0)
    expect(dueSoon).toHaveLength(0)
  })
})

describe('moduleDueSummary', () => {
  test('groups by module, person items by group; other teams are left out', () => {
    const d = doc([
      team({
        id: 'A',
        actionItems: [item({ id: 'a1', dueDate: '2026-07-16' }), item({ id: 'a2', dueDate: '2026-07-18' })],
        milestones: [milestone({ date: '2026-07-19' })],
        members: [person({ id: 'm1', lastOneOnOne: '2026-07-01' })],
        stakeholders: [person({ id: 's1', lastOneOnOne: '2026-07-10', oneOnOneEveryDays: 7 })],
      }),
      team({ id: 'B', actionItems: [item({ id: 'b1', dueDate: '2026-07-16' })] }),
    ])
    const summary = moduleDueSummary(collectDueItems(d, TODAY), 'A')
    expect(summary.get('actions')).toEqual({ overdue: 1, dueSoon: 1 })
    expect(summary.get('milestones')).toEqual({ overdue: 0, dueSoon: 1 })
    expect(summary.get('members')).toEqual({ overdue: 1, dueSoon: 0 })
    expect(summary.get('stakeholders')).toEqual({ overdue: 0, dueSoon: 1 })
    expect(moduleDueSummary(collectDueItems(d, TODAY), 'none').size).toBe(0)
  })
})

describe('dueItemLabel', () => {
  test('a 1:1 reads "1:1 · Name"; others read their title', () => {
    const d = doc([team({
      actionItems: [item({ dueDate: '2026-07-16', summary: 'Do thing' })],
      members: [person({ name: 'Ana', lastOneOnOne: '2026-07-01' })],
    })])
    const { overdue } = collectDueItems(d, TODAY)
    const byKind = Object.fromEntries(overdue.map((x) => [x.kind, x]))
    expect(dueItemLabel('en-US', byKind['person']!)).toBe('1:1 · Ana')
    expect(dueItemLabel('pt-BR', byKind['person']!)).toBe('1:1 · Ana')
    expect(dueItemLabel('en-US', byKind['action']!)).toBe('Do thing')
  })
})

describe('dueState', () => {
  test('late before today, soon from today through the window, nothing after it', () => {
    expect(dueState('2026-11-22', '2026-11-23', 7)).toBe('overdue')
    expect(dueState('2026-11-23', '2026-11-23', 7)).toBe('soon')
    expect(dueState('2026-11-30', '2026-11-23', 7)).toBe('soon')
    expect(dueState('2026-12-01', '2026-11-23', 7)).toBeNull()
    expect(dueState('2026-11-23', '2026-11-23', 0)).toBe('soon')
  })
})
