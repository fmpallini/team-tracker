import { createPaneLayout } from '../src/core/pane-layout'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { Loc } from '../src/core/types'

function loc(teamId: string, kind: 'daily' | 'members' | 'actions'): Loc {
  if (kind === 'daily') return { teamId, ref: { kind: 'daily', date: '2026-08-01' } }
  return { teamId, ref: { kind } }
}

test('applyToggleSplit(true) pulls pane 1 into pane 0 when pane 1 was focused', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true) // was visible → un-split

  expect(store.doc.nav.split).toBe(false)
  expect(store.doc.nav.focusedPane).toBe(0)
  expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('members')
})

test('re-splitting restores the stashed pane 0 content', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true)  // un-split, stash pane 0's daily
  layout.applyToggleSplit(false) // re-split, restore it

  expect(store.doc.nav.split).toBe(true)
  expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('daily')
})

test('a real navigation into pane 0 invalidates the stash', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true)
  layout.noteRealNavigation(0) // user navigated pane 0 while unsplit
  layout.applyToggleSplit(false)

  // Stash was invalidated: pane 0 keeps what it has, not the stale daily.
  expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('members')
})

test('stepHistory returns false when there is nowhere to go', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => { d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 } })
  expect(layout.stepHistory(0, -1)).toBe(false)
})

test('stepHistory walks back and sets the focused pane', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily'), loc('t1', 'members')], index: 1 }
  })
  expect(layout.stepHistory(0, -1)).toBe(true)
  expect(store.doc.nav.panes[0]!.index).toBe(0)
  expect(store.doc.nav.focusedPane).toBe(0)
})

test('jumpToLatest returns false when already at the newest entry', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.panes[0] = { history: [loc('t1', 'daily'), loc('t1', 'members')], index: 1 }
  })
  expect(layout.jumpToLatest(0)).toBe(false)
  expect(store.doc.nav.panes[0]!.index).toBe(1)
})

test('jumpToLatest returns false on a pane with no history at all', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  expect(layout.jumpToLatest(0)).toBe(false)
})

test('jumpToLatest jumps straight to the newest entry in one call and sets the focused pane', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.focusedPane = 1
    d.nav.panes[0] = {
      history: [loc('t1', 'daily'), loc('t1', 'members'), loc('t1', 'actions')],
      index: 0,
    }
  })
  expect(layout.jumpToLatest(0)).toBe(true)
  expect(store.doc.nav.panes[0]!.index).toBe(2)
  expect(store.doc.nav.focusedPane).toBe(0)
})

test('jumpToLatest stops at the newest entry that does not conflict with the other pane', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.panes[0] = {
      history: [loc('t1', 'daily'), loc('t1', 'members'), loc('t1', 'actions')],
      index: 0,
    }
    // Pane 1 is currently showing 'actions' for t1 — the newest entry in
    // pane 0's own history conflicts with it (same kind/team), so the jump
    // must land on 'members' instead of skipping straight to the end.
    d.nav.panes[1] = { history: [loc('t1', 'actions')], index: 0 }
  })
  expect(layout.jumpToLatest(0)).toBe(true)
  expect(store.doc.nav.panes[0]!.index).toBe(1)
})

test('jumpToLatest on pane 0 invalidates the unsplit stash, same as stepHistory', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const layout = createPaneLayout(store)
  store.updateNav((d) => {
    d.nav.split = true
    d.nav.focusedPane = 1
    d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
    // Pulled into pane 0 on un-split, not yet at its own newest entry —
    // gives jumpToLatest(0) somewhere real to jump to afterward.
    d.nav.panes[1] = { history: [loc('t1', 'actions'), loc('t1', 'members')], index: 0 }
  })

  layout.applyToggleSplit(true) // un-split, stash pane 0's 'daily', pull in pane 1's 'actions'
  expect(layout.jumpToLatest(0)).toBe(true) // real navigation into pane 0 while unsplit
  layout.applyToggleSplit(false) // re-split

  // Stash was invalidated: pane 0 keeps what it jumped to, not the stale stash.
  expect(store.doc.nav.panes[0]!.history[store.doc.nav.panes[0]!.index]!.ref.kind).toBe('members')
})
