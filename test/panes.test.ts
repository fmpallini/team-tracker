import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, navigateFocusedHistory, teamHasHistory, openTeamDefaultLayout, type PaneManager, type ModuleItem } from '../src/ui/panes'
import { filterModuleItems } from '../src/ui/palette'
import { todayIso } from '../src/core/i18n'
import type { Loc } from '../src/core/types'

// jsdom does not implement matchMedia; createShell() needs it to watch the
// OS theme preference (same stub as test/sidebar.test.ts).
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

function setup(): { shell: Shell; store: Store; pm: PaneManager } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  return { shell, store, pm }
}

function addTeam(store: Store, id: string): void {
  store.update((d) => {
    d.teams.push({
      id, name: id, emoji: '🚀',
      stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    })
  })
}

function paneBtn(idx: 0 | 1, cls: string): HTMLButtonElement {
  const el = document.querySelector(`[data-pane-idx="${idx}"] .${cls}`)
  if (!el) throw new Error(`${cls} not found for pane ${idx}`)
  return el as HTMLButtonElement
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('first open of a team lands in split: daily today left, members right', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  openTeamDefaultLayout(pm, store, 'T1')
  expect(store.doc.nav.split).toBe(true)
  const left = store.doc.nav.panes[0].history.at(-1)!
  const right = store.doc.nav.panes[1].history.at(-1)!
  expect(left.ref).toEqual({ kind: 'daily', date: todayIso() })
  expect(right.ref).toEqual({ kind: 'members' })
})

test('teamHasHistory reflects whether any pane history contains the team', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  expect(teamHasHistory(store, 'T1')).toBe(false)
  openTeamDefaultLayout(pm, store, 'T1')
  expect(teamHasHistory(store, 'T1')).toBe(true)
})

test('openInPane resolves conflicts by focusing the other pane and shows a toast', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.openInPane(0, locA)
  pm.openInPane(1, locB)
  expect(store.doc.nav.focusedPane).toBe(1)

  // Same Loc already open in pane 0 -> pane 1 should refuse and focus pane 0 instead.
  pm.openInPane(1, locA)
  expect(store.doc.nav.focusedPane).toBe(0)
  expect(store.doc.nav.panes[1]).toEqual({ history: [locB], index: 0 }) // untouched
  expect(document.querySelector('.tt-toast')).not.toBeNull()
})

test('pane back/forward buttons are disabled exactly when navigateHistory would return null', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.openInPane(0, locA)
  expect(paneBtn(0, 'tt-pane-back-btn').disabled).toBe(true)
  expect(paneBtn(0, 'tt-pane-fwd-btn').disabled).toBe(true)

  pm.openInPane(0, locB)
  expect(paneBtn(0, 'tt-pane-back-btn').disabled).toBe(false)
  expect(paneBtn(0, 'tt-pane-fwd-btn').disabled).toBe(true)

  paneBtn(0, 'tt-pane-back-btn').click()
  expect(store.doc.nav.panes[0]).toEqual({ history: [locA, locB], index: 0 })
  expect(paneBtn(0, 'tt-pane-back-btn').disabled).toBe(true)
  expect(paneBtn(0, 'tt-pane-fwd-btn').disabled).toBe(false)
})

test('toggleSplit flips nav.split and the grid dataset', () => {
  const { store, pm } = setup()
  expect(store.doc.nav.split).toBe(false)

  pm.toggleSplit()
  expect(store.doc.nav.split).toBe(true)
  expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('true')

  pm.toggleSplit()
  expect(store.doc.nav.split).toBe(false)
  expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('false')
})

test('navigateFocusedHistory steps the currently focused pane and re-renders', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.openInPane(0, locA)
  pm.openInPane(0, locB) // history [locA, locB], index 1, focused 0

  navigateFocusedHistory(pm, store, -1)
  expect(store.doc.nav.panes[0]).toEqual({ history: [locA, locB], index: 0 })
  expect(paneBtn(0, 'tt-pane-back-btn').disabled).toBe(true)

  // No earlier entry exists: a further back-step is a no-op.
  navigateFocusedHistory(pm, store, -1)
  expect(store.doc.nav.panes[0].index).toBe(0)
})

test('shows first-team CTA when doc has no teams', () => {
  setup() // doc.teams = [] by default (createEmptyDocument)
  const cta = document.querySelector('.tt-pane-cta button')
  expect(cta).not.toBeNull()
  let fired = false
  document.addEventListener('tt-add-team-request', () => { fired = true }, { once: true })
  ;(cta as HTMLButtonElement).click()
  expect(fired).toBe(true)
})

test('filterModuleItems matches substrings case- and accent-insensitively (palette filter)', () => {
  const items: ModuleItem[] = [
    { label: 'María', ref: { kind: 'actions' } },
    { label: 'Stakeholders', ref: { kind: 'stakeholders' } },
  ]

  expect(filterModuleItems(items, 'maria').map((i) => i.label)).toEqual(['María'])
  expect(filterModuleItems(items, 'STAKE').map((i) => i.label)).toEqual(['Stakeholders'])
  expect(filterModuleItems(items, '')).toEqual(items)
  expect(filterModuleItems(items, 'zzz')).toEqual([])
})
