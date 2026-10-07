import { createEmptyDocument, createEmptyTeam, migrate, migrateTeams, SCHEMA_VERSION, SchemaTooNewError, findTeam, nearestDatedNote, validateDoc } from '../src/core/document'

test('createEmptyDocument shape', () => {
  const d = createEmptyDocument('pt-BR')
  expect(d.schemaVersion).toBe(SCHEMA_VERSION)
  expect(d.prefs).toEqual({
    theme: 'system', locale: 'pt-BR', font: 'system', fontSize: 'M',
    autoSaveMin: 10, palette: 'ledger', dueSoonDays: 7, openRefsInSecondaryPane: false,
    dailyBackupEnabled: false, backupHandleId: null, backupFrequency: 'daily',
    ctrlWheelFontSize: true, dailyEdgeScroll: true,
  })
  expect(d.teams).toEqual([])
  expect(d.favorites).toEqual([])
  expect(d.nav).toEqual({ activeTeamId: null, split: false, focusedPane: 0,
    panes: [{ history: [], index: -1 }, { history: [], index: -1 }], teamSplit: {}, sidebarCollapsed: false, calendarCollapsed: false })
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

describe('v5 → v6 migration (due-soon window)', () => {
  it('defaults dueSoonDays to 7 when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 5
    delete d.prefs.dueSoonDays
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.dueSoonDays).toBe(7)
  })
  it('leaves an existing dueSoonDays untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 5
    d.prefs.dueSoonDays = 12
    const doc = migrate(d)
    expect(doc.prefs.dueSoonDays).toBe(12)
  })
})

describe('v6 → v7 migration (sidebar collapse)', () => {
  it('defaults nav.sidebarCollapsed to false when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 6
    delete d.nav.sidebarCollapsed
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.nav.sidebarCollapsed).toBe(false)
  })
  it('leaves an existing sidebarCollapsed untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 6
    d.nav.sidebarCollapsed = true
    const doc = migrate(d)
    expect(doc.nav.sidebarCollapsed).toBe(true)
  })
})

describe('v7 → v8 migration (open refs in secondary pane)', () => {
  it('defaults prefs.openRefsInSecondaryPane to false when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 7
    delete d.prefs.openRefsInSecondaryPane
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.openRefsInSecondaryPane).toBe(false)
  })
  it('leaves an existing openRefsInSecondaryPane untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 7
    d.prefs.openRefsInSecondaryPane = true
    const doc = migrate(d)
    expect(doc.prefs.openRefsInSecondaryPane).toBe(true)
  })
})

describe('v8 → v9 migration (daily backup prefs)', () => {
  it('defaults dailyBackupEnabled to false and backupHandleId to null when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 8
    delete d.prefs.dailyBackupEnabled
    delete d.prefs.backupHandleId
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.dailyBackupEnabled).toBe(false)
    expect(doc.prefs.backupHandleId).toBeNull()
  })
  it('leaves existing values untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 8
    d.prefs.dailyBackupEnabled = true
    d.prefs.backupHandleId = 'abc-123'
    const doc = migrate(d)
    expect(doc.prefs.dailyBackupEnabled).toBe(true)
    expect(doc.prefs.backupHandleId).toBe('abc-123')
  })
})

describe('v9 → v10 migration (backup frequency)', () => {
  it('defaults backupFrequency to "daily" when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 9
    delete d.prefs.backupFrequency
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.backupFrequency).toBe('daily')
  })
  it('leaves an existing backupFrequency untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 9
    d.prefs.backupFrequency = 'hourly'
    const doc = migrate(d)
    expect(doc.prefs.backupFrequency).toBe('hourly')
  })
})

describe("v10 → v11 migration ('muster' palette dropped)", () => {
  it("remaps a saved 'muster' palette to 'forest', its closest surviving replacement", () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 10
    d.prefs.palette = 'muster'
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.palette).toBe('forest')
  })
  it('leaves any other palette untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 10
    d.prefs.palette = 'cosmic'
    const doc = migrate(d)
    expect(doc.prefs.palette).toBe('cosmic')
  })
})

describe('v11 → v12 migration (daily calendar collapse)', () => {
  it('defaults nav.calendarCollapsed to false when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 11
    delete d.nav.calendarCollapsed
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.nav.calendarCollapsed).toBe(false)
  })
  it('leaves an existing calendarCollapsed untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 11
    d.nav.calendarCollapsed = true
    const doc = migrate(d)
    expect(doc.nav.calendarCollapsed).toBe(true)
  })
})

describe('v12 → v13 migration (per-team custom kanban columns)', () => {
  it('seeds a single WIP actionColumns entry, named from the doc\'s own locale, leaving existing wip items untouched', () => {
    const d = createEmptyDocument('pt-BR') as any
    d.schemaVersion = 12
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {},
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', summary: 'x', notes: '', status: 'wip', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [], risks: [],
    }]
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.teams[0]!.actionColumns).toEqual([{ id: 'wip', name: 'Em Andamento', order: 0 }])
    expect(doc.teams[0]!.actionItems[0]!.status).toBe('wip') // untouched — 'wip' already matches the seeded column's id
  })

  it('uses the English default name when the doc\'s locale is en-US', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 12
    d.teams = [{ id: 't1', name: 'T', emoji: '🙂', dailyNotes: {}, stakeholders: [], members: [], actionItems: [], milestones: [], risks: [] }]
    const doc = migrate(d)
    expect(doc.teams[0]!.actionColumns).toEqual([{ id: 'wip', name: 'WIP', order: 0 }])
  })

  it('leaves an existing actionColumns array untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 12
    d.teams = [{
      id: 't1', name: 'T', emoji: '🙂', dailyNotes: {}, stakeholders: [], members: [],
      actionItems: [], milestones: [], risks: [],
      actionColumns: [{ id: 'custom-1', name: 'Review', order: 0 }],
    }]
    const doc = migrate(d)
    expect(doc.teams[0]!.actionColumns).toEqual([{ id: 'custom-1', name: 'Review', order: 0 }])
  })
})

describe('v13 → v14 migration (Ctrl+wheel font size + daily edge-scroll toggles)', () => {
  it('defaults both toggles to true when missing', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 13
    delete d.prefs.ctrlWheelFontSize
    delete d.prefs.dailyEdgeScroll
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.prefs.ctrlWheelFontSize).toBe(true)
    expect(doc.prefs.dailyEdgeScroll).toBe(true)
  })

  it('leaves toggles the user has turned off untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 13
    d.prefs.ctrlWheelFontSize = false
    d.prefs.dailyEdgeScroll = false
    const doc = migrate(d)
    expect(doc.prefs.ctrlWheelFontSize).toBe(false)
    expect(doc.prefs.dailyEdgeScroll).toBe(false)
  })
})

describe('v14 → v15 migration (favorites)', () => {
  it('adds an empty favorites list to a v14 document', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 14
    delete d.favorites
    const doc = migrate(d)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.favorites).toEqual([])
  })

  it('keeps an existing favorites array untouched', () => {
    const d = createEmptyDocument('en-US') as any
    d.schemaVersion = 14
    d.favorites = [{ teamId: 'T1', ref: { kind: 'risks' } }]
    expect(migrate(d).favorites).toEqual([{ teamId: 'T1', ref: { kind: 'risks' } }])
  })
})

test('createEmptyTeam seeds a single default WIP column', () => {
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  expect(team.actionColumns).toEqual([{ id: 'wip', name: 'WIP', order: 0 }])
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

test('findTeam finds a team by id, undefined when missing', () => {
  const d = createEmptyDocument('en-US')
  d.teams.push(createEmptyTeam('t1', 'Alpha', '🙂', 'en-US'))
  expect(findTeam(d, 't1')?.name).toBe('Alpha')
  expect(findTeam(d, 'nope')).toBeUndefined()
})

test('createEmptyTeam seeds generalNotes as an empty string', () => {
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  expect(team.generalNotes).toBe('')
})

describe('nearestDatedNote', () => {
  const notes = {
    '2026-09-03': 'a',
    '2026-09-05': '   ',   // present but whitespace-only → not a dated note
    '2026-09-10': 'b',
    '2026-09-20': 'c',
  }

  it('jumps forward over any gap to the next non-empty note', () => {
    expect(nearestDatedNote(notes, '2026-09-03', 1)).toBe('2026-09-10')
    expect(nearestDatedNote(notes, '2026-09-01', 1)).toBe('2026-09-03')
    expect(nearestDatedNote(notes, '2026-09-11', 1)).toBe('2026-09-20')
  })

  it('jumps backward over any gap to the previous non-empty note', () => {
    expect(nearestDatedNote(notes, '2026-09-20', -1)).toBe('2026-09-10')
    expect(nearestDatedNote(notes, '2026-09-10', -1)).toBe('2026-09-03')
    expect(nearestDatedNote(notes, '2026-09-09', -1)).toBe('2026-09-03')
  })

  it('is exclusive of fromIso itself', () => {
    expect(nearestDatedNote(notes, '2026-09-10', 1)).toBe('2026-09-20')
    expect(nearestDatedNote(notes, '2026-09-10', -1)).toBe('2026-09-03')
  })

  it('returns null past the last / before the first dated note', () => {
    expect(nearestDatedNote(notes, '2026-09-20', 1)).toBeNull()
    expect(nearestDatedNote(notes, '2026-09-03', -1)).toBeNull()
    expect(nearestDatedNote({}, '2026-09-10', 1)).toBeNull()
  })

  it('skips whitespace-only entries in both directions', () => {
    expect(nearestDatedNote(notes, '2026-09-04', 1)).toBe('2026-09-10')
    expect(nearestDatedNote(notes, '2026-09-06', -1)).toBe('2026-09-03')
  })
})

describe('validateDoc', () => {
  function goodDoc(): Record<string, unknown> {
    const d = createEmptyDocument('en-US') as unknown as Record<string, unknown>
    const team = createEmptyTeam('t1', 'Team A', '🙂', 'en-US')
    team.members.push({ id: 'p1', name: 'Ann', role: 'Dev', parentId: null, order: 0, notes: '' })
    team.stakeholders.push({ id: 's1', name: 'Bo', role: 'Sponsor', parentId: null, order: 0, notes: '' })
    team.actionItems.push({ id: 'a1', summary: 'Do it', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 0 })
    team.milestones.push({ id: 'm1', date: '2026-09-13', title: 'Ship', done: false, followup: '' })
    team.risks.push({ id: 'r1', title: 'Slip', chance: 2, impact: 3, plan: 'mitigate', followup: '', order: 0, closed: false })
    team.dailyNotes['2026-09-13'] = '<p>hi</p>'
    ;(d.teams as unknown[]).push(team)
    return JSON.parse(JSON.stringify(d)) as Record<string, unknown>
  }

  function team0(d: Record<string, unknown>): Record<string, unknown> {
    const t0 = (d.teams as Record<string, unknown>[])[0]
    if (!t0) throw new Error('fixture has no team')
    return t0
  }

  function first(team: Record<string, unknown>, key: string): Record<string, unknown> {
    const e = (team[key] as Record<string, unknown>[])[0]
    if (!e) throw new Error(`fixture has no ${key}[0]`)
    return e
  }

  it('accepts a fully populated current-version document', () => {
    expect(validateDoc(goodDoc())).toBeNull()
  })

  it('accepts an empty document straight from createEmptyDocument', () => {
    expect(validateDoc(createEmptyDocument('pt-BR') as unknown as Record<string, unknown>)).toBeNull()
  })

  it('accepts a legacy v1 document once migrated up', () => {
    const legacy = { schemaVersion: 1, prefs: {}, templates: [], nav: {}, teams: [] }
    expect(validateDoc(migrate(legacy) as unknown as Record<string, unknown>)).toBeNull()
  })

  it('rejects a doc with no teams array', () => {
    const d = goodDoc()
    delete d.teams
    expect(validateDoc(d)).toBe('teams')
  })

  it('rejects a doc whose teams is not an array', () => {
    const d = goodDoc()
    d.teams = { '0': {} }
    expect(validateDoc(d)).toBe('teams')
  })

  it('rejects a doc with no prefs object', () => {
    const d = goodDoc()
    d.prefs = null
    expect(validateDoc(d)).toBe('prefs')
  })

  it('rejects a doc whose templates is not an array', () => {
    const d = goodDoc()
    d.templates = 'nope'
    expect(validateDoc(d)).toBe('templates')
  })

  it('rejects a doc with no nav object', () => {
    const d = goodDoc()
    delete d.nav
    expect(validateDoc(d)).toBe('nav')
  })

  it('rejects a doc whose favorites is not an array', () => {
    const d = goodDoc()
    d.favorites = 'nope'
    expect(validateDoc(d)).toBe('favorites')
  })

  it('names the favorite when an entry has no team id or no ref', () => {
    const d = goodDoc()
    d.favorites = [{ teamId: '', ref: { kind: 'risks' } }]
    expect(validateDoc(d)).toBe('favorites[0].teamId')
    d.favorites = [{ teamId: 't1', ref: null }]
    expect(validateDoc(d)).toBe('favorites[0].ref')
    d.favorites = [{ teamId: 't1', ref: { kind: 5 } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.kind')
  })

  it('rejects an unknown favorite kind or one missing its detail', () => {
    const d = goodDoc()
    d.favorites = [{ teamId: 't1', ref: { kind: 'bogus' } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.kind')
    d.favorites = [{ teamId: 't1', ref: { kind: 'daily' } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.date')
    d.favorites = [{ teamId: 't1', ref: { kind: 'daily', date: 5 } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.date')
    d.favorites = [{ teamId: 't1', ref: { kind: 'person', group: 'members' } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.personId')
    d.favorites = [{ teamId: 't1', ref: { kind: 'person', personId: '', group: 'members' } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.personId')
    d.favorites = [{ teamId: 't1', ref: { kind: 'person', personId: 'p' } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.group')
    d.favorites = [{ teamId: 't1', ref: { kind: 'person', personId: 'p', group: 'actionItems' } }]
    expect(validateDoc(d)).toBe('favorites[0].ref.group')
  })

  it('accepts every well-formed favorite kind', () => {
    const d = goodDoc()
    d.favorites = [
      { teamId: 't1', ref: { kind: 'daily', date: '2026-09-13' } },
      { teamId: 't1', ref: { kind: 'person', personId: 'p', group: 'stakeholders' } },
      { teamId: 't1', ref: { kind: 'person', personId: 'p', group: 'members' } },
      ...['general', 'stakeholders', 'members', 'actions', 'milestones', 'risks'].map((kind) => ({ teamId: 't1', ref: { kind } })),
    ]
    expect(validateDoc(d)).toBeNull()
  })

  it('accepts well-formed favorites', () => {
    const d = goodDoc()
    d.favorites = [{ teamId: 't1', ref: { kind: 'daily', date: '2026-09-13' } }]
    expect(validateDoc(d)).toBeNull()
  })

  it('names the team index when a team is not an object', () => {
    const d = goodDoc()
    ;(d.teams as unknown[]).push('oops')
    expect(validateDoc(d)).toBe('teams[1]')
  })

  it('names the team index when a team id is missing', () => {
    const d = goodDoc()
    delete team0(d).id
    expect(validateDoc(d)).toBe('teams[0].id')
  })

  it('rejects an empty-string team id', () => {
    const d = goodDoc()
    team0(d).id = ''
    expect(validateDoc(d)).toBe('teams[0].id')
  })

  it('names the collection when a team collection is not an array', () => {
    const d = goodDoc()
    team0(d).actionItems = null
    expect(validateDoc(d)).toBe('teams[0].actionItems')
  })

  it('names the entity path when a member has no id', () => {
    const d = goodDoc()
    first(team0(d), 'members').id = 42
    expect(validateDoc(d)).toBe('teams[0].members[0].id')
  })

  it('names the entity path when an action item is missing a required field', () => {
    const d = goodDoc()
    delete first(team0(d), 'actionItems').summary
    expect(validateDoc(d)).toBe('teams[0].actionItems[0].summary')
  })

  it('names the entity path when a risk field has the wrong primitive type', () => {
    const d = goodDoc()
    first(team0(d), 'risks').closed = 'yes'
    expect(validateDoc(d)).toBe('teams[0].risks[0].closed')
  })

  it('rejects dailyNotes that is not an object', () => {
    const d = goodDoc()
    team0(d).dailyNotes = []
    expect(validateDoc(d)).toBe('teams[0].dailyNotes')
  })

  it('names the date key when a daily note is not a string', () => {
    const d = goodDoc()
    const notes = team0(d).dailyNotes as Record<string, unknown>
    notes['2026-09-14'] = 17
    expect(validateDoc(d)).toBe('teams[0].dailyNotes["2026-09-14"]')
  })

  it('tolerates loose enum values a migration may have left behind', () => {
    const d = goodDoc()
    const team = team0(d)
    first(team, 'actionItems').status = 'some-custom-column'
    first(team, 'risks').plan = 'unknown-plan'
    expect(validateDoc(d)).toBeNull()
  })

  it('tolerates an assignee naming nobody real', () => {
    const d = goodDoc()
    first(team0(d), 'actionItems').assignee = 'Ghost'
    expect(validateDoc(d)).toBeNull()
  })
})
