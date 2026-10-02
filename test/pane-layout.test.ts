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
    d.nav.activeTeamId = 't1'
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
    d.nav.activeTeamId = 't1'
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
    d.nav.activeTeamId = 't1'
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
    d.nav.activeTeamId = 't1'
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

describe('jumpToIndex', () => {
  function setup(): { store: ReturnType<typeof createStore>; layout: ReturnType<typeof createPaneLayout> } {
    const store = createStore(createEmptyDocument('en-US'))
    const layout = createPaneLayout(store)
    store.updateNav((d) => {
      d.nav.activeTeamId = 't1'
      d.nav.split = true
      d.nav.focusedPane = 1
      d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
      d.nav.panes[1] = { history: [loc('t1', 'members'), loc('t1', 'actions'), loc('t1', 'members')], index: 2 }
    })
    return { store, layout }
  }

  test('moves the pane to the entry and focuses it', () => {
    const { store, layout } = setup()
    store.updateNav((d) => { d.nav.focusedPane = 0 })
    expect(layout.jumpToIndex(1, 1)).toBe(true)
    expect(store.doc.nav.panes[1]!.index).toBe(1)
    expect(store.doc.nav.focusedPane).toBe(1)
  })

  test('refuses the current, an out-of-range, or a negative index', () => {
    const { store, layout } = setup()
    expect(layout.jumpToIndex(1, 2)).toBe(false)
    expect(layout.jumpToIndex(1, 3)).toBe(false)
    expect(layout.jumpToIndex(1, -1)).toBe(false)
    expect(store.doc.nav.panes[1]!.index).toBe(2)
  })

  test('refuses an entry that conflicts with the other pane', () => {
    const { store, layout } = setup()
    store.updateNav((d) => { d.nav.panes[0] = { history: [loc('t1', 'actions')], index: 0 } })
    expect(layout.jumpToIndex(1, 1)).toBe(false)
    expect(store.doc.nav.panes[1]!.index).toBe(2)
  })

  test("refuses another team's entry, the spot the pane is already on, and any jump with no active team", () => {
    const { store, layout } = setup()
    store.updateNav((d) => { d.nav.panes[1] = { history: [loc('t2', 'actions'), loc('t1', 'members'), loc('t1', 'actions'), loc('t1', 'members')], index: 3 } })
    expect(layout.jumpToIndex(1, 0)).toBe(false) // other team
    expect(layout.jumpToIndex(1, 1)).toBe(false) // same spot as current (members)
    expect(layout.jumpToIndex(1, 2)).toBe(true)
    store.updateNav((d) => { d.nav.activeTeamId = null })
    expect(layout.jumpToIndex(1, 3)).toBe(false)
  })
})

describe('stepHistory / jumpToLatest are team scoped', () => {
  function setup(): { store: ReturnType<typeof createStore>; layout: ReturnType<typeof createPaneLayout> } {
    const store = createStore(createEmptyDocument('en-US'))
    const layout = createPaneLayout(store)
    store.updateNav((d) => {
      d.nav.activeTeamId = 't1'
      d.nav.panes[0] = { history: [loc('t1', 'daily'), loc('t2', 'actions'), loc('t1', 'members'), loc('t2', 'members')], index: 2 }
    })
    return { store, layout }
  }

  test("stepHistory never lands on another team's entry", () => {
    const { store, layout } = setup()
    expect(layout.stepHistory(0, 1)).toBe(false) // only t2 ahead
    expect(layout.stepHistory(0, -1)).toBe(true)
    expect(store.doc.nav.panes[0]!.index).toBe(0)
    expect(layout.stepHistory(0, -1)).toBe(false)
  })

  test("jumpToLatest ignores other teams' newer entries", () => {
    const { store, layout } = setup()
    layout.stepHistory(0, -1)
    expect(layout.jumpToLatest(0)).toBe(true)
    expect(store.doc.nav.panes[0]!.index).toBe(2)
  })

  test('with no active team nothing steps or jumps', () => {
    const { store, layout } = setup()
    store.updateNav((d) => { d.nav.activeTeamId = null })
    expect(layout.stepHistory(0, -1)).toBe(false)
    expect(layout.jumpToLatest(0)).toBe(false)
  })
})

describe('setSpaceHidden — the window-narrow hide of pane 1 (transient, nav.split untouched)', () => {
  function splitStore(focusedPane: 0 | 1) {
    const store = createStore(createEmptyDocument('en-US'))
    const layout = createPaneLayout(store)
    store.updateNav((d) => {
      d.nav.split = true
      d.nav.focusedPane = focusedPane
      d.nav.panes[0] = { history: [loc('t1', 'daily')], index: 0 }
      d.nav.panes[1] = { history: [loc('t1', 'members')], index: 0 }
    })
    return { store, layout }
  }

  test('splitVisible is the persisted split AND not space-hidden', () => {
    const { store, layout } = splitStore(0)
    expect(layout.splitVisible()).toBe(true)
    layout.setSpaceHidden(true)
    expect(layout.splitVisible()).toBe(false)
    expect(store.doc.nav.split).toBe(true) // the preference is never touched
    layout.setSpaceHidden(false)
    expect(layout.splitVisible()).toBe(true)
    store.updateNav((d) => { d.nav.split = false })
    expect(layout.splitVisible()).toBe(false)
  })

  test('narrowing while pane 1 is focused pulls pane 1 into the visible pane 0 and moves focus there; reports a nav change', () => {
    const { store, layout } = splitStore(1)

    const changed = layout.setSpaceHidden(true)

    expect(changed).toBe(true)
    expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('members')
    expect(store.doc.nav.focusedPane).toBe(0)
  })

  test('narrowing while pane 0 is focused changes nothing', () => {
    const { store, layout } = splitStore(0)
    const before = structuredClone(store.doc.nav)

    expect(layout.setSpaceHidden(true)).toBe(false)

    expect(store.doc.nav).toEqual(before)
  })

  test('widening restores pane 0\'s own content and puts focus back on pane 1 when nothing was navigated meanwhile', () => {
    const { store, layout } = splitStore(1)
    layout.setSpaceHidden(true)

    const changed = layout.setSpaceHidden(false)

    expect(changed).toBe(true)
    expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('daily')
    expect(store.doc.nav.panes[1]!.history[0]!.ref.kind).toBe('members')
    expect(store.doc.nav.focusedPane).toBe(1)
  })

  test('a real navigation into pane 0 while narrow cancels the restore: widening keeps what the user opened and leaves focus alone', () => {
    const { store, layout } = splitStore(1)
    layout.setSpaceHidden(true)
    store.updateNav((d) => { d.nav.panes[0] = { history: [loc('t1', 'actions')], index: 0 } })
    layout.noteRealNavigation(0)

    const changed = layout.setSpaceHidden(false)

    expect(changed).toBe(false)
    expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('actions')
    expect(store.doc.nav.focusedPane).toBe(0)
  })

  test('no restore if the user un-split by hand while narrow (their choice wins)', () => {
    const { store, layout } = splitStore(1)
    layout.setSpaceHidden(true)
    store.updateNav((d) => { d.nav.split = false })

    expect(layout.setSpaceHidden(false)).toBe(false)
    expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('members')
  })

  test('applyToggleSplit(false) — the "show it anyway" click while narrow — restores the stash and clears the hide', () => {
    const { store, layout } = splitStore(1)
    layout.setSpaceHidden(true)

    layout.applyToggleSplit(false)

    expect(layout.splitVisible()).toBe(true)
    expect(store.doc.nav.panes[0]!.history[0]!.ref.kind).toBe('daily')
    // The later real "widen" event is now a no-op rather than a second restore.
    expect(layout.setSpaceHidden(false)).toBe(false)
  })

  test('setting the same value twice is a no-op', () => {
    const { layout } = splitStore(1)
    expect(layout.setSpaceHidden(true)).toBe(true)
    expect(layout.setSpaceHidden(true)).toBe(false)
  })
})
