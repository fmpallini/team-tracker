import { mountSearch } from '../src/ui/search-ui'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager } from '../src/ui/panes'
import type { Loc, Team } from '../src/core/types'

// jsdom does not implement matchMedia; createShell() needs it to watch the
// OS theme preference (same stub as test/panes.test.ts and test/sidebar.test.ts).
function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function buildStore(teams: Team[], activeTeamId: string | null): Store {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(...teams)
  doc.nav.activeTeamId = activeTeamId
  return createStore(doc)
}

function fakePM(): PaneManager & { calls: Loc[] } {
  const calls: Loc[] = []
  return {
    calls,
    openInPane: () => {},
    openInFocused: (loc: Loc) => { calls.push(loc) },
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
  }
}

function mount(store: Store, pm: PaneManager): { shell: Shell; input: HTMLInputElement } {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  mountSearch(shell, store, pm, 'en-US')
  const input = shell.headerLeft.querySelector('.tt-search-input') as HTMLInputElement
  return { shell, input }
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(input: HTMLInputElement, k: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

function isOpen(): boolean {
  return document.querySelector('.tt-search-dropdown')!.classList.contains('open')
}

const oneNoteTeam: Team = {
  id: 'T1', name: 'Team One', emoji: '🚀',
  stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
  dailyNotes: { '2026-07-01': 'alpha note' },
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

test('debounces the search by 150ms', () => {
  const store = buildStore([oneNoteTeam], 'T1')
  const { input } = mount(store, fakePM())

  type(input, 'alpha')
  vi.advanceTimersByTime(100)
  expect(isOpen()).toBe(false)

  vi.advanceTimersByTime(60)
  expect(isOpen()).toBe(true)
})

test('clearing the query closes the dropdown', () => {
  const store = buildStore([oneNoteTeam], 'T1')
  const { input } = mount(store, fakePM())

  type(input, 'alpha')
  vi.advanceTimersByTime(200)
  expect(isOpen()).toBe(true)

  type(input, '')
  vi.advanceTimersByTime(200)
  expect(isOpen()).toBe(false)
})

test('renders module icons per kind, in candidate order, and toggles teamName with the all-teams checkbox', () => {
  const team: Team = {
    id: 'T1', name: 'Team One', emoji: '🚀',
    stakeholders: [{ id: 'p1', name: 'Widget Sam', role: '', parentId: null, order: 0, notes: 'widget bio' }],
    members: [],
    actionItems: [{ id: 'a1', text: 'widget task', done: false, dueDate: null, assignee: '', order: 0, notes: '' }],
    milestones: [{ id: 'm1', date: '2026-07-01', title: 'widget launch', done: false, followup: '' }],
    risks: [{ id: 'r1', title: 'widget risk', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
    dailyNotes: { '2026-07-01': 'widget note' },
  }
  const store = buildStore([team], 'T1')
  const { input } = mount(store, fakePM())

  type(input, 'widget')
  vi.advanceTimersByTime(200)

  const icons = Array.from(document.querySelectorAll('.tt-search-row .tt-search-icon')).map((n) => n.textContent)
  expect(icons).toEqual(['📅', '🧑', '✅', '🚩', '⚠️'])
  expect(document.querySelectorAll('.tt-search-team')).toHaveLength(0)

  const checkbox = document.querySelector('.tt-search-all-teams input') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))

  const teamNames = Array.from(document.querySelectorAll('.tt-search-team')).map((n) => n.textContent)
  expect(teamNames).toEqual(['Team One', 'Team One', 'Team One', 'Team One', 'Team One'])
})

test('highlights matched terms found via normalize() at the correct position in accented text', () => {
  const team: Team = {
    id: 'T1', name: 'Team One', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-07-01': 'Reuniao sobre café da manha com o time' },
  }
  const store = buildStore([team], 'T1')
  const { input } = mount(store, fakePM())

  // Query has no accent; the match must still be found (via normalize) and
  // the <mark> must wrap the *original*, accented slice ("café"), not some
  // shifted or unaccented substitute.
  type(input, 'cafe')
  vi.advanceTimersByTime(200)

  const marks = document.querySelectorAll('.tt-search-snippet mark')
  expect(marks).toHaveLength(1)
  expect(marks[0]!.textContent).toBe('café')
})

test('scopes to the active team by default; the all-teams checkbox widens the search', () => {
  const t1: Team = {
    id: 'T1', name: 'Team One', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-07-01': 'nothing relevant here' },
  }
  const t2: Team = {
    id: 'T2', name: 'Team Two', emoji: '🎯',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-07-02': 'zephyr project kickoff' },
  }
  const store = buildStore([t1, t2], 'T1')
  const { input } = mount(store, fakePM())

  type(input, 'zephyr')
  vi.advanceTimersByTime(200)
  expect(document.querySelectorAll('.tt-search-row')).toHaveLength(0)
  expect(document.querySelector('.tt-search-empty')).not.toBeNull()

  const checkbox = document.querySelector('.tt-search-all-teams input') as HTMLInputElement
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))

  const rows = document.querySelectorAll('.tt-search-row')
  expect(rows).toHaveLength(1)
  expect(document.querySelector('.tt-search-team')!.textContent).toBe('Team Two')
})

test('arrow keys navigate results with wraparound in both directions; Enter opens the selected result', () => {
  const team: Team = {
    id: 'T1', name: 'Team One', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-07-01': 'alpha note one', '2026-07-02': 'alpha note two', '2026-07-03': 'alpha note three' },
  }
  const store = buildStore([team], 'T1')
  const pm = fakePM()
  const { input } = mount(store, pm)

  type(input, 'alpha')
  vi.advanceTimersByTime(200)
  expect(document.querySelectorAll('.tt-search-row')).toHaveLength(3)

  key(input, 'ArrowUp') // selected 0 -> wraps to 2
  key(input, 'ArrowDown') // 2 -> 0
  key(input, 'ArrowDown') // 0 -> 1
  key(input, 'Enter')

  expect(pm.calls).toEqual([{ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } }])
})

test('Escape closes the dropdown and keeps focus on the input; a second Escape blurs it', () => {
  const store = buildStore([oneNoteTeam], 'T1')
  const { input } = mount(store, fakePM())
  input.focus()

  type(input, 'alpha')
  vi.advanceTimersByTime(200)
  expect(isOpen()).toBe(true)

  key(input, 'Escape')
  expect(isOpen()).toBe(false)
  expect(document.activeElement).toBe(input)

  key(input, 'Escape')
  expect(document.activeElement).not.toBe(input)
})

test('clicking a result opens it via pm.openInFocused and closes the dropdown', () => {
  const store = buildStore([oneNoteTeam], 'T1')
  const pm = fakePM()
  const { input } = mount(store, pm)

  type(input, 'alpha')
  vi.advanceTimersByTime(200)

  const row = document.querySelector('.tt-search-row') as HTMLElement
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }))

  expect(pm.calls).toEqual([{ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } }])
  expect(isOpen()).toBe(false)
})

test('does not accumulate document-level listeners across repeated open/close cycles', () => {
  const store = buildStore([oneNoteTeam], 'T1')
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)

  const addSpy = vi.spyOn(document, 'addEventListener')
  mountSearch(shell, store, fakePM(), 'en-US')
  const countAfterMount = addSpy.mock.calls.length
  const input = shell.headerLeft.querySelector('.tt-search-input') as HTMLInputElement

  for (let i = 0; i < 5; i++) {
    type(input, 'alpha')
    vi.advanceTimersByTime(200)
    key(input, 'Escape')
  }

  expect(addSpy.mock.calls.length).toBe(countAfterMount)

  // Sanity: outside-click-closes still works correctly after many cycles.
  type(input, 'alpha')
  vi.advanceTimersByTime(200)
  expect(isOpen()).toBe(true)
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(isOpen()).toBe(false)

  addSpy.mockRestore()
})
