import { appCommands, type AddItemKind } from '../src/ui/app-commands'

function actions() {
  const fn = (): ReturnType<typeof vi.fn<() => void>> => vi.fn<() => void>()
  return {
    settings: fn(), help: fn(), dueDates: fn(), newTeam: fn(), addItem: vi.fn<(kind: AddItemKind) => void>(),
    toggleSidebar: fn(), toggleSplit: fn(), toggleFavorite: fn(), print: fn(), closeFile: fn(),
  }
}

test('every command has a label in both locales, and the ids are unique', () => {
  const a = actions()
  for (const locale of ['en-US', 'pt-BR'] as const) {
    const list = appCommands(locale, a)
    expect(list.every((c) => c.label.trim() !== '')).toBe(true)
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length)
  }
})

test('each runs its action', () => {
  const a = actions()
  for (const c of appCommands('en-US', a)) c.run()
  for (const name of ['settings', 'help', 'dueDates', 'newTeam', 'toggleSidebar', 'toggleSplit', 'toggleFavorite', 'print', 'closeFile'] as const) {
    expect(a[name]).toHaveBeenCalledTimes(1)
  }
})

test('the add commands name the module they add to', () => {
  const a = actions()
  for (const c of appCommands('en-US', a)) c.run()
  expect(a.addItem.mock.calls.map(([kind]) => kind)).toEqual(['actions', 'risks', 'milestones', 'members', 'stakeholders'])
})
