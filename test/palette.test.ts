import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createPalette, type Palette } from '../src/ui/palette'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function setup(): { store: Store; pm: PaneManager; palette: Palette } {
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
  const palette = createPalette(store, pm)
  return { store, pm, palette }
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('clicking a row (not just Enter) commits it and closes the palette', () => {
  const { palette } = setup()
  palette.open()

  const rows = document.querySelectorAll('.tt-palette-item')
  expect(rows.length).toBeGreaterThan(0)
  const carlaRow = Array.from(rows).find((r) => r.textContent === 'Carla')!

  carlaRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  carlaRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
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
})
