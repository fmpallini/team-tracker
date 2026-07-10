import { createEmptyDocument, migrate, SCHEMA_VERSION, SchemaTooNewError } from '../src/core/document'

test('createEmptyDocument shape', () => {
  const d = createEmptyDocument('pt-BR')
  expect(d.schemaVersion).toBe(SCHEMA_VERSION)
  expect(d.prefs).toEqual({ theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M', autoSaveMin: 5 })
  expect(d.teams).toEqual([])
  expect(d.nav).toEqual({ activeTeamId: null, split: false, focusedPane: 0,
    panes: [{ history: [], index: -1 }, { history: [], index: -1 }], teamSplit: {} })
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
  it('bumps to the current version and fills v2 defaults', () => {
    const doc = migrate(v1Doc())
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.teams[0]!.risks[0]!.closed).toBe(false)
    expect(doc.teams[0]!.actionItems[0]!.notes).toBe('')
    expect(doc.teams[0]!.milestones[0]!.followup).toBe('')
  })
})

describe('v2 → v3 migration', () => {
  it('fills nav.teamSplit when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 2
    delete d.nav.teamSplit
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.nav.teamSplit).toEqual({})
  })
  it('createEmptyDocument emits the current schema version', () => {
    expect(createEmptyDocument('pt-BR').schemaVersion).toBe(SCHEMA_VERSION)
  })
})
