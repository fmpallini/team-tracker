import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, navigateFocusedHistory, invalidateUnsplitStash, teamHasHistory, openTeamDefaultLayout, restoreTeamLayout, buildModuleItems, type PaneManager, type ModuleItem } from '../src/ui/panes'
import { filterModuleItems } from '../src/ui/palette'
import { todayIso, t } from '../src/core/i18n'
import { currentLoc } from '../src/core/nav'
import { renderDailyNotes } from '../src/modules/daily-notes'
import { KIND_ICON } from '../src/core/search'
import type { Loc, Team } from '../src/core/types'

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

test('openBothPanes writes both panes and the given focusedPane in one shot', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  addTeam(store, 'T2')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  store.updateNav((d) => { d.nav.split = true })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
  pm.openInPane(1, { teamId: 'T1', ref: { kind: 'members' } })

  const target0: Loc = { teamId: 'T2', ref: { kind: 'daily', date: '2026-07-05' } }
  const target1: Loc = { teamId: 'T2', ref: { kind: 'actions' } }
  pm.openBothPanes(target0, target1, 1)

  expect(currentLoc(store.doc.nav.panes[0])).toEqual(target0)
  expect(currentLoc(store.doc.nav.panes[1])).toEqual(target1)
  expect(store.doc.nav.focusedPane).toBe(1)
})

describe('openInSecondaryPane', () => {
  test('turns split on when unsplit, and opens the target in the other pane', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    expect(store.doc.nav.split).toBe(false)

    const target: Loc = { teamId: 'T1', ref: { kind: 'members' } }
    pm.openInSecondaryPane(0, target)

    expect(store.doc.nav.split).toBe(true)
    expect(currentLoc(store.doc.nav.panes[1])).toEqual(target)
    // The pane hosting the click (0) keeps its own content — untouched.
    expect(currentLoc(store.doc.nav.panes[0])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
  })

  test('remembers the team as split (teamSplit) when turning split on', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })

    pm.openInSecondaryPane(0, { teamId: 'T1', ref: { kind: 'members' } })

    expect(store.doc.nav.teamSplit['T1']).toBe(true)
  })

  test('leaves split alone when already split', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    store.updateNav((d) => { d.nav.split = true })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'members' } })

    const target: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    pm.openInSecondaryPane(0, target)

    expect(currentLoc(store.doc.nav.panes[1])).toEqual(target)
  })

  test('clicking from pane 1 opens the target in pane 0', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    store.updateNav((d) => { d.nav.split = true })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'members' } })

    const target: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    pm.openInSecondaryPane(1, target)

    expect(currentLoc(store.doc.nav.panes[0])).toEqual(target)
    // The pane hosting the click (1) keeps its own content.
    expect(currentLoc(store.doc.nav.panes[1])).toEqual({ teamId: 'T1', ref: { kind: 'members' } })
  })

  test('falls back to same-pane navigation when the target conflicts with the source pane\'s own loc, without touching split state', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'actions' } })

    const landed = pm.openInSecondaryPane(0, { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } })

    expect(landed).toBe(0)
    // Board-kind Locs (actions/milestones/risks) are identity-equal at the
    // module level regardless of itemId — see sameLoc/locsConflict in
    // core/nav.ts, which only special-case 'daily' and 'person'. So the
    // fallback's openInPane(fromIdx, target) call is correctly a same-Loc
    // no-op here: pane 0 stays on the actions board it already had open
    // (itemId-specific scrolling/highlighting is driven separately, from
    // atref.ts's own closure over target.id, not from the persisted nav Loc).
    expect(currentLoc(store.doc.nav.panes[0])).toEqual({ teamId: 'T1', ref: { kind: 'actions' } })
    expect(store.doc.nav.split).toBe(false)
  })

  test('returns the landing pane index (otherPaneIdx) on the normal, non-conflicting path', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })

    const landed = pm.openInSecondaryPane(0, { teamId: 'T1', ref: { kind: 'members' } })

    expect(landed).toBe(1)
  })
})

test('restoreTeamLayout keeps focusedPane on 0 when the team\'s remembered layout is single-pane, so a later openInFocused (e.g. the due-date reminder list) lands on the visible pane', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  addTeam(store, 'T2')

  // T1 gets history and is explicitly remembered as single-pane, with pane 1
  // last focused while it was still visible (split) — mirrors a team that
  // was viewed split, then unsplit (toggleSplit resets focusedPane to 0, but
  // teamSplit[id] stays whatever the user last chose before restoreTeamLayout
  // runs again on a later visit).
  openTeamDefaultLayout(pm, store, 'T1')
  store.updateNav((d) => { d.nav.teamSplit['T1'] = false })

  // Switch away to T2 (also split by default) so focusedPane is free to be
  // anything before we switch back to T1.
  openTeamDefaultLayout(pm, store, 'T2')
  expect(store.doc.nav.focusedPane).toBe(0)
  store.updateNav((d) => { d.nav.focusedPane = 1 })

  restoreTeamLayout(pm, store, 'T1')

  expect(store.doc.nav.split).toBe(false)
  expect(store.doc.nav.focusedPane).toBe(0)
})

test('restoreTeamLayout never restores the same module kind into both panes, even when each pane\'s own independent history says to (regression: search-triggered team switch could open the same module side by side)', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  addTeam(store, 'T2')

  openTeamDefaultLayout(pm, store, 'T1') // pane0=daily(T1), pane1=members(T1)
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'milestones' } }) // pane0=milestones(T1)

  // pane0 moves on to T2 entirely — its own history still remembers
  // milestones as the last thing it showed for T1.
  pm.openInPane(0, { teamId: 'T2', ref: { kind: 'daily', date: '2026-03-01' } }, { force: true })

  // pane1 (still on T1) now also navigates to milestones — live conflict
  // guard sees pane0 on a *different team* and lets it through.
  pm.openInPane(1, { teamId: 'T1', ref: { kind: 'milestones' } })

  // Switching back to T1 (what search does when a result belongs to a team
  // other than the one currently active) restores each pane's own
  // independently-remembered T1 Loc — both happen to be "milestones".
  restoreTeamLayout(pm, store, 'T1')

  const p0 = currentLoc(store.doc.nav.panes[0])!
  const p1 = currentLoc(store.doc.nav.panes[1])!
  expect(p0.teamId).toBe('T1')
  expect(p1.teamId).toBe('T1')
  expect(p0.ref.kind).toBe('milestones')
  expect(p1.ref.kind).not.toBe('milestones') // resolved to a fallback instead of duplicating
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
    // Only the last `.tt-calendar-grid` in the pane is the current month —
    // showPrevMonth stacks a read-and-click-able previous-month grid above it.
    const grids = document.querySelectorAll<HTMLElement>(`[data-pane-idx="${paneIdx}"] .tt-calendar-grid`)
    const currentGrid = grids[grids.length - 1]
    if (!currentGrid) throw new Error(`no calendar grid found in pane ${paneIdx}`)
    const btn = Array.from(currentGrid.querySelectorAll<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)'))
      .find((b) => b.firstChild?.textContent === day)
    if (!btn) throw new Error(`day "${day}" not found in pane ${paneIdx}`)
    btn.click()
  }

  clickDay(0, '15')
  clickDay(1, '20')

  expect(currentLoc(store.doc.nav.panes[0])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-15' } })
  expect(currentLoc(store.doc.nav.panes[1])).toEqual({ teamId: 'T1', ref: { kind: 'daily', date: '2026-07-20' } })
})

test('openInPane resolves conflicts by focusing the other pane and shows a toast (split only — see unsplit tests below)', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.toggleSplit() // the same-module-in-both-panes conflict only applies while both panes are visible
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

test('openInPane({ force: true }) bypasses the same-module conflict guard entirely', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.toggleSplit()
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }

  pm.openInPane(0, locA)
  // Without force this would silently refuse (focusOther) and leave pane 1 untouched,
  // since both panes would show the same module kind for the same team.
  pm.openInPane(1, locA, { force: true })

  expect(document.querySelector('.tt-toast')).toBeNull()
  expect(store.doc.nav.focusedPane).toBe(1)
  expect(currentLoc(store.doc.nav.panes[1])).toEqual(locA)
})

test('unsplit: opening a module in pane 0 succeeds even if pane 1 (hidden) has that exact module stashed as current', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit()
  pm.openInPane(1, locB) // stash something in pane 1 while it's still visible
  pm.toggleSplit() // back to unsplit — pane 1 is now hidden but still holds locB

  // Previously this would silently refuse (focusOther) and hand focus to the
  // now-invisible pane 1 — the bug was that the conflict check ran at all
  // while pane 1 is hidden.
  pm.openInPane(0, locB)

  expect(document.querySelector('.tt-toast')).toBeNull()
  expect(store.doc.nav.focusedPane).toBe(0)
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
})

test('unsplit: opening a module in pane 0 that matches pane 1\'s stashed current Loc steps pane 1 back to avoid a duplicate on re-split', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit()
  pm.openInPane(1, locA)
  pm.openInPane(1, locB) // pane 1 history: [locA, locB], current = locB
  pm.toggleSplit() // unsplit; pane 1 hidden, still "current" = locB

  pm.openInPane(0, locB) // now pane 0 also shows locB

  // Pane 1 stepped back to its own previous entry (locA) instead of keeping
  // locB, so a later re-split doesn't show the same module in both panes.
  expect(currentLoc(store.doc.nav.panes[1])).toEqual(locA)
})

test('toggleSplit resets focusedPane to 0 when un-splitting, so it never points at the now-hidden pane 1', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.toggleSplit()
  pm.openInPane(1, { teamId: 'T1', ref: { kind: 'actions' } })
  expect(store.doc.nav.focusedPane).toBe(1)

  pm.toggleSplit() // back to unsplit
  expect(store.doc.nav.focusedPane).toBe(0)
})

test('un-splitting while pane 1 is focused, then re-splitting without navigating, restores pane 0\'s original content instead of leaving both panes on pane 1\'s content', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit() // split on
  pm.openInPane(0, locA)
  pm.openInPane(1, locB) // focuses pane 1

  pm.toggleSplit() // "expand the right pane": unsplit, pane 0 pulls in pane 1's (B) content
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)

  pm.toggleSplit() // back to split — previously this left both panes showing B
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locA)
  expect(currentLoc(store.doc.nav.panes[1])).toEqual(locB)
})

test('clicking the unsplit button in pane 1\'s own bar expands pane 1, even when pane 0 was the last focused pane (regression: click target is the button, not the pane div, so a bubble-phase focus listener used to fire too late)', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit() // split on
  pm.openInPane(0, locA)
  pm.openInPane(1, locB)
  // Force focus back onto pane 0 (as if the user last clicked there), then
  // click the unsplit button that lives in pane 1's own bar — expanding
  // pane 1 is exactly what clicking *its* button means, regardless of which
  // pane was focused a moment ago.
  store.updateNav((d) => { d.nav.focusedPane = 0 })

  paneBtn(1, 'tt-pane-split-btn').click()

  expect(store.doc.nav.split).toBe(false)
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
})

test('opening a module already shown in the other pane focuses that pane for real, surviving the click bubbling back up to the pane it started in (regression)', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit() // split on
  pm.openInPane(1, locB)
  store.updateNav((d) => { d.nav.focusedPane = 0 })

  // Pick "Milestones" from pane 0's own module menu — a real DOM click whose
  // target is nested inside pane 0's bar, so it bubbles back up through pane
  // 0's wrapper after openInPane's focusOther branch runs.
  paneBtn(0, 'tt-pane-modules-btn').click()
  const milestonesItem = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pane-idx="0"] .tt-pane-menu-item'))
    .find((b) => b.textContent === t('en-US', 'module_milestones'))
  if (!milestonesItem) throw new Error('milestones menu item not found')
  milestonesItem.click()

  expect(document.querySelector('.tt-toast')).not.toBeNull()
  expect(store.doc.nav.focusedPane).toBe(1)
})

test('pane module dropdown lists General notes right after Daily notes', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pane-idx="0"] .tt-pane-menu-item'))

  expect(items[0]?.textContent).toBe(t('en-US', 'module_daily'))
  expect(items[1]?.textContent).toBe(t('en-US', 'module_general_notes'))
})

test('un-splitting while pane 1 is focused, navigating in the now-single pane, then re-splitting keeps the navigation instead of reverting to pane 0\'s pre-expand content', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }
  const locC: Loc = { teamId: 'T1', ref: { kind: 'risks' } }

  pm.toggleSplit() // split on
  pm.openInPane(0, locA)
  pm.openInPane(1, locB) // focuses pane 1

  pm.toggleSplit() // unsplit: pane 0 pulls in B
  pm.openInPane(0, locC) // user browses elsewhere while single-pane

  pm.toggleSplit() // back to split — should keep C on the left, not resurrect stashed A
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locC)
  expect(currentLoc(store.doc.nav.panes[1])).toEqual(locB)
})

test('un-splitting while pane 1 is focused, then stepping history via navigateFocusedHistory (the Alt+Arrow hotkey path, which bypasses openInPane), then re-splitting keeps the stepped-to entry instead of resurrecting the stash', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB1: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }
  const locB2: Loc = { teamId: 'T1', ref: { kind: 'risks' } }

  pm.toggleSplit() // split on
  pm.openInPane(0, locA)
  pm.openInPane(1, locB1)
  pm.openInPane(1, locB2) // pane 1 history: [locB1, locB2], index 1, current locB2; focuses pane 1

  pm.toggleSplit() // unsplit: pane 0 pulls in pane 1's (locB2) content
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB2)

  // Real navigation via the Alt+Arrow hotkey path — stepPaneHistory is
  // called directly, not through openInPane, so this exercises the one
  // invalidation site that can't reach into createPaneManager's closure
  // directly (see unsplitStashInvalidators in src/ui/panes.ts).
  navigateFocusedHistory(pm, store, -1)
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB1)

  pm.toggleSplit() // back to split — should keep locB1 (the stepped-to entry), not resurrect stashed A
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB1)
  expect(currentLoc(store.doc.nav.panes[1])).toEqual(locB2)
})

test('invalidateUnsplitStash (the hook sidebar.ts\'s deleteTeam uses, since it prunes nav.panes history directly rather than through openInPane/stepPaneHistory) clears the stash so a later re-split does not resurrect it', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit() // split on
  pm.openInPane(0, locA)
  pm.openInPane(1, locB) // focuses pane 1

  pm.toggleSplit() // unsplit: pane 0 pulls in pane 1's (locB) content
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)

  invalidateUnsplitStash(store) // simulates deleteTeam's direct history mutation
  pm.toggleSplit() // back to split — stash was invalidated, so pane 0 keeps locB instead of resurrecting locA

  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
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

describe('setSplitSpaceConstrained (responsive auto-hide)', () => {
  test('hides the grid split without touching persisted nav.split', () => {
    const { store, pm } = setup()
    pm.toggleSplit()
    expect(store.doc.nav.split).toBe(true)

    pm.setSplitSpaceConstrained(true)
    expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('false')
    expect(store.doc.nav.split).toBe(true) // preference untouched, purely visual

    pm.setSplitSpaceConstrained(false)
    expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('true')
  })

  test('manual toggleSplit click wins over an active space-constrained hide', () => {
    const { store, pm } = setup()
    pm.toggleSplit() // split on
    pm.setSplitSpaceConstrained(true) // then narrowed — visually hidden again
    expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('false')

    pm.toggleSplit() // user forces it back open even though still "narrow"

    expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('true')
    expect(store.doc.nav.split).toBe(true)
  })

  test('a later widen (setSplitSpaceConstrained(false)) does not fight a manual unsplit made while narrow', () => {
    const { store, pm } = setup()
    pm.toggleSplit() // split on
    pm.setSplitSpaceConstrained(true) // narrowed
    pm.toggleSplit() // user manually re-shows despite being narrow -> split true, spaceHidden cleared
    pm.toggleSplit() // user then manually unsplits again -> split false
    expect(store.doc.nav.split).toBe(false)

    pm.setSplitSpaceConstrained(false) // window widens back out
    expect(document.querySelector('.tt-panes-grid')?.getAttribute('data-split')).toBe('false')
  })
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

test('print button is disabled when the pane is empty and enabled once a module is open', () => {
  const { store, pm } = setup()
  expect(paneBtn(0, 'tt-pane-print-btn').disabled).toBe(true)

  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  expect(paneBtn(0, 'tt-pane-print-btn').disabled).toBe(false)
})

test('print button opens a print window with a header (team/module) and a clone of the pane body, via DOM APIs', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  const printSpy = vi.fn()
  const headAppend = vi.fn()
  const bodyAppend = vi.fn()
  const fakeDoc = {
    write: vi.fn(),
    close: vi.fn(),
    head: { appendChild: headAppend },
    body: { append: bodyAppend },
    createElement: (tag: string) => document.createElement(tag),
  }
  const fakeWin = { document: fakeDoc, focus: vi.fn(), print: printSpy } as unknown as Window
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin)

  paneBtn(0, 'tt-pane-print-btn').click()

  expect(openSpy).toHaveBeenCalled()
  expect(headAppend).toHaveBeenCalled() // app stylesheet clone + print override style
  expect(bodyAppend).toHaveBeenCalledOnce()
  const [header, content] = bodyAppend.mock.calls[0]! as HTMLElement[]
  expect(header!.className).toBe('tt-print-header')
  expect(header!.textContent).toContain('T1')
  expect(content!.className).toBe('tt-print-content')
  expect(printSpy).toHaveBeenCalled()
})

test('printing always hides the daily-notes calendar column — it\'s a navigation aid, not printable content', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-10' } })

  const printSpy = vi.fn()
  const headAppend = vi.fn()
  const fakeDoc = {
    write: vi.fn(),
    close: vi.fn(),
    head: { appendChild: headAppend },
    body: { append: vi.fn() },
    createElement: (tag: string) => document.createElement(tag),
  }
  const fakeWin = { document: fakeDoc, focus: vi.fn(), print: printSpy } as unknown as Window
  vi.spyOn(window, 'open').mockReturnValue(fakeWin)

  paneBtn(0, 'tt-pane-print-btn').click()

  const styleEls = headAppend.mock.calls.map((c) => c[0] as HTMLStyleElement).filter((n) => n.tagName === 'STYLE')
  const printOverrideStyle = styleEls.find((s) => s.textContent?.includes('tt-daily-calendar-col'))
  expect(printOverrideStyle).toBeDefined()
  expect(printOverrideStyle!.textContent).toMatch(/\.tt-print-content \.tt-daily-calendar-col\s*\{\s*display:\s*none/)
})

test('openTeamDefaultLayout records split=true in nav.teamSplit for that team', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  openTeamDefaultLayout(pm, store, 'T1')
  expect(store.doc.nav.teamSplit['T1']).toBe(true)
})

test('toggleSplit records the current split state under the active team', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  expect(store.doc.nav.split).toBe(false)

  pm.toggleSplit()
  expect(store.doc.nav.split).toBe(true)
  expect(store.doc.nav.teamSplit['T1']).toBe(true)

  pm.toggleSplit()
  expect(store.doc.nav.split).toBe(false)
  expect(store.doc.nav.teamSplit['T1']).toBe(false)
})

test('toggleSplit does not record anything when no team is active', () => {
  const { store, pm } = setup()
  expect(store.doc.nav.activeTeamId).toBeNull()
  pm.toggleSplit()
  expect(store.doc.nav.teamSplit).toEqual({})
})

test('buildModuleItems includes one entry per action item/milestone/risk, after the whole-board entries', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀', stakeholders: [], members: [],
    actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
    milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
    risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
    dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')

  expect(items).toContainEqual({ label: `${KIND_ICON.actions} Fix bug`, ref: { kind: 'actions', itemId: 'a1' } })
  expect(items).toContainEqual({ label: `${KIND_ICON.milestones} Ship v2`, ref: { kind: 'milestones', itemId: 'm1' } })
  expect(items).toContainEqual({ label: `${KIND_ICON.risks} Vendor delay`, ref: { kind: 'risks', itemId: 'r1' } })

  const actionsBoardIdx = items.findIndex((i) => i.ref.kind === 'actions' && !('itemId' in i.ref && i.ref.itemId))
  const actionItemIdx = items.findIndex((i) => i.ref.kind === 'actions' && 'itemId' in i.ref && i.ref.itemId === 'a1')
  expect(actionItemIdx).toBeGreaterThan(actionsBoardIdx)
})

test('buildModuleItems with no team includes the daily-notes entry, the general-notes entry, and all 5 whole-board entries, but no per-item entries', () => {
  const items = buildModuleItems(null, 'en-US')
  expect(items).toEqual([
    { label: expect.any(String), ref: { kind: 'daily', date: expect.any(String) } },
    { label: `${KIND_ICON.general} General notes`, ref: { kind: 'general' } },
    { label: `${KIND_ICON.stakeholders} Stakeholders`, ref: { kind: 'stakeholders' } },
    { label: `${KIND_ICON.members} Members`, ref: { kind: 'members' } },
    { label: `${KIND_ICON.actions} Action items`, ref: { kind: 'actions' } },
    { label: `${KIND_ICON.milestones} Milestones`, ref: { kind: 'milestones' } },
    { label: `${KIND_ICON.risks} Risks`, ref: { kind: 'risks' } },
  ])
})

test('buildModuleItems places the general-notes entry immediately after daily, before any per-person entries', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')
  expect(items[0]!.ref.kind).toBe('daily')
  expect(items[1]!.ref).toEqual({ kind: 'general' })
})

test('buildModuleItems prefixes every entry with its module icon (daily, person, and each whole-board entry)', () => {
  const team: Team = {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  const items = buildModuleItems(team, 'en-US')

  expect(items[0]!.label.startsWith(KIND_ICON.daily)).toBe(true)
  expect(items).toContainEqual({ label: `${KIND_ICON.person} Carla`, ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } })
})

test('dispose() removes the document click listener that closes the module menu', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  // Open pane 0's module dropdown.
  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  pm.dispose()

  // With the listener removed, an outside click no longer closes the menu.
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()
})

test('before dispose(), an outside click still closes the module menu', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(document.querySelector('.tt-pane-menu')).toBeNull()
})

test('renderAll skips the hidden pane, and re-renders it when split turns on', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  // Ensure single-pane view.
  if (store.doc.nav.split) pm.toggleSplit()
  expect(store.doc.nav.split).toBe(false)

  const body1 = document.querySelectorAll('.tt-pane-body')[1] as HTMLElement
  const marker = document.createElement('span')
  marker.id = 'hidden-pane-marker'
  body1.appendChild(marker)

  pm.renderAll()
  // Pane 1 is hidden — its body must not have been wiped.
  expect(document.getElementById('hidden-pane-marker')).not.toBeNull()

  pm.toggleSplit()
  // Now visible — it gets a real render, which clears the marker.
  expect(store.doc.nav.split).toBe(true)
  expect(document.getElementById('hidden-pane-marker')).toBeNull()
})

test('un-hiding a space-constrained split re-renders pane 1', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  if (!store.doc.nav.split) pm.toggleSplit()
  expect(store.doc.nav.split).toBe(true)

  pm.setSplitSpaceConstrained(true) // narrow window — split force-hidden
  const body1 = document.querySelectorAll('.tt-pane-body')[1] as HTMLElement
  const marker = document.createElement('span')
  marker.id = 'constrained-marker'
  body1.appendChild(marker)

  pm.renderAll() // pane 1 hidden by the space constraint — skipped
  expect(document.getElementById('constrained-marker')).not.toBeNull()

  pm.setSplitSpaceConstrained(false) // window widened — pane 1 visible again
  expect(document.getElementById('constrained-marker')).toBeNull()
})

test('divider drag coalesces mousemoves into one style write per animation frame', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  if (!store.doc.nav.split) pm.toggleSplit()

  const frames: FrameRequestCallback[] = []
  const realRaf = window.requestAnimationFrame
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    frames.push(cb)
    return frames.length
  }) as typeof window.requestAnimationFrame

  try {
    const grid = document.querySelector('.tt-panes-grid') as HTMLElement
    // jsdom has no layout: give the grid a non-zero width so the percentage math runs.
    grid.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 500,
      right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    const divider = document.querySelector('.tt-pane-divider') as HTMLElement
    divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    const before = grid.style.gridTemplateColumns
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }))

    // Three moves, zero frames run yet: the style must not have been touched.
    expect(grid.style.gridTemplateColumns).toBe(before)
    expect(frames.length).toBe(1) // one frame requested, not three

    frames.forEach((cb) => cb(0))
    // The frame applies the LAST position: 600/1000 = 60%.
    expect(grid.style.gridTemplateColumns).toBe('60fr 6px 40fr')

    document.dispatchEvent(new MouseEvent('mouseup'))
  } finally {
    window.requestAnimationFrame = realRaf
  }
})

test('dispose() during an in-flight divider drag tears down its listeners and pending frame', () => {
  const { store, pm } = setup()
  addTeam(store, 't1')
  if (!store.doc.nav.split) pm.toggleSplit()

  const frames: FrameRequestCallback[] = []
  let canceledFrame: number | null = null
  const realRaf = window.requestAnimationFrame
  const realCaf = window.cancelAnimationFrame
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    frames.push(cb)
    return frames.length
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number): void => {
    canceledFrame = id
  }) as typeof window.cancelAnimationFrame

  try {
    const grid = document.querySelector('.tt-panes-grid') as HTMLElement
    grid.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 500,
      right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    const divider = document.querySelector('.tt-pane-divider') as HTMLElement
    divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }))
    // A frame is now pending (not yet run): confirms the drag is genuinely in flight.
    expect(frames.length).toBe(1)

    const before = grid.style.gridTemplateColumns

    pm.dispose()

    // dispose() canceled the pending frame — same id requestAnimationFrame returned.
    expect(canceledFrame).toBe(1)

    // The document-level mousemove/mouseup listeners were removed too: a
    // mousemove fired anywhere on the page after dispose() must be inert,
    // not a leftover write into a torn-down PaneManager's grid element.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }))
    expect(grid.style.gridTemplateColumns).toBe(before)

    // A stray mouseup elsewhere on the page (the scenario the leak protects
    // against) must not throw or resurrect any state.
    expect(() => document.dispatchEvent(new MouseEvent('mouseup'))).not.toThrow()
    expect(grid.style.gridTemplateColumns).toBe(before)
  } finally {
    window.requestAnimationFrame = realRaf
    window.cancelAnimationFrame = realCaf
  }
})
