import { withDisposal } from '../src/modules/lifecycle'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { renderDailyNotes } from '../src/modules/daily-notes'
import { renderGeneralNotes } from '../src/modules/general-notes'
import { renderPeopleTree } from '../src/modules/people-tree'
import { renderPersonNotes } from '../src/modules/person-notes'
import { renderActionItems } from '../src/modules/action-items'
import { renderMilestones } from '../src/modules/milestones'
import { renderRisks } from '../src/modules/risks'
import type { Loc, Team } from '../src/core/types'
import type { ModuleCtx, ModuleRenderer, PaneManager } from '../src/ui/panes'

const LOC: Loc = { teamId: 't1', ref: { kind: 'general' } }
const CTX = {} as ModuleCtx

test('re-rendering into the same container disposes the previous instance first', () => {
  const events: string[] = []
  const render = withDisposal((container) => {
    events.push(`mount:${container.id}`)
    return () => events.push(`dispose:${container.id}`)
  })

  const a = document.createElement('div')
  a.id = 'a'
  render(a, LOC, CTX)
  render(a, LOC, CTX)

  expect(events).toEqual(['mount:a', 'dispose:a', 'mount:a'])
})

test('separate containers keep independent lifecycles', () => {
  const events: string[] = []
  const render = withDisposal((container) => {
    events.push(`mount:${container.id}`)
    return () => events.push(`dispose:${container.id}`)
  })

  const a = document.createElement('div')
  a.id = 'a'
  const b = document.createElement('div')
  b.id = 'b'
  render(a, LOC, CTX)
  render(b, LOC, CTX)

  expect(events).toEqual(['mount:a', 'mount:b'])
})

test('a render returning nothing is supported and clears any prior teardown', () => {
  const events: string[] = []
  let returnTeardown = true
  const render = withDisposal((_container) => {
    events.push('mount')
    if (!returnTeardown) return
    return () => events.push('dispose')
  })

  const a = document.createElement('div')
  render(a, LOC, CTX)   // mounts with a teardown
  returnTeardown = false
  render(a, LOC, CTX)   // disposes the first, mounts with none
  render(a, LOC, CTX)   // nothing to dispose

  expect(events).toEqual(['mount', 'dispose', 'mount', 'mount'])
})

test('a throwing teardown does not prevent the new mount, and is surfaced', () => {
  const events: string[] = []
  let first = true
  const render = withDisposal(() => {
    events.push('mount')
    if (first) {
      first = false
      return () => { throw new Error('boom') }
    }
    return () => events.push('dispose')
  })
  // Swallowing is deliberate (one broken module must not block the next
  // mount), but silently is not — pinned so a future edit can't quietly turn
  // the catch into an empty block.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

  const a = document.createElement('div')
  render(a, LOC, CTX)
  render(a, LOC, CTX)

  expect(events).toEqual(['mount', 'mount'])
  expect(spy).toHaveBeenCalledTimes(1)
  expect((spy.mock.calls[0]![0] as Error).message).toBe('boom')
  spy.mockRestore()
})

// ---------------------------------------------------------------------------
// Real-renderer leak detection.
//
// The per-module "double render unsubscribes the previous store listener"
// tests are, on their own, unable to detect a *dropped* `unsubscribe()`: a
// leaked listener from a disposed instance re-renders into its own detached
// DOM, so it neither throws nor changes the live container's node counts.
// Deleting the `unsubscribe()` line from any module teardown used to leave the
// whole suite green. Counting net-live subscriptions is what actually catches
// it — a leak is a *store-side* fact, so it has to be observed store-side.
// ---------------------------------------------------------------------------

function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openBothPanes: () => {},
    openInFocused: () => {},
    openInSecondaryPane: () => 0,
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
    dispose: () => {},
  }
}

function makeTeam(): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' }],
    actionItems: [{ id: 'a-1', summary: 'Ship it', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'slate', order: 0 }],
    milestones: [{ id: 'm-1', date: '2026-07-10', title: 'Launch', done: false, followup: '' }],
    risks: [{ id: 'r-1', title: 'Scope creep', chance: 2, impact: 2, plan: 'mitigate', followup: '', order: 0, closed: false }],
    dailyNotes: {},
  }
}

/**
 * A real store whose `subscribe()` is instrumented to track how many listeners
 * are currently attached (added minus removed), so a teardown that forgets to
 * call its `unsubscribe()` is directly observable.
 */
function countingStore(): { store: Store; liveSubscriptions: () => number } {
  const doc = createEmptyDocument('en-US')
  const team = makeTeam()
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const original = store.subscribe.bind(store)
  let live = 0
  store.subscribe = (fn) => {
    live++
    const unsubscribe = original(fn)
    let released = false
    return () => {
      if (!released) { released = true; live-- }
      unsubscribe()
    }
  }
  return { store, liveSubscriptions: () => live }
}

const RENDERERS: { name: string; render: ModuleRenderer; ref: Loc['ref']; subscribes: boolean }[] = [
  { name: 'daily-notes', render: renderDailyNotes, ref: { kind: 'daily', date: '2026-07-10' }, subscribes: true },
  // general-notes is the one module that never subscribes (plan Task 7 scoped
  // only the other six) — pinned here so a future subscription added there
  // without a matching unsubscribe fails this test instead of leaking.
  { name: 'general-notes', render: renderGeneralNotes, ref: { kind: 'general' }, subscribes: false },
  { name: 'people-tree(stakeholders)', render: renderPeopleTree('stakeholders'), ref: { kind: 'stakeholders' }, subscribes: true },
  { name: 'people-tree(members)', render: renderPeopleTree('members'), ref: { kind: 'members' }, subscribes: true },
  { name: 'person-notes', render: renderPersonNotes, ref: { kind: 'person', personId: 'mem-1', group: 'members' }, subscribes: true },
  { name: 'action-items', render: renderActionItems, ref: { kind: 'actions' }, subscribes: true },
  { name: 'milestones', render: renderMilestones, ref: { kind: 'milestones' }, subscribes: true },
  { name: 'risks', render: renderRisks, ref: { kind: 'risks' }, subscribes: true },
]

for (const { name, render, ref, subscribes } of RENDERERS) {
  test(`${name}: re-rendering into the same container leaves exactly one live store subscription`, () => {
    const { store, liveSubscriptions } = countingStore()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const loc: Loc = { teamId: 'T1', ref }
    const ctx: ModuleCtx = { store, pm: fakePM(), paneIdx: 0, locale: 'en-US' }

    // Three mounts, mirroring panes.ts's renderBody (which clears the
    // container's children before re-invoking the renderer).
    for (let i = 0; i < 3; i++) {
      container.innerHTML = ''
      render(container, loc, ctx)
    }

    expect(liveSubscriptions()).toBe(subscribes ? 1 : 0)
    container.remove()
  })
}

test('switching modules within one container disposes the outgoing module, not just same-module re-renders', () => {
  // ui/panes.ts reuses the same body element across module switches, so the
  // shared `teardowns` WeakMap disposes the *previous module's* instance too —
  // not only a re-render of the same one. Before the seven per-module maps
  // were collapsed into one, each module could only see its own entry, so a
  // daily-notes -> risks switch left daily-notes' subscription live.
  const { store, liveSubscriptions } = countingStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const ctx: ModuleCtx = { store, pm: fakePM(), paneIdx: 0, locale: 'en-US' }

  container.innerHTML = ''
  renderDailyNotes(container, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-10' } }, ctx)
  container.innerHTML = ''
  renderRisks(container, { teamId: 'T1', ref: { kind: 'risks' } }, ctx)

  expect(liveSubscriptions()).toBe(1)
  container.remove()
})
