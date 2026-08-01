import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createShell, type Shell } from '../src/ui/shell'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { mountSidebar } from '../src/ui/sidebar'
import { renderActionItems } from '../src/modules/action-items'
import { renderDailyNotes } from '../src/modules/daily-notes'
import { todayIso } from '../src/core/i18n'
import type { Team } from '../src/core/types'

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

function emptyTeam(id: string, name: string): Team {
  return {
    id, name, emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
  }
}

function setup(): { store: Store; shell: Shell; pm: PaneManager } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const store = createStore(createEmptyDocument('en-US'))
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('actions', renderActionItems)
  pm.registerModule('daily', renderDailyNotes)
  return { store, shell, pm }
}

test('CHARACTERIZATION: store.update() notifies subscribers exactly once', () => {
  const store = createStore(createEmptyDocument('en-US'))
  let n = 0
  store.subscribe(() => n++)
  store.update((d) => { d.teams.push(emptyTeam('t1', 'Alpha')) })
  expect(n).toBe(1)
})

test('CHARACTERIZATION: store.updateNav() does not notify subscribe(), does notify onMutate()', () => {
  const store = createStore(createEmptyDocument('en-US'))
  let subs = 0
  let muts = 0
  store.subscribe(() => subs++)
  store.onMutate(() => muts++)
  store.updateNav((d) => { d.nav.split = true })
  expect(subs).toBe(0)
  expect(muts).toBe(1)
})

test('CHARACTERIZATION: sidebar rebuilds its team list on a content update', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => { d.teams.push(emptyTeam('t1', 'Alpha')) })
  const listEl = shell.sidebar.querySelector('.tt-team-list')
  expect(listEl).not.toBeNull()
  expect(listEl!.querySelectorAll('.tt-team-item').length).toBe(1)

  // Marker survives only if the list is NOT rebuilt. It is rebuilt, so it dies.
  const marker = document.createElement('span')
  marker.id = 'sidebar-marker'
  listEl!.appendChild(marker)
  store.update((d) => { d.teams.push(emptyTeam('t2', 'Beta')) })
  expect(document.getElementById('sidebar-marker')).toBeNull()
  expect(listEl!.querySelectorAll('.tt-team-item').length).toBe(2)
})

test('CHARACTERIZATION: a nav-only change still repaints the sidebar active highlight', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.teams.push(emptyTeam('t2', 'Beta'))
  })
  store.updateNav((d) => { d.nav.activeTeamId = 't2' })
  const active = shell.sidebar.querySelectorAll('.tt-team-item.active')
  expect(active.length).toBe(1)
  expect(active[0]!.textContent).toContain('Beta')
})

test('CHARACTERIZATION: editing one team patches its own pane in place and leaves the other pane\'s DOM untouched', () => {
  const { store, pm } = setup()
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.nav.activeTeamId = 't1'
  })
  // Pane 1 must be actually visible (split) for this test to mean anything —
  // renderAll() now skips rendering a hidden pane 1 entirely (see panes.ts),
  // so without this the kanban below would never be there to check.
  store.updateNav((d) => { d.nav.split = true })
  pm.openBothPanes(
    { teamId: 't1', ref: { kind: 'daily', date: todayIso() } },
    { teamId: 't1', ref: { kind: 'actions' } },
    0
  )
  const bodies = document.querySelectorAll('.tt-pane-body')
  expect(bodies.length).toBe(2)
  const kanbanBefore = bodies[1]!.querySelector('.tt-kanban')
  expect(kanbanBefore).not.toBeNull()

  // Marker in the OTHER pane (pane 0, daily notes) — same technique as the
  // sidebar test above. It survives only if pane 0's container is never
  // torn down (bodies[0] IS the `container` renderDailyNotes was given;
  // panes.ts's renderBody() does `container.innerHTML = ''` on a full
  // re-render, which would take the marker with it).
  const marker = document.createElement('span')
  marker.id = 'pane0-marker'
  bodies[0]!.appendChild(marker)

  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 't1')!
    tm.actionItems.push({
      id: 'a1', summary: 'Card', notes: '', status: 'todo',
      dueDate: null, assignee: '', color: 'ledger', order: 0,
    })
  })

  // Pane 0 was not torn down by this content update: the marker survives.
  expect(document.getElementById('pane0-marker')).not.toBeNull()
  expect(marker.isConnected).toBe(true)

  // Pane 1 was patched in place (action-items.ts's own store.subscribe
  // re-renders only its column bodies), not torn down and rebuilt via
  // panes.ts's renderBody() — the `.tt-kanban` root captured before the
  // update is still the *same* DOM node afterward, not merely an element
  // matching the same selector. A full teardown-and-rebuild would still
  // pass a plain "1 card" count assertion, so identity is load-bearing here.
  expect(bodies[1]!.querySelector('.tt-kanban')).toBe(kanbanBefore)
  expect(bodies[1]!.querySelectorAll('.tt-kanban-card').length).toBe(1)
})

test('sidebar renders exactly once per content update', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => { d.teams.push(emptyTeam('t1', 'Alpha')) })

  const listEl = shell.sidebar.querySelector('.tt-team-list')!

  // Count childList RECORDS that removed nodes, not observer callback
  // invocations: MutationObserver batches every mutation in a microtask into a
  // single callback, so counting callbacks would report 1 whether the sidebar
  // rendered once or twice — a test that passes vacuously. Each render() opens
  // with `listEl.innerHTML = ''`, so one clearing record == one render.
  let clears = 0
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    }
  })
  observer.observe(listEl, { childList: true })

  store.update((d) => { d.teams.push(emptyTeam('t2', 'Beta')) })
  // MutationObserver delivers asynchronously; flush the microtask queue.
  return Promise.resolve().then(() => {
    observer.takeRecords().forEach((r) => {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    })
    observer.disconnect()
    expect(clears).toBe(1)
    expect(listEl.querySelectorAll('.tt-team-item').length).toBe(2)
  })
})

test('the sidebar still renders exactly once for a nav-only change', () => {
  const { store, shell, pm } = setup()
  mountSidebar(shell, store, pm, { selectTeam: () => {}, renderPanes: () => {} })
  store.update((d) => {
    d.teams.push(emptyTeam('t1', 'Alpha'))
    d.teams.push(emptyTeam('t2', 'Beta'))
  })

  const listEl = shell.sidebar.querySelector('.tt-team-list')!
  let clears = 0
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    }
  })
  observer.observe(listEl, { childList: true })

  store.updateNav((d) => { d.nav.activeTeamId = 't2' })
  return Promise.resolve().then(() => {
    observer.takeRecords().forEach((r) => {
      if (r.type === 'childList' && r.removedNodes.length > 0) clears++
    })
    observer.disconnect()
    expect(clears).toBe(1)
    expect(listEl.querySelectorAll('.tt-team-item.active')[0]!.textContent).toContain('Beta')
  })
})
