import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, navigateFocusedHistory, teamHasHistory, openTeamDefaultLayout, type PaneManager, type ModuleItem } from '../src/ui/panes'
import { filterModuleItems } from '../src/ui/palette'
import { todayIso } from '../src/core/i18n'
import { currentLoc } from '../src/core/nav'
import { renderDailyNotes } from '../src/modules/daily-notes'
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

test('daily-notes calendar click in each split pane sets that pane\'s own day, independently of the other pane', () => {
  const { store, pm } = setup()
  pm.registerModule('daily', renderDailyNotes)
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  store.updateNav((d) => { d.nav.split = true })

  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
  pm.openInPane(1, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } })

  function clickDay(paneIdx: 0 | 1, day: string): void {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(`[data-pane-idx="${paneIdx}"] .tt-calendar-day:not(.tt-calendar-day-blank)`)
    ).find((b) => b.firstChild?.textContent === day)
    if (!btn) throw new Error(`day "${day}" not found in pane ${paneIdx}`)
    btn.click()
  }

  clickDay(0, '15')
  clickDay(1, '20')

  expect(currentLoc(store.doc.nav.panes[0])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-15' } })
  expect(currentLoc(store.doc.nav.panes[1])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-20' } })
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

test('shows first-team CTA when doc has no teams, with no pane shell (bars/split) visible', () => {
  setup() // doc.teams = [] by default (createEmptyDocument)
  const grid = document.querySelector('.tt-panes-grid') as HTMLElement
  expect(grid.style.display).toBe('none')
  const cta = document.querySelector('.tt-pane-cta button')
  expect(cta).not.toBeNull()
  expect(cta!.closest('.tt-pane-body')).toBeNull()
  let fired = false
  document.addEventListener('tt-add-team-request', () => { fired = true }, { once: true })
  ;(cta as HTMLButtonElement).click()
  expect(fired).toBe(true)
})

test('creating the first team hides the CTA and shows the pane shell', () => {
  const { store, pm } = setup()
  store.update((d) => {
    d.teams.push({ id: 'T1', name: 'T1', emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} })
  })
  pm.renderAll()
  const grid = document.querySelector('.tt-panes-grid') as HTMLElement
  expect(grid.style.display).not.toBe('none')
  const noTeams = document.querySelector('.tt-no-teams') as HTMLElement
  expect(noTeams.style.display).toBe('none')
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
