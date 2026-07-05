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
