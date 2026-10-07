import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { buildModuleItems, filterModuleItems, titleFor, type ModuleItem } from '../src/core/module-items'
import { t } from '../src/core/i18n'
import { KIND_ICON } from '../src/core/search'
import type { Team } from '../src/core/types'

test('filterModuleItems matches substrings case- and accent-insensitively (palette filter)', () => {
  const items: ModuleItem[] = [
    { label: 'María', ref: { kind: 'actions' } },
    { label: 'Stakeholders', ref: { kind: 'stakeholders' } },
  ]

  expect(filterModuleItems(items, 'maria').map((i) => i.label)).toEqual(['María'])
  expect(filterModuleItems(items, 'STAKE').map((i) => i.label)).toEqual(['Stakeholders'])
  expect(filterModuleItems(items, '')).toEqual(items)
  expect(filterModuleItems(items, 'zzz')).toEqual([])
})

test('buildModuleItems includes one entry per action item/milestone/risk, after the whole-board entries', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀', stakeholders: [], members: [],
    actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
    milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
    risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
    dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')

  expect(items).toContainEqual({ label: `${KIND_ICON.actions} Fix bug`, ref: { kind: 'actions', itemId: 'a1' } })
  expect(items).toContainEqual({ label: `${KIND_ICON.milestones} Ship v2`, ref: { kind: 'milestones', itemId: 'm1' } })
  expect(items).toContainEqual({ label: `${KIND_ICON.risks} Vendor delay`, ref: { kind: 'risks', itemId: 'r1' } })

  const actionsBoardIdx = items.findIndex((i) => i.ref.kind === 'actions' && !('itemId' in i.ref && i.ref.itemId))
  const actionItemIdx = items.findIndex((i) => i.ref.kind === 'actions' && 'itemId' in i.ref && i.ref.itemId === 'a1')
  expect(actionItemIdx).toBeGreaterThan(actionsBoardIdx)
})

test('buildModuleItems with no team includes the daily-notes entry, the general-notes entry, and all 5 whole-board entries, but no per-item entries', () => {
  const items = buildModuleItems(null, 'en-US')
  expect(items).toEqual([
    { label: expect.any(String), ref: { kind: 'daily', date: expect.any(String) } },
    { label: `${KIND_ICON.general} General notes`, ref: { kind: 'general' } },
    { label: `${KIND_ICON.stakeholders} Stakeholders`, ref: { kind: 'stakeholders' } },
    { label: `${KIND_ICON.members} Members`, ref: { kind: 'members' } },
    { label: `${KIND_ICON.actions} Tasks`, ref: { kind: 'actions' } },
    { label: `${KIND_ICON.milestones} Milestones`, ref: { kind: 'milestones' } },
    { label: `${KIND_ICON.risks} Risks`, ref: { kind: 'risks' } },
  ])
})

test('buildModuleItems places the general-notes entry immediately after daily, before any per-person entries', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')
  expect(items[0]!.ref.kind).toBe('daily')
  expect(items[1]!.ref).toEqual({ kind: 'general' })
})

test('buildModuleItems prefixes every entry with its module icon (daily, person, and each whole-board entry)', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')

  expect(items[0]!.label.startsWith(KIND_ICON.daily)).toBe(true)
  expect(items).toContainEqual({ label: `${KIND_ICON.person} Carla`, ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } })
})

describe('titleFor', () => {
  function docWithPerson() {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('t1', 'Alpha', '🅰️', 'en-US')
    team.members.push({ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' })
    doc.teams.push(team)
    return doc
  }

  test('person: the name, or the generic person title when the person is gone', () => {
    const doc = docWithPerson()
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'person', personId: 'm1', group: 'members' } }, 'en-US')).toBe('Bruno')
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'person', personId: 'zzz', group: 'members' } }, 'en-US')).toBe(t('en-US', 'module_person'))
    expect(titleFor(doc, { teamId: 'gone', ref: { kind: 'person', personId: 'm1', group: 'members' } }, 'en-US')).toBe(t('en-US', 'module_person'))
  })

  test('whole-board kinds use their module titles', () => {
    const doc = docWithPerson()
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'risks' } }, 'en-US')).toBe(t('en-US', 'module_risks'))
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'general' } }, 'en-US')).toBe(t('en-US', 'module_general_notes'))
  })

  test('daily: module title, a dot, and the weekday date', () => {
    const doc = docWithPerson()
    expect(titleFor(doc, { teamId: 't1', ref: { kind: 'daily', date: '2026-10-07' } }, 'en-US')).toContain(' · ')
  })
})
