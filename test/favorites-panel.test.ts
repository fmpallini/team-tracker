import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createFavoritesPanel, type FavoritesPanel } from '../src/ui/favorites'
import { currentLoc } from '../src/core/nav'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function setup(): { store: Store; pm: PaneManager; panel: FavoritesPanel; selectTeam: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  const person = { id: 'p1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }
  doc.teams.push(
    { id: 'T1', name: 'Alpha', emoji: '🚀', stakeholders: [person], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} },
    { id: 'T2', name: 'Beta', emoji: '🧪', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} },
  )
  doc.nav.activeTeamId = 'T1'
  doc.favorites = [
    { teamId: 'T1', ref: { kind: 'risks' } },
    { teamId: 'T2', ref: { kind: 'actions' } },
    { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'stakeholders' } },
    { teamId: 'T1', ref: { kind: 'daily', date: '2026-10-06' } },
  ]
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  const selectTeam = vi.fn((id: string) => { store.updateNav((d) => { d.nav.activeTeamId = id }) })
  const panel = createFavoritesPanel(store, pm, { selectTeam, headerBottom: () => 48 })
  return { store, pm, panel, selectTeam }
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tt-favorites-item'))
const press = (key: string, init: KeyboardEventInit = {}): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

afterEach(() => { document.body.innerHTML = '' })

test('open lists live favorites in order, labelled team · module, with number badges and the first row selected', () => {
  const { panel } = setup()
  panel.open()
  const labels = rows().map((r) => r.querySelector('.tt-favorites-label')!.textContent)
  expect(labels[0]).toContain('Alpha')
  expect(labels[0]).toContain('Risks')
  expect(labels[1]).toContain('Beta')
  expect(labels[2]).toContain('Carla')
  expect(labels[3]).toContain('2026')
  expect(rows().map((r) => r.querySelector('.tt-favorites-badge')!.textContent)).toEqual(['1', '2', '3', '4'])
  expect(rows()[0]!.classList.contains('selected')).toBe(true)
  expect(rows()[0]!.querySelector('.tt-favorites-label')!.getAttribute('title')).toBe(labels[0])
})

test('open is a no-op with no teams; toggle opens then closes', () => {
  const { store, panel } = setup()
  panel.toggle()
  expect(panel.isOpen()).toBe(true)
  panel.toggle()
  expect(panel.isOpen()).toBe(false)
  expect(document.querySelector('.tt-favorites-panel')).toBeNull()

  store.update((d) => { d.teams = [] })
  panel.open()
  expect(panel.isOpen()).toBe(false)
})

test('shows an empty hint when there are no live favorites', () => {
  const { store, panel } = setup()
  store.update((d) => { d.favorites = [{ teamId: 'GONE', ref: { kind: 'risks' } }] })
  panel.open()
  expect(rows()).toHaveLength(0)
  expect(document.querySelector('.tt-favorites-empty')).not.toBeNull()
})

test('a favorite of a deleted person is hidden', () => {
  const { store, panel } = setup()
  store.update((d) => { d.teams[0]!.stakeholders = [] })
  panel.open()
  expect(rows()).toHaveLength(3)
})

test('arrow keys move the selection (clamped); Escape closes', () => {
  const { panel } = setup()
  panel.open()
  press('ArrowDown'); press('ArrowDown')
  expect(rows()[2]!.classList.contains('selected')).toBe(true)
  press('ArrowDown'); press('ArrowDown'); press('ArrowDown')
  expect(rows()[3]!.classList.contains('selected')).toBe(true)
  press('ArrowUp')
  expect(rows()[2]!.classList.contains('selected')).toBe(true)
  press('Escape')
  expect(panel.isOpen()).toBe(false)
})

test('Enter on a same-team favorite opens it in the focused pane without switching team', () => {
  const { store, panel, selectTeam } = setup()
  panel.open()
  press('Enter') // row 0: T1 · risks
  expect(panel.isOpen()).toBe(false)
  expect(selectTeam).not.toHaveBeenCalled()
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toEqual({ teamId: 'T1', ref: { kind: 'risks' } })
})

test('a cross-team favorite switches team first, then opens in the focused pane', () => {
  const { store, panel, selectTeam } = setup()
  panel.open()
  press('2', { code: 'Digit2' })
  expect(selectTeam).toHaveBeenCalledWith('T2')
  expect(store.doc.nav.activeTeamId).toBe('T2')
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toEqual({ teamId: 'T2', ref: { kind: 'actions' } })
})

test('a daily favorite on a date with no note opens that empty day', () => {
  const { store, panel } = setup()
  panel.open()
  press('4', { code: 'Digit4' })
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-10-06' } })
})

test('digit past the last row does nothing; Ctrl/Alt+digit is left alone', () => {
  const { panel, selectTeam } = setup()
  panel.open()
  press('9', { code: 'Digit9' })
  expect(panel.isOpen()).toBe(true)
  press('2', { code: 'Digit2', altKey: true })
  expect(panel.isOpen()).toBe(true)
  expect(selectTeam).not.toHaveBeenCalled()
})

test('clicking a row jumps; hovering does not replace the row node', () => {
  const { panel, store } = setup()
  panel.open()
  const before = rows()
  before[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 5, clientY: 5 }))
  expect(rows()[1]).toBe(before[1])
  before[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(panel.isOpen()).toBe(false)
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])?.ref.kind).toBe('risks')
})

test('✕ removes the favorite, keeps the panel open and clamps the selection', () => {
  const { panel, store } = setup()
  panel.open()
  press('ArrowDown'); press('ArrowDown'); press('ArrowDown') // last row
  rows()[3]!.querySelector<HTMLButtonElement>('.tt-favorites-remove')!.click()
  expect(panel.isOpen()).toBe(true)
  expect(store.doc.favorites).toHaveLength(3)
  expect(rows()).toHaveLength(3)
  expect(rows()[2]!.classList.contains('selected')).toBe(true)
})

test('mousedown outside closes; mousedown on the header ★ button does not (its click toggles)', () => {
  const { panel } = setup()
  panel.open()
  const btn = document.createElement('button')
  btn.className = 'tt-btn-favorites'
  document.body.appendChild(btn)
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(panel.isOpen()).toBe(true)
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(panel.isOpen()).toBe(false)
})

test('keys do nothing behind a blocking modal', () => {
  const { panel } = setup()
  panel.open()
  const modal = document.createElement('div')
  modal.className = 'tt-modal-overlay'
  document.body.appendChild(modal)
  press('Escape')
  expect(panel.isOpen()).toBe(true)
})

test('close and dispose release the document listeners', () => {
  const { panel } = setup()
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  panel.open()
  panel.close()
  const added = add.mock.calls.filter(([type]) => type === 'keydown' || type === 'mousedown').length
  const removed = remove.mock.calls.filter(([type]) => type === 'keydown' || type === 'mousedown').length
  expect(removed).toBe(added)
  panel.open()
  panel.dispose()
  expect(panel.isOpen()).toBe(false)
})
