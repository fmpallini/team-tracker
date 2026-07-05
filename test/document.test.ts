import { createEmptyDocument, migrate, SCHEMA_VERSION, SchemaTooNewError } from '../src/core/document'

test('createEmptyDocument shape', () => {
  const d = createEmptyDocument('pt-BR')
  expect(d.schemaVersion).toBe(SCHEMA_VERSION)
  expect(d.prefs).toEqual({ theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M', autoSaveMin: 5 })
  expect(d.teams).toEqual([])
  expect(d.nav).toEqual({ activeTeamId: null, split: false, focusedPane: 0,
    panes: [{ history: [], index: -1 }, { history: [], index: -1 }] })
})

test('migrate accepts current version untouched', () => {
  const d = createEmptyDocument('en-US')
  expect(migrate(JSON.parse(JSON.stringify(d)))).toEqual(d)
})

test('migrate rejects newer schema', () => {
  const d = { ...createEmptyDocument('pt-BR'), schemaVersion: SCHEMA_VERSION + 1 }
  expect(() => migrate(d)).toThrow(SchemaTooNewError)
})

describe('v1 → v2 migration', () => {
  function v1Doc() {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 1
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', text: 'x', done: false, dueDate: null, assignee: '', order: 0 }],
      milestones: [{ id: 'm1', date: '2026-07-01', title: 'M', done: false }],
      risks: [{ id: 'r1', title: 'R', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0 }],
    }]
    return d
  }
  it('bumps to v2 and fills defaults', () => {
    const doc = migrate(v1Doc())
    expect(doc.schemaVersion).toBe(2)
    expect(SCHEMA_VERSION).toBe(2)
    expect(doc.teams[0]!.risks[0]!.closed).toBe(false)
    expect(doc.teams[0]!.actionItems[0]!.notes).toBe('')
    expect(doc.teams[0]!.milestones[0]!.followup).toBe('')
  })
  it('createEmptyDocument emits v2', () => {
    expect(createEmptyDocument('pt-BR').schemaVersion).toBe(2)
  })
})
