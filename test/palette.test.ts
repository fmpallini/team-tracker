import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createPalette, type Palette } from '../src/ui/palette'
import { currentLoc } from '../src/core/nav'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function setup(onOpenDue?: () => void): { store: Store; pm: PaneManager; palette: Palette } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push({
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  })
  doc.nav.activeTeamId = 'T1'
  const store = createStore(doc)
  const shell = createShell('en-US')
  const pm = createPaneManager(shell, store, 'en-US')
  const palette = createPalette(store, pm, onOpenDue)
  return { store, pm, palette }
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('clicking a row commits it and closes the palette', () => {
  // Confirms the row's onclick wiring is correct (commit() fires, overlay
  // closes) — NOT a regression test for the mouseenter/rebuild race below.
  // jsdom dispatches the 'click' event directly here rather than synthesizing
  // it from mousedown+mouseup the way a real browser would, so this test
  // would pass unchanged even against the pre-fix code; the node-identity
  // test below is what actually proves the fix.
  const { palette } = setup()
  palette.open()

  const rows = document.querySelectorAll('.tt-palette-item')
  expect(rows.length).toBeGreaterThan(0)
  const carlaRow = Array.from(rows).find((r) => r.textContent?.includes('Carla'))!

  carlaRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('hovering a row does not replace its DOM node (real-browser click requires mousedown/mouseup on the same element)', () => {
  const { palette } = setup()
  palette.open()

  const rowsBefore = Array.from(document.querySelectorAll('.tt-palette-item'))
  expect(rowsBefore.length).toBeGreaterThan(1)
  rowsBefore[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  const rowsAfter = Array.from(document.querySelectorAll('.tt-palette-item'))

  expect(rowsAfter[0]).toBe(rowsBefore[0])
  expect(rowsAfter[1]).toBe(rowsBefore[1])
  expect(rowsAfter[1]!.classList.contains('selected')).toBe(true)
  expect(rowsAfter[0]!.classList.contains('selected')).toBe(false)

  // Clean up the keydown listener registered by palette.open()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})

test('shows a "Due" entry first when onOpenDue is provided, and invokes it instead of navigating', () => {
  const onOpenDue = vi.fn()
  const { palette } = setup(onOpenDue)
  palette.open()

  const rows = document.querySelectorAll('.tt-palette-item')
  expect(rows[0]!.textContent).toContain('Due')

  rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  expect(onOpenDue).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('typing a query that does not match "due" filters the Due entry out', () => {
  const { palette } = setup(() => {})
  palette.open()

  const input = document.querySelector('.tt-palette-input') as HTMLInputElement
  input.value = 'stakeholders'
  input.dispatchEvent(new Event('input'))

  const labels = Array.from(document.querySelectorAll('.tt-palette-item')).map((r) => r.textContent)
  expect(labels.some((l) => l?.includes('Due'))).toBe(false)
})

test('does not open at all when the document has no team', () => {
  const { store, palette } = setup(() => {})
  store.update((d) => {
    d.teams.length = 0
    d.nav.activeTeamId = null
  })

  palette.open()

  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('without onOpenDue, no Due entry appears', () => {
  const { palette } = setup()
  palette.open()

  const labels = Array.from(document.querySelectorAll('.tt-palette-item')).map((r) => r.textContent)
  expect(labels.some((l) => l?.includes('Due'))).toBe(false)
})

test('Enter does not navigate while a modal is open (e.g. an async save-conflict error appearing over the palette)', () => {
  const { store, palette } = setup()
  palette.open()
  expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()

  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay' }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(document.querySelector('.tt-palette-overlay')).not.toBeNull() // still open, untouched
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull() // never navigated
})
