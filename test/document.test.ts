import { createEmptyDocument, migrate, migrateTeams, SCHEMA_VERSION, SchemaTooNewError } from '../src/core/document'

test('createEmptyDocument shape', () => {
  const d = createEmptyDocument('pt-BR')
  expect(d.schemaVersion).toBe(SCHEMA_VERSION)
  expect(d.prefs).toEqual({ theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M', autoSaveMin: 10, palette: 'ledger' })
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

describe('v3 → v4 migration (action items kanban)', () => {
  function v3Doc() {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 3
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [
        { id: 'a1', text: 'Open one', done: false, dueDate: null, assignee: '', order: 5, notes: '' },
        { id: 'a2', text: 'Open two', done: false, dueDate: null, assignee: '', order: 2, notes: '' },
        { id: 'a3', text: 'Done one', done: true, dueDate: null, assignee: '', order: 9, notes: '' },
      ],
      milestones: [], risks: [],
    }]
    return d
  }
  it('bumps to the current version', () => {
    const doc = migrate(v3Doc())
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
  })
  it('renames text to summary and maps done to status', () => {
    const doc = migrate(v3Doc())
    const items = doc.teams[0]!.actionItems
    expect(items.find((i) => i.id === 'a1')).toMatchObject({ summary: 'Open one', status: 'todo' })
    expect(items.find((i) => i.id === 'a3')).toMatchObject({ summary: 'Done one', status: 'done' })
    expect((items.find((i) => i.id === 'a1') as any).text).toBeUndefined()
    expect((items.find((i) => i.id === 'a1') as any).done).toBeUndefined()
  })
  it('defaults color to ledger', () => {
    const doc = migrate(v3Doc())
    expect(doc.teams[0]!.actionItems.every((i) => i.color === 'ledger')).toBe(true)
  })
  it('renumbers order densely within each status group, not globally', () => {
    const doc = migrate(v3Doc())
    const items = doc.teams[0]!.actionItems
    const todo = items.filter((i) => i.status === 'todo').sort((a, b) => a.order - b.order)
    expect(todo.map((i) => i.id)).toEqual(['a2', 'a1']) // a2 had order 2, a1 had order 5
    expect(todo.map((i) => i.order)).toEqual([0, 1])
    const done = items.filter((i) => i.status === 'done')
    expect(done.map((i) => i.order)).toEqual([0])
  })
})

describe('v4 → v5 migration (palette default)', () => {
  it('defaults palette to ledger when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 4
    delete d.prefs.palette
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.palette).toBe('ledger')
  })
})

describe('migrateTeams (team export/import)', () => {
  it('applies v1 defaults (risk.closed, actionItem.notes, milestone.followup) to a bare v1-shaped team', () => {
    const teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', text: 'x', done: false, dueDate: null, assignee: '', order: 0 }],
      milestones: [{ id: 'm1', date: '2026-07-01', title: 'M', done: false }],
      risks: [{ id: 'r1', title: 'R', chance: 1, impact: 1, plan: 'mitigate', order: 0 }],
    }] as any
    const migrated = migrateTeams<any>(teams, 1)
    expect(migrated[0]!.risks[0]!.closed).toBe(false)
    expect(migrated[0]!.milestones[0]!.followup).toBe('')
    // v1's actionItems still use text/done — the v3 step (below) is what renames them
    expect((migrated[0]!.actionItems[0]! as unknown as { notes: string }).notes).toBe('')
  })

  it('reshapes v3 actionItems (text/done -> summary/status/color) when importing an older export', () => {
    const teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', text: 'Open one', done: false, dueDate: null, assignee: '', order: 0, notes: '' }],
      milestones: [], risks: [],
    }] as any
    const migrated = migrateTeams<any>(teams, 3)
    expect(migrated[0]!.actionItems[0]).toMatchObject({ summary: 'Open one', status: 'todo', color: 'ledger' })
    expect(migrated[0]!.actionItems[0]!.text).toBeUndefined()
  })

  it('is a no-op when fromVersion already equals the current schema version', () => {
    const teams = createEmptyDocument('en-US').teams
    expect(migrateTeams(teams, SCHEMA_VERSION)).toEqual(teams)
  })
})
