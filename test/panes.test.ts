import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createPaneManager, installMouseHistoryButtons, navigateFocusedHistory, jumpFocusedHistoryToLatest, setFocusedPane, swapPaneSides, openPaneModuleByIndex, invalidateUnsplitStash, teamHasHistory, openTeamDefaultLayout, restoreTeamLayout, type PaneManager } from '../src/ui/panes'
import { todayIso, t } from '../src/core/i18n'
import { currentLoc } from '../src/core/nav'
import { renderDailyNotes } from '../src/modules/daily-notes'
import { KIND_ICON } from '../src/core/search'
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

describe('narrow window (split force-hidden by setSplitSpaceConstrained): the hidden pane 1 must not trap navigation', () => {
  // Same bug class as the manual-unsplit tests above, reached through the
  // transient width-forced hide instead: nav.split stays true there, but pane 1
  // is just as invisible, so the same-module-in-both-panes guard must not run.
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  function splitWithBOnRight(): { store: Store; pm: PaneManager } {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.toggleSplit()
    pm.openInPane(0, locA)
    pm.openInPane(1, locB)
    return { store, pm }
  }

  test('opening in pane 0 the module the hidden pane 1 holds shows it in pane 0, with no "already open" toast and no focus hand-off', () => {
    const { store, pm } = splitWithBOnRight()
    pm.setSplitSpaceConstrained(true)
    expect(store.doc.nav.split).toBe(true) // persisted flag untouched — the trap

    pm.openInPane(0, locB)

    expect(document.querySelector('.tt-toast')).toBeNull()
    expect(store.doc.nav.focusedPane).toBe(0)
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
  })

  test('pane 1 steps back so widening the window does not reveal the same module twice', () => {
    const { store, pm } = splitWithBOnRight()
    pm.setSplitSpaceConstrained(true)

    pm.openInPane(0, locB)
    pm.setSplitSpaceConstrained(false) // window widens: both panes visible again

    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
    expect(currentLoc(store.doc.nav.panes[1])).not.toEqual(locB)
  })

  test('while both panes are visible the guard still fires (the fix must not loosen the normal split case)', () => {
    const { store, pm } = splitWithBOnRight()
    pm.setSplitSpaceConstrained(true)
    pm.setSplitSpaceConstrained(false)

    pm.openInPane(0, locB)

    expect(document.querySelector('.tt-toast')).not.toBeNull()
    expect(store.doc.nav.focusedPane).toBe(1)
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locA)
  })
})

describe('narrow window: the pane in use stays in view, and focus never lands on the hidden pane', () => {
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }
  const locC: Loc = { teamId: 'T1', ref: { kind: 'risks' } }
  const kind = (store: Store, i: 0 | 1): string | undefined => currentLoc(store.doc.nav.panes[i])?.ref.kind

  /** Split view, A on the left, B on the right, focus on `focus`. */
  function splitAB(focus: 0 | 1): { store: Store; pm: PaneManager } {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.toggleSplit()
    pm.openInPane(0, locA)
    pm.openInPane(1, locB)
    if (focus === 0) setFocusedPane(store, 0)
    return { store, pm }
  }

  test('narrowing while working in pane 2 brings that module into the visible pane and focuses it', () => {
    const { store, pm } = splitAB(1)
    // Distinguishable renderers, so the test can see what each body really shows.
    for (const k of ['actions', 'milestones'] as const) {
      pm.registerModule(k, (container) => { container.textContent = `module:${k}` })
    }
    pm.renderAll()
    const body0 = document.querySelectorAll('.tt-pane-body')[0] as HTMLElement
    expect(body0.textContent).toBe('module:actions')

    pm.setSplitSpaceConstrained(true)

    expect(store.doc.nav.split).toBe(true)
    expect(store.doc.nav.focusedPane).toBe(0)
    expect(kind(store, 0)).toBe('milestones')
    expect(body0.textContent).toBe('module:milestones') // really re-rendered, not just nav state
  })

  test('widening again puts both panes back as they were, with focus back on pane 2', () => {
    const { store, pm } = splitAB(1)
    pm.setSplitSpaceConstrained(true)

    pm.setSplitSpaceConstrained(false)

    expect(kind(store, 0)).toBe('actions')
    expect(kind(store, 1)).toBe('milestones')
    expect(store.doc.nav.focusedPane).toBe(1)
  })

  test('narrowing while working in pane 1 changes nothing', () => {
    const { store, pm } = splitAB(0)
    const before = structuredClone(store.doc.nav)

    pm.setSplitSpaceConstrained(true)

    expect(store.doc.nav).toEqual(before)
  })

  test('after narrowing, a palette-style open into the focused pane lands in the visible pane', () => {
    const { store, pm } = splitAB(1)
    pm.setSplitSpaceConstrained(true)

    pm.openInFocused(locC)

    expect(kind(store, 0)).toBe('risks')
    expect(store.doc.nav.focusedPane).toBe(0)
  })

  test('navigating while narrow wins over the restore: widening keeps what was opened', () => {
    const { store, pm } = splitAB(1)
    pm.setSplitSpaceConstrained(true)
    pm.openInFocused(locC)

    pm.setSplitSpaceConstrained(false)

    expect(kind(store, 0)).toBe('risks')
    expect(kind(store, 1)).toBe('milestones')
  })

  test('Alt+Right (setFocusedPane to pane 2) is refused while pane 2 is hidden', () => {
    const { store, pm } = splitAB(0)
    pm.setSplitSpaceConstrained(true)

    expect(setFocusedPane(store, 1)).toBe(false)
    expect(store.doc.nav.focusedPane).toBe(0)
  })

  test('Alt+Right is refused in a manually un-split view too, and works again once split', () => {
    const { store, pm } = splitAB(0)
    pm.toggleSplit() // unsplit by hand
    expect(setFocusedPane(store, 1)).toBe(false)
    expect(store.doc.nav.focusedPane).toBe(0)

    pm.toggleSplit()
    expect(setFocusedPane(store, 1)).toBe(true)
  })

  test('Alt+Down (swap) is refused while pane 2 is hidden, leaving contents and focus alone', () => {
    const { store, pm } = splitAB(0)
    pm.setSplitSpaceConstrained(true)

    expect(swapPaneSides(store)).toBe(false)

    expect(kind(store, 0)).toBe('actions')
    expect(kind(store, 1)).toBe('milestones')
    expect(store.doc.nav.focusedPane).toBe(0)
  })

  test('switching to a team remembered as split, while narrow, focuses the visible pane', () => {
    const { store, pm } = splitAB(0)
    addTeam(store, 'T2')
    store.updateNav((d) => { d.nav.teamSplit.T2 = true })
    pm.setSplitSpaceConstrained(true)

    restoreTeamLayout(pm, store, 'T2')

    expect(store.doc.nav.activeTeamId).toBe('T2')
    expect(store.doc.nav.focusedPane).toBe(0)
  })

  test('team switch while wide still focuses pane 2 for a team remembered as split (the rule only applies while hidden)', () => {
    const { store, pm } = splitAB(0)
    addTeam(store, 'T2')
    store.updateNav((d) => { d.nav.teamSplit.T2 = true })

    restoreTeamLayout(pm, store, 'T2')

    expect(store.doc.nav.focusedPane).toBe(1)
  })
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
    .find((b) => b.querySelector('.tt-pane-menu-label')?.textContent === `${KIND_ICON.milestones} ${t('en-US', 'module_milestones')}`)
  if (!milestonesItem) throw new Error('milestones menu item not found')
  milestonesItem.click()

  expect(document.querySelector('.tt-toast')).not.toBeNull()
  expect(store.doc.nav.focusedPane).toBe(1)
})

test('pane module dropdown is a flat, icon-prefixed list of the 7 whole-board modules, no Person entry', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pane-idx="0"] .tt-pane-menu-item'))

  expect(items.map((b) => b.querySelector('.tt-pane-menu-label')?.textContent)).toEqual([
    `${KIND_ICON.daily} ${t('en-US', 'module_daily')}`,
    `${KIND_ICON.general} ${t('en-US', 'module_general_notes')}`,
    `${KIND_ICON.stakeholders} ${t('en-US', 'module_stakeholders')}`,
    `${KIND_ICON.members} ${t('en-US', 'module_members')}`,
    `${KIND_ICON.actions} ${t('en-US', 'module_actions')}`,
    `${KIND_ICON.milestones} ${t('en-US', 'module_milestones')}`,
    `${KIND_ICON.risks} ${t('en-US', 'module_risks')}`,
  ])
})

test('pane module dropdown always shows an F1..F7 hotkey hint per row, in order', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  const hints = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-idx="0"] .tt-pane-menu-hotkey'))

  expect(hints.map((h) => h.textContent)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'])
})

test('ArrowDown/ArrowUp move the highlighted pane-menu row, clamped at both ends', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  const selectedLabel = () => document.querySelector('[data-pane-idx="0"] .tt-pane-menu-item.selected .tt-pane-menu-label')?.textContent

  expect(selectedLabel()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.general} ${t('en-US', 'module_general_notes')}`)

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)

  // Clamped at the top: one more ArrowUp does nothing.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)

  // Walk to the bottom (6 more ArrowDowns reaches Risks, the 7th row) and confirm clamping there too.
  for (let i = 0; i < 6; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(selectedLabel()).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
})

test('opening the menu highlights the row matching the pane\'s current module', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  paneBtn(0, 'tt-pane-modules-btn').click()
  const selected = document.querySelector('[data-pane-idx="0"] .tt-pane-menu-item.selected .tt-pane-menu-label')
  expect(selected?.textContent).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
})

test('Enter commits the highlighted pane-menu row and closes the menu', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // -> General notes
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(document.querySelector('.tt-pane-menu')).toBeNull()
  expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('general')
})

test('Enter/Arrow on the pane menu do not act while a modal is open (e.g. an async save-conflict error appearing over it)', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })

  paneBtn(0, 'tt-pane-modules-btn').click()
  document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay' }))

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  expect(document.querySelector('.tt-pane-menu')).not.toBeNull() // still open, untouched
  expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('daily') // never navigated
})

test('Escape closes the pane menu without picking anything', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'actions' } })

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  expect(document.querySelector('.tt-pane-menu')).toBeNull()
  expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('actions')
})

test('dispose() while a pane menu is open closes it and drops its document keydown listener', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

  pm.dispose()

  expect(document.querySelector('.tt-pane-menu')).toBeNull()
  // The keydown listener is capture-phase on document; if it survived, this
  // would throw trying to paintSelection into the now-detached menu list.
  expect(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
  )).not.toThrow()
})

test('opening one pane\'s module menu closes the other pane\'s if it was open', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.toggleSplit() // split on
  pm.renderAll()

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelectorAll('.tt-pane-menu').length).toBe(1)

  paneBtn(1, 'tt-pane-modules-btn').click()
  expect(document.querySelectorAll('.tt-pane-menu').length).toBe(1)
  expect(document.querySelector('[data-pane-idx="0"] .tt-pane-menu')).toBeNull()
  expect(document.querySelector('[data-pane-idx="1"] .tt-pane-menu')).not.toBeNull()
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

test('jumpFocusedHistoryToLatest jumps the currently focused pane straight to its newest entry and re-renders', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.openInPane(0, locA)
  pm.openInPane(0, locB) // history [locA, locB], index 1, focused 0
  navigateFocusedHistory(pm, store, -1) // back to locA, index 0
  expect(store.doc.nav.panes[0].index).toBe(0)

  jumpFocusedHistoryToLatest(pm, store)
  expect(store.doc.nav.panes[0]).toEqual({ history: [locA, locB], index: 1 })
  expect(paneBtn(0, 'tt-pane-fwd-btn').disabled).toBe(true)

  // Already at the newest entry: a further jump is a no-op.
  jumpFocusedHistoryToLatest(pm, store)
  expect(store.doc.nav.panes[0].index).toBe(1)
})

test('setFocusedPane focuses the given pane index and reports whether focus actually changed', () => {
  const { store } = setup()
  store.updateNav((d) => { d.nav.split = true }) // pane 1 can only take focus while it is visible
  expect(store.doc.nav.focusedPane).toBe(0)

  expect(setFocusedPane(store, 0)).toBe(false) // already focused pane 0
  expect(setFocusedPane(store, 1)).toBe(true)
  expect(store.doc.nav.focusedPane).toBe(1)
  expect(setFocusedPane(store, 1)).toBe(false) // already focused pane 1
})

test('swapPaneSides swaps the two panes\' contents and moves focus with the content that was focused, but only while split', () => {
  const { store } = setup()
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }
  store.updateNav((d) => {
    d.nav.panes[0] = { history: [locA], index: 0 }
    d.nav.panes[1] = { history: [locB], index: 0 }
    d.nav.focusedPane = 0
  })

  // Unsplit: swapping sides makes no sense with only one side visible.
  expect(swapPaneSides(store)).toBe(false)
  expect(store.doc.nav.panes[0]).toEqual({ history: [locA], index: 0 })

  store.updateNav((d) => { d.nav.split = true })
  expect(swapPaneSides(store)).toBe(true)
  expect(store.doc.nav.panes[0]).toEqual({ history: [locB], index: 0 })
  expect(store.doc.nav.panes[1]).toEqual({ history: [locA], index: 0 })
  expect(store.doc.nav.focusedPane).toBe(1) // focus follows locA, now on the right

  swapPaneSides(store) // swap back
  expect(store.doc.nav.panes[0]).toEqual({ history: [locA], index: 0 })
  expect(store.doc.nav.panes[1]).toEqual({ history: [locB], index: 0 })
  expect(store.doc.nav.focusedPane).toBe(0)
})

test('swapPaneSides invalidates the unsplit stash, so a later re-split does not resurrect it', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }

  pm.toggleSplit() // split on
  pm.openInPane(0, locA)
  pm.openInPane(1, locB) // focuses pane 1

  pm.toggleSplit() // unsplit: pane 0 pulls in pane 1's (locB) content, stashes locA
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)

  store.updateNav((d) => { d.nav.split = true }) // swapPaneSides itself requires split
  swapPaneSides(store) // real navigation into pane 0 while its stash is still pending
  store.updateNav((d) => { d.nav.split = false })

  pm.toggleSplit() // back to split — stash was invalidated, so pane 0 keeps locB, not the resurrected locA
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
})

test('openPaneModuleByIndex opens the row at that position (paneMenuItems order) in the focused pane', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.toggleSplit() // split on
  store.updateNav((d) => { d.nav.focusedPane = 1 })

  openPaneModuleByIndex(pm, store, 5) // 0=daily,1=general,2=stakeholders,3=members,4=actions,5=milestones
  expect(currentLoc(store.doc.nav.panes[1])?.ref.kind).toBe('milestones')
  expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).not.toBe('milestones')
})

test('openPaneModuleByIndex is a no-op with no active team or an out-of-range index', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  const before = currentLoc(store.doc.nav.panes[0])

  openPaneModuleByIndex(pm, store, 99)
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(before)

  store.update((d) => { d.nav.activeTeamId = null })
  openPaneModuleByIndex(pm, store, 0)
  expect(currentLoc(store.doc.nav.panes[0])).toEqual(before)
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

test('print button is disabled when the pane is empty and enabled once a module is open', () => {
  const { store, pm } = setup()
  expect(paneBtn(0, 'tt-pane-print-btn').disabled).toBe(true)

  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  expect(paneBtn(0, 'tt-pane-print-btn').disabled).toBe(false)
})

test('module title/modules button are merged into one trigger: shows current module name, no separate title span, tracks disabled/title with team state', () => {
  const { store, pm } = setup()

  // No active team yet: trigger disabled, tooltip explains why, no title span exists separately.
  const before = paneBtn(0, 'tt-pane-modules-btn')
  expect(before.disabled).toBe(true)
  expect(before.title).toBe(t('en-US', 'pane_no_team'))
  expect(document.querySelector('[data-pane-idx="0"] .tt-pane-title')).toBeNull()

  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

  const after = paneBtn(0, 'tt-pane-modules-btn')
  expect(after.disabled).toBe(false)
  expect(after.title).toBe(`${t('en-US', 'pane_modules_title')} (F1–F7)`)
  expect(after.textContent).toContain(t('en-US', 'module_risks'))
  expect(document.querySelector('[data-pane-idx="0"] .tt-pane-title')).toBeNull()
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

test('dispose() removes the document click listener that closes the module menu', () => {
  const { store, pm } = setup()
  addTeam(store, 'T1')
  store.update((d) => { d.nav.activeTeamId = 'T1' })
  pm.renderAll()

  // dispose() itself now proactively closes any open menu (see the
  // dispose()-while-open test below), so this test can no longer observe
  // the click-listener leak by leaving a menu open across dispose() and
  // checking it survives a stray click — it wouldn't even without a leak.
  // Instead: dispose() first (nothing open yet), then re-open the menu via
  // the still-attached button (dispose() only tears down document-level
  // listeners and module instances, not the pane bar itself) and confirm a
  // stray outside click no longer closes it — proving onDocumentClick
  // specifically was never re-registered/was removed.
  pm.dispose()

  paneBtn(0, 'tt-pane-modules-btn').click()
  expect(document.querySelector('.tt-pane-menu')).not.toBeNull()

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

describe('title bar flash — only on an opt-in openInPane', () => {
  function titleSpan(idx: 0 | 1): HTMLElement {
    const el = document.querySelector(`[data-pane-idx="${idx}"] .tt-pane-title-text`)
    if (!el) throw new Error(`title span not found for pane ${idx}`)
    return el as HTMLElement
  }

  test('flashes when openInPane is called with { flashTitle: true }, then clears', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')

    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    expect(titleSpan(0).classList.contains('tt-pane-title-flash')).toBe(false)

    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-09' } }, { flashTitle: true })
    expect(titleSpan(0).classList.contains('tt-pane-title-flash')).toBe(true)

    pm.renderAll() // one-shot — gone on the next render
    expect(titleSpan(0).classList.contains('tt-pane-title-flash')).toBe(false)
  })

  test('does not flash on a plain date change (calendar pick / Alt+[ ])', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')

    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } })
    expect(titleSpan(0).classList.contains('tt-pane-title-flash')).toBe(false)
  })

  test('the flag is per pane', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    pm.toggleSplit()
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-05' } })

    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-20' } }, { flashTitle: true })
    expect(titleSpan(1).classList.contains('tt-pane-title-flash')).toBe(true)
    expect(titleSpan(0).classList.contains('tt-pane-title-flash')).toBe(false)
  })

  test('a focusOther conflict (split, same loc) does not arm the flash', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    pm.toggleSplit()
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } })

    // Ask pane 1 to open pane 0's exact loc with flashTitle — resolves to
    // focusOther and returns before the real-navigation path that arms it.
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } }, { flashTitle: true })
    expect(titleSpan(0).classList.contains('tt-pane-title-flash')).toBe(false)
    expect(titleSpan(1).classList.contains('tt-pane-title-flash')).toBe(false)
  })
})

describe('pane history: tooltips, list menu, jump-to-latest, mouse buttons', () => {
  const locA: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'T1', ref: { kind: 'milestones' } }
  const locC: Loc = { teamId: 'T1', ref: { kind: 'risks' } }
  const label = (kind: 'actions' | 'milestones' | 'risks'): string =>
    `${KIND_ICON[kind]} ${t('en-US', ({ actions: 'module_actions', milestones: 'module_milestones', risks: 'module_risks' } as const)[kind])}`

  function setupHistory(): { store: Store; pm: PaneManager } {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, locA)
    pm.openInPane(0, locB)
    pm.openInPane(0, locC)
    return { store, pm }
  }

  function menuLabels(): string[] {
    return Array.from(document.querySelectorAll('.tt-context-menu-item')).map((b) => b.textContent ?? '')
  }

  function rightClick(btn: HTMLElement): void {
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }

  afterEach(() => {
    document.querySelector('.tt-context-menu')?.remove()
    vi.useRealTimers()
  })

  test('back/forward tooltips name the destination and the hotkey, and hint at the history list', () => {
    const { store, pm } = setupHistory()
    navigateFocusedHistory(pm, store, -1) // now on B, with A behind and C ahead
    const back = paneBtn(0, 'tt-pane-back-btn').title
    const fwd = paneBtn(0, 'tt-pane-fwd-btn').title
    expect(back).toContain(`Back to ${label('actions')}`)
    expect(back).toContain('(Alt+Shift+←)')
    expect(back).toContain(t('en-US', 'pane_history_hint'))
    expect(fwd).toContain(`Forward to ${label('risks')}`)
    expect(fwd).toContain('(Alt+Shift+→)')
  })

  test('a disabled direction falls back to the plain title', () => {
    setupHistory()
    const fwd = paneBtn(0, 'tt-pane-fwd-btn').title
    expect(fwd).toContain(t('en-US', 'pane_forward_title'))
    expect(fwd).not.toContain('Forward to')
  })

  test('right-click on back opens the history list, newest first, current entry ticked', () => {
    setupHistory()
    rightClick(paneBtn(0, 'tt-pane-back-btn'))
    expect(menuLabels()).toEqual([`✓${label('risks')}`, label('milestones'), label('actions')])
  })

  test('picking an entry jumps the pane straight there without touching the history', () => {
    const { store } = setupHistory()
    rightClick(paneBtn(0, 'tt-pane-back-btn'))
    document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item')[2]!.click()
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locA)
    expect(store.doc.nav.panes[0]!.history).toHaveLength(3)
  })

  test('the history list is not offered when the pane has fewer than two entries', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, locA)
    rightClick(paneBtn(0, 'tt-pane-back-btn'))
    expect(document.querySelector('.tt-context-menu')).toBeNull()
  })

  test('the list only shows entries of the active team', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    addTeam(store, 'T2')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, locA)
    pm.openInPane(0, { teamId: 'T2', ref: { kind: 'actions' } })
    pm.openInPane(0, locB)
    pm.openInPane(0, locC)
    rightClick(paneBtn(0, 'tt-pane-back-btn'))
    expect(menuLabels()).toEqual([`✓${label('risks')}`, label('milestones'), label('actions')])
  })

  test('press-and-hold opens the list and swallows the click that ends the hold', () => {
    vi.useFakeTimers()
    const { store } = setupHistory()
    const btn = paneBtn(0, 'tt-pane-back-btn')
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    vi.advanceTimersByTime(600)
    expect(document.querySelector('.tt-context-menu')).not.toBeNull()
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    btn.click()
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locC) // the click did not step back
    paneBtn(0, 'tt-pane-back-btn').click()
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB) // ...but the next one does
  })

  test('a short press does not open the list', () => {
    vi.useFakeTimers()
    setupHistory()
    const btn = paneBtn(0, 'tt-pane-back-btn')
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    vi.advanceTimersByTime(200)
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    vi.advanceTimersByTime(600)
    expect(document.querySelector('.tt-context-menu')).toBeNull()
  })

  test('the jump-to-latest button only exists while the pane is behind its newest entry, and jumps there', () => {
    const { store, pm } = setupHistory()
    expect(document.querySelector('[data-pane-idx="0"] .tt-pane-latest-btn')).toBeNull()
    navigateFocusedHistory(pm, store, -1)
    navigateFocusedHistory(pm, store, -1)
    paneBtn(0, 'tt-pane-latest-btn').click()
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locC)
    expect(document.querySelector('[data-pane-idx="0"] .tt-pane-latest-btn')).toBeNull()
  })

  test('mouse side buttons step the focused pane back (4) and forward (5), and are consumed', () => {
    const { store, pm } = setupHistory()
    const dispose = installMouseHistoryButtons(pm, store, () => true)
    const up = (button: number): MouseEvent => {
      const e = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button })
      document.dispatchEvent(e)
      return e
    }
    expect(up(3).defaultPrevented).toBe(true)
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locB)
    up(4)
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locC)
    expect(up(0).defaultPrevented).toBe(false)
    dispose()
    up(3)
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locC)
  })

  test('mouse side buttons do nothing when the gate says no', () => {
    const { store, pm } = setupHistory()
    const dispose = installMouseHistoryButtons(pm, store, () => false)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 3 }))
    expect(currentLoc(store.doc.nav.panes[0])).toEqual(locC)
    dispose()
  })
})

describe('pane module menu: current-module check, typeahead, quick-pick', () => {
  function openMenuOn(kind: 'daily' | 'risks' | 'actions'): { store: Store } {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    pm.openInPane(0, kind === 'daily' ? { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } } : { teamId: 'T1', ref: { kind } })
    paneBtn(0, 'tt-pane-modules-btn').click()
    return { store }
  }
  const key = (k: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }
  const selected = (): string | null | undefined => document.querySelector('[data-pane-idx="0"] .tt-pane-menu-item.selected .tt-pane-menu-label')?.textContent

  test('only the current module row carries the ✓ (and aria-current)', () => {
    openMenuOn('risks')
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-idx="0"] .tt-pane-menu-item'))
    expect(rows.map((r) => r.querySelector('.tt-pane-menu-check')?.textContent)).toEqual(['', '', '', '', '', '', '✓'])
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1)
  })

  test('a daily note on any date ticks the Daily row', () => {
    openMenuOn('daily')
    const first = document.querySelector('[data-pane-idx="0"] .tt-pane-menu-item .tt-pane-menu-check')
    expect(first?.textContent).toBe('✓')
  })

  test('the other pane\'s module is not marked', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.nav.activeTeamId = 'T1' })
    store.updateNav((d) => { d.nav.split = true })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'members' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'risks' } })
    paneBtn(0, 'tt-pane-modules-btn').click()
    const ticked = Array.from(document.querySelectorAll('[data-pane-idx="0"] .tt-pane-menu-check')).map((n) => n.textContent)
    expect(ticked).toEqual(['', '', '', '✓', '', '', ''])
  })

  test('Home/End jump to the first/last row', () => {
    openMenuOn('actions')
    key('End')
    expect(selected()).toBe(`${KIND_ICON.risks} ${t('en-US', 'module_risks')}`)
    key('Home')
    expect(selected()).toBe(`${KIND_ICON.daily} ${t('en-US', 'module_daily')}`)
  })

  test('typing a letter jumps to the next row starting with it, cycling on repeats', () => {
    openMenuOn('daily')
    key('m')
    expect(selected()).toBe(`${KIND_ICON.members} ${t('en-US', 'module_members')}`)
    key('m')
    expect(selected()).toBe(`${KIND_ICON.milestones} ${t('en-US', 'module_milestones')}`)
    key('m')
    expect(selected()).toBe(`${KIND_ICON.members} ${t('en-US', 'module_members')}`)
    key('q') // no match: selection stays
    expect(selected()).toBe(`${KIND_ICON.members} ${t('en-US', 'module_members')}`)
  })

  test('1..7 open that row directly and close the menu', () => {
    const { store } = openMenuOn('daily')
    key('7')
    expect(document.querySelector('.tt-pane-menu')).toBeNull()
    expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('risks')
  })

  test('digits beyond the row count and ctrl-modified letters are ignored', () => {
    const { store } = openMenuOn('daily')
    key('8')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }))
    expect(document.querySelector('.tt-pane-menu')).not.toBeNull()
    expect(currentLoc(store.doc.nav.panes[0])?.ref.kind).toBe('daily')
  })
})

describe('title bar follows a rename made from the other pane', () => {
  function titleText(idx: 0 | 1): string {
    return document.querySelector(`[data-pane-idx="${idx}"] .tt-pane-title-text`)!.textContent!
  }

  test('a person pane\'s title updates when that person is renamed while pane 0 shows something else', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => {
      d.teams[0]!.members.push({ id: 'm1', name: 'Ana', role: '', parentId: null, order: 0, notes: '' })
    })
    store.updateNav((d) => { d.nav.split = true })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'members' } })
    pm.openInPane(1, { teamId: 'T1', ref: { kind: 'person', personId: 'm1', group: 'members' } })
    expect(titleText(1)).toBe('Ana')

    // Same scope people-tree.ts's rename uses: team only, no sections.
    store.update((d) => { d.teams[0]!.members[0]!.name = 'Ana Maria' }, { teamId: 'T1' })

    expect(titleText(1)).toBe('Ana Maria')
  })

  test('an unrelated mutation does not rebuild the bars', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'general' } })
    const bar = document.querySelector('[data-pane-idx="0"] .tt-pane-title-text')
    store.update((d) => { d.teams[0]!.name = 'renamed' }, { teamId: 'T1' })
    expect(document.querySelector('[data-pane-idx="0"] .tt-pane-title-text')).toBe(bar)
  })
})

describe('history skips days with no note', () => {
  test('leaving an empty day drops it from history; a day with a note stays', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    store.update((d) => { d.teams[0]!.dailyNotes['2026-07-02'] = 'hello' })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-03' } })
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'risks' } })

    const dates = store.doc.nav.panes[0].history.flatMap((l) => (l.ref.kind === 'daily' ? [l.ref.date] : []))
    expect(dates).toEqual(['2026-07-02'])
    const p = store.doc.nav.panes[0]
    expect(p.history[p.index]!.ref.kind).toBe('risks')
  })

  test('the day being viewed stays even when empty', () => {
    const { store, pm } = setup()
    addTeam(store, 'T1')
    pm.openInPane(0, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-01' } })
    const p = store.doc.nav.panes[0]
    expect(p.history[p.index]!.ref).toEqual({ kind: 'daily', date: '2026-07-01' })
  })
})

describe('pane favorite star', () => {
  function openRisks(store: Store, pm: PaneManager): void {
    addTeam(store, 't1')
    store.update((d) => { d.nav.activeTeamId = 't1' })
    pm.openInPane(0, { teamId: 't1', ref: { kind: 'risks' } })
  }

  test('is disabled on an empty pane', () => {
    const { store } = setup()
    addTeam(store, 't1')
    expect(paneBtn(0, 'tt-pane-fav-btn').disabled).toBe(true)
  })

  test('click stars the pane: ★, aria-pressed, stored in doc.favorites; click again unstars', () => {
    const { store, pm } = setup()
    openRisks(store, pm)
    const btn = (): HTMLButtonElement => paneBtn(0, 'tt-pane-fav-btn')
    expect(btn().querySelector('.tt-icon-star')).not.toBeNull()
    expect(btn().getAttribute('aria-pressed')).toBe('false')

    btn().click()
    expect(store.doc.favorites).toEqual([{ teamId: 't1', ref: { kind: 'risks' } }])
    expect(btn().querySelector('.tt-icon-starFill')).not.toBeNull()
    expect(btn().getAttribute('aria-pressed')).toBe('true')
    expect(store.dirty).toBe(true)

    btn().click()
    expect(store.doc.favorites).toEqual([])
    expect(btn().querySelector('.tt-icon-star')).not.toBeNull()
  })

  test('the star follows the live store: removing the favorite elsewhere repaints it', () => {
    const { store, pm } = setup()
    openRisks(store, pm)
    paneBtn(0, 'tt-pane-fav-btn').click()
    expect(paneBtn(0, 'tt-pane-fav-btn').querySelector('.tt-icon-starFill')).not.toBeNull()

    store.update((d) => { d.favorites = [] })
    expect(paneBtn(0, 'tt-pane-fav-btn').querySelector('.tt-icon-star')).not.toBeNull()
  })

  test("each pane bar reflects its own location: starring pane 1's location leaves pane 0 unlit", () => {
    const { store, pm } = setup()
    addTeam(store, 't1')
    store.update((d) => { d.nav.activeTeamId = 't1' })
    pm.openInPane(0, { teamId: 't1', ref: { kind: 'risks' } })
    pm.toggleSplit()
    pm.openInPane(1, { teamId: 't1', ref: { kind: 'actions' } })
    store.update((d) => { d.favorites.push({ teamId: 't1', ref: { kind: 'actions' } }) })
    expect(paneBtn(1, 'tt-pane-fav-btn').querySelector('.tt-icon-starFill')).not.toBeNull()
    expect(paneBtn(0, 'tt-pane-fav-btn').querySelector('.tt-icon-star')).not.toBeNull()
  })

  test('a favorite of a deleted team does not light any star', () => {
    const { store, pm } = setup()
    openRisks(store, pm)
    store.update((d) => { d.favorites.push({ teamId: 'gone', ref: { kind: 'risks' } }) })
    expect(paneBtn(0, 'tt-pane-fav-btn').querySelector('.tt-icon-star')).not.toBeNull()
  })
})
