import { createShell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { createPalette, type Palette } from '../src/ui/palette'
import { toggleFavorite } from '../src/core/favorites'
import { currentLoc } from '../src/core/nav'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

interface Setup { store: Store; pm: PaneManager; palette: Palette; selectTeam: ReturnType<typeof vi.fn>; seen: unknown[] }

function setup(opts: { favorites?: boolean; manyPeople?: number } = {}): Setup {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push({
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  })
  const t2 = createEmptyTeam('T2', 'Team 2', '🧪', 'en-US')
  t2.members.push({ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' })
  doc.teams.push(t2)
  for (let i = 0; i < (opts.manyPeople ?? 0); i++) {
    doc.teams[0]!.members.push({ id: `x${i}`, name: `Person ${i}`, role: '', parentId: null, order: i, notes: '' })
  }
  doc.nav.activeTeamId = 'T1'
  if (opts.favorites) toggleFavorite(doc, { teamId: 'T2', ref: { kind: 'general' } })
  const store = createStore(doc)
  const shell = createShell('en-US')
  const pm = createPaneManager(shell, store, 'en-US')
  // Records what the focused pane showed when selectTeam ran: the team switch
  // must happen BEFORE the row opens.
  const seen: unknown[] = []
  const selectTeam = vi.fn((id: string) => {
    seen.push([id, currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])])
    store.updateNav((d) => { d.nav.activeTeamId = id })
  })
  const palette = createPalette(store, pm, { selectTeam })
  return { store, pm, palette, selectTeam, seen }
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tt-palette-item'))
const headings = (): string[] => Array.from(document.querySelectorAll('.tt-palette-heading')).map((h) => h.textContent ?? '')
function type(q: string): void {
  const input = document.querySelector('.tt-palette-input') as HTMLInputElement
  input.value = q
  input.dispatchEvent(new Event('input'))
}
const key = (k: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) }

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  document.body.innerHTML = ''
})

test('clicking a row commits it and closes the palette', () => {
  // The row's onclick wiring (commit() fires, overlay closes) — NOT a regression
  // test for the mouseenter/rebuild race below (jsdom dispatches 'click' directly).
  const { palette } = setup()
  palette.open()
  const carlaRow = rows().find((r) => r.textContent?.includes('Carla'))!
  carlaRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('hovering a row does not replace its DOM node (real-browser click requires mousedown/mouseup on the same element)', () => {
  const { palette } = setup()
  palette.open()
  const before = rows()
  expect(before.length).toBeGreaterThan(1)
  before[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  const after = rows()
  expect(after[0]).toBe(before[0])
  expect(after[1]).toBe(before[1])
  expect(after[1]!.classList.contains('selected')).toBe(true)
  expect(after[0]!.classList.contains('selected')).toBe(false)
})

test('does not open at all when the document has no team', () => {
  const { store, palette } = setup()
  store.update((d) => { d.teams.length = 0; d.nav.activeTeamId = null })
  palette.open()
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('Enter does not navigate while a modal is open (e.g. an async save-conflict error appearing over the palette)', () => {
  const { store, palette } = setup()
  palette.open()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay' }))
  key('Enter')
  expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
  expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()
  // Drop the blocking modal and close the palette, or its document keydown listener leaks into later tests.
  document.querySelector('.tt-modal-overlay')!.remove()
  key('Escape')
})

// The palette is deliberately opened over the modeless action-item card modal
// (to switch panes); its own keyboard navigation has to keep working there.
test('keyboard nav still works with a modeless card modal open underneath', () => {
  const { palette } = setup()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay tt-modal-modeless' }))
  palette.open()
  key('ArrowDown')
  expect(rows()[1]!.classList.contains('selected')).toBe(true)
  expect(rows()[0]!.classList.contains('selected')).toBe(false)
  key('Escape')
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
})

test('Escape over a modeless card modal closes the palette and is consumed so the card underneath stays open', () => {
  const { palette } = setup()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay tt-modal-modeless' }))
  palette.open()
  const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.dispatchEvent(evt)
  expect(document.querySelector('.tt-palette-overlay')).toBeNull()
  expect(evt.defaultPrevented).toBe(true)
})

test('each label carries its full text as a tooltip, since rows ellipsize to one line', () => {
  const { palette } = setup({ favorites: true })
  palette.open()
  const labels = Array.from(document.querySelectorAll<HTMLElement>('.tt-palette-label'))
  expect(labels.length).toBeGreaterThan(0)
  for (const l of labels) expect(l.title).toBe(l.textContent)
})

describe('sections', () => {
  test('headings delimit Favorites and the current team; Other teams stay hidden until you type', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    const h = headings()
    expect(h).toHaveLength(2)
    expect(h[0]).toContain('Favorites')
    expect(h[1]).toBe('🚀 Team 1')
    expect(rows().some((r) => r.textContent?.includes('Bruno'))).toBe(false)

    type('bruno')
    expect(headings()[0]).toContain('Other teams')
    expect(rows().some((r) => r.textContent?.includes('Bruno'))).toBe(true)
  })

  test('arrow keys skip headings and walk rows across sections', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    expect(rows()[0]!.querySelector('.tt-palette-remove')).not.toBeNull() // first row is the favorite
    key('ArrowDown')
    expect(rows()[1]!.classList.contains('selected')).toBe(true)
    expect(rows()[1]!.querySelector('.tt-palette-remove')).toBeNull() // first current-team row
  })

  test('team badge on favorite and other-team rows, none on current-team rows', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    const favRow = rows()[0]!
    expect(favRow.querySelector('.tt-palette-team')!.textContent).toBe('🧪 Team 2')
    const carla = rows().find((r) => r.textContent?.includes('Carla'))!
    expect(carla.querySelector('.tt-palette-team')).toBeNull()
    type('bruno')
    expect(rows()[0]!.querySelector('.tt-palette-team')!.textContent).toBe('🧪 Team 2')
  })

  test('a section that was cut short says how many matches it has', () => {
    const { palette } = setup({ manyPeople: 30 })
    palette.open()
    type('person')
    expect(rows().length).toBeLessThanOrEqual(20)
    expect(headings()[0]).toMatch(/20 of 30/)
  })

  test('typing a team name plus a word narrows to that team', () => {
    const { palette } = setup()
    palette.open()
    type('team 2 general')
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().every((r) => r.querySelector('.tt-palette-team')!.textContent === '🧪 Team 2')).toBe(true)
  })
})

describe('commit', () => {
  test('a row on another team switches team first, then opens there', () => {
    const { palette, store, selectTeam, seen } = setup()
    palette.open()
    type('bruno')
    rows()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(selectTeam).toHaveBeenCalledWith('T2')
    expect(seen).toEqual([['T2', null]]) // nothing was open yet when the team switched
    expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toMatchObject({ teamId: 'T2', ref: { kind: 'person', personId: 'm1' } })
    expect(document.querySelector('.tt-palette-overlay')).toBeNull()
  })

  test('a row on the active team does not call selectTeam', () => {
    const { palette, selectTeam } = setup()
    palette.open()
    rows().find((r) => r.textContent?.includes('Carla'))!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(selectTeam).not.toHaveBeenCalled()
  })

  test('review focus: Enter with zero matches shows "No results" and does nothing', () => {
    const { palette, store, selectTeam } = setup()
    palette.open()
    type('zzzzzz')
    expect(rows()).toHaveLength(0)
    expect(document.querySelector('.tt-palette-empty')!.textContent).toBe('No results')
    key('Enter')
    expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
    expect(selectTeam).not.toHaveBeenCalled()
    expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()
  })
})

describe('removing a favorite with ✕', () => {
  test('removes it from the doc without committing, and keeps the palette open', () => {
    const { palette, store, selectTeam } = setup({ favorites: true })
    palette.open()
    const x = document.querySelector<HTMLButtonElement>('.tt-palette-remove')!
    expect(x.title).toBe('Remove from favorites')
    expect(x.getAttribute('tabindex')).toBe('-1') // mouse-only: Tab from the input must not land on it
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(store.doc.favorites).toEqual([])
    expect(document.querySelector('.tt-palette-overlay')).not.toBeNull()
    expect(selectTeam).not.toHaveBeenCalled()
    expect(currentLoc(store.doc.nav.panes[store.doc.nav.focusedPane])).toBeNull()
  })

  test('review focus: removing the last favorite drops the section and clamps the selection', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    expect(headings()[0]).toContain('Favorites')
    document.querySelector<HTMLButtonElement>('.tt-palette-remove')!.click()
    expect(headings().some((h) => h.includes('Favorites'))).toBe(false)
    expect(document.querySelector('.tt-palette-remove')).toBeNull()
    expect(rows().filter((r) => r.classList.contains('selected'))).toHaveLength(1)
    key('Enter') // selected row is a normal current-team row; must not throw
  })

  test('review focus: ✕ on the selected last row keeps a valid selection', () => {
    const { palette } = setup({ favorites: true })
    palette.open()
    key('ArrowDown')
    key('ArrowUp') // back on the favorite row, which is also index 0
    document.querySelector<HTMLButtonElement>('.tt-palette-remove')!.click()
    expect(rows().filter((r) => r.classList.contains('selected'))).toHaveLength(1)
  })
})

describe('focus on dismiss', () => {
  function focusedTrigger(): HTMLInputElement {
    const trigger = document.createElement('input')
    document.body.appendChild(trigger)
    trigger.focus()
    return trigger
  }

  test('Escape hands focus back to what had it before the palette opened', () => {
    const { palette } = setup()
    const trigger = focusedTrigger()
    palette.open()
    expect(document.activeElement).not.toBe(trigger)
    key('Escape')
    expect(document.querySelector('.tt-palette-overlay')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('clicking the overlay backdrop hands focus back too', () => {
    const { palette } = setup()
    const trigger = focusedTrigger()
    palette.open()
    document.querySelector<HTMLElement>('.tt-palette-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(document.querySelector('.tt-palette-overlay')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('committing a row does not restore focus (the pane re-renders)', () => {
    const { palette } = setup()
    const trigger = focusedTrigger()
    palette.open()
    rows().find((r) => r.textContent?.includes('Carla'))!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(document.querySelector('.tt-palette-overlay')).toBeNull()
    expect(document.activeElement).not.toBe(trigger)
  })

  test('a previously focused element that left the DOM is skipped without throwing', () => {
    const { palette } = setup()
    const trigger = focusedTrigger()
    palette.open()
    trigger.remove()
    expect(() => key('Escape')).not.toThrow()
    expect(document.querySelector('.tt-palette-overlay')).toBeNull()
  })
})
