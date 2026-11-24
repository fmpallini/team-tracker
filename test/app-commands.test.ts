import { appCommands, type AddItemKind } from '../src/ui/app-commands'

function actions() {
  const fn = (): ReturnType<typeof vi.fn<() => void>> => vi.fn<() => void>()
  return {
    settings: fn(), help: fn(), dueDates: fn(), newTeam: fn(), addItem: vi.fn<(kind: AddItemKind) => void>(),
    toggleSidebar: fn(), toggleSplit: fn(), toggleFullscreen: fn(), toggleFavorite: fn(), print: fn(), closeFile: fn(),
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
  for (const name of ['settings', 'help', 'dueDates', 'newTeam', 'toggleSidebar', 'toggleSplit', 'toggleFullscreen', 'toggleFavorite', 'print', 'closeFile'] as const) {
    expect(a[name]).toHaveBeenCalledTimes(1)
  }
})

test('the add commands name the module they add to', () => {
  const a = actions()
  for (const c of appCommands('en-US', a)) c.run()
  expect(a.addItem.mock.calls.map(([kind]) => kind)).toEqual(['stakeholders', 'members', 'actions', 'milestones', 'risks'])
})

test('grouped by what they do: create, go to, this page, view, app; keys shown only where one exists', () => {
  const list = appCommands('en-US', actions())
  expect(list.map((c) => c.id)).toEqual([
    'add-stakeholder', 'add-member', 'add-task', 'add-milestone', 'add-risk', 'new-team',
    'due',
    'favorite', 'print',
    'split', 'sidebar', 'fullscreen',
    'settings', 'help', 'close-file',
  ])
  expect(Object.fromEntries(list.filter((c) => c.hint).map((c) => [c.id, c.hint]))).toEqual({
    print: 'Ctrl+P', split: 'Alt+↑', fullscreen: 'F11', help: 'F1', 'close-file': 'Ctrl+Alt+L',
  })
  expect(list.some((c) => c.label.includes('Ctrl'))).toBe(false) // the key lives in the hint, not the label
})
