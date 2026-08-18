import { renderDailyNotes } from '../src/modules/daily-notes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Team } from '../src/core/types'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
  const calls: { idx: 0 | 1; loc: Loc }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
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

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' }],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team, date = '2026-07-10'): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM>; loc: Loc } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const loc: Loc = { teamId: team.id, ref: { kind: 'daily', date } }
  return { container, store, pm, loc }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex, saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} } }
  renderDailyNotes(container, loc, ctx)
}

function editorEl(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.editor')
  if (!found) throw new Error('.editor not found')
  return found
}

// Directly (re)writes the current block's text and places the caret at its
// end — mirrors test/atref.test.ts's helper.
function setBlockText(editor: HTMLElement, text: string): void {
  editor.innerHTML = `<div>${text}</div>`
  const textNode = editor.firstChild!.firstChild as Text | null
  const range = document.createRange()
  if (textNode) range.setStart(textNode, textNode.textContent!.length)
  else range.setStart(editor.firstChild!, 0)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function fireInput(editor: HTMLElement): void {
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Picks from the current-month grid — the last `.tt-calendar-grid` in DOM order (the previous-month grid, if any, comes first). */
function dayButtonFor(container: HTMLElement, day: number): HTMLButtonElement {
  const grids = container.querySelectorAll<HTMLElement>('.tt-calendar-grid')
  const currentGrid = grids[grids.length - 1]!
  const buttons = Array.from(currentGrid.querySelectorAll<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)'))
  const found = buttons.find((b) => (b.firstChild?.textContent ?? '') === String(day))
  if (!found) throw new Error(`no day button found for day ${day}`)
  return found
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('renderDailyNotes', () => {
  test('renders the existing note for the day', () => {
    const team = makeTeam({ dailyNotes: { '2026-07-10': '## Hello' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelector('.editor h2')?.textContent).toBe('Hello')
  })

  test('renders an empty editor when there is no existing note', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(editorEl(container).querySelector('h1,h2,h3,strong')).toBeNull()
  })

  test('onChange persists the edited markdown into team.dailyNotes[date]', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    setBlockText(editorEl(container), 'New note')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.dailyNotes['2026-07-10']).toBe('New note')
  })

  test('clearing the note (whitespace-only) deletes the dailyNotes key', () => {
    vi.useFakeTimers()
    const team = makeTeam({ dailyNotes: { '2026-07-10': 'existing' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    setBlockText(editorEl(container), '   ')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.dailyNotes['2026-07-10']).toBeUndefined()
    expect('2026-07-10' in store.doc.teams[0]!.dailyNotes).toBe(false)
  })

  test('picking a day on the calendar opens that day in the same pane via pm.openInPane', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm, 1)

    dayButtonFor(container, 22).click()

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-22' } } }])
  })

  test('clicking the Today button opens today\'s date in the same pane via pm.openInPane', () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00'))
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-01')
    render(container, loc, store, pm, 1)

    const todayBtn = container.querySelector<HTMLButtonElement>('.tt-daily-calendar-today-btn')
    if (!todayBtn) throw new Error('.tt-daily-calendar-today-btn not found')
    todayBtn.click()

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-15' } } }])
  })

  test('double render into the same container disposes the previous instance: no duplicate @ dropdowns', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)

    // First mount: open the @ dropdown but never close it (mirrors the real
    // panes.ts flow, which clears the container's DOM without calling any
    // teardown of its own — see src/ui/panes.ts's renderBody).
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))

    // A leaked first-instance overlay (never removed from document.body,
    // since it's not a descendant of `container`) plus the second instance's
    // fresh one would show up as 2 here if renderDailyNotes did not dispose
    // the previous instance before mounting the new one.
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)
  })

  test('double render into the same container disposes the previous instance: no duplicate template pickers', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    setBlockText(editorEl(container), '/')
    fireInput(editorEl(container))
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '/')
    fireInput(editorEl(container))

    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)
  })

  test('clicking a template row in the full daily-notes module inserts it into the note', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    setBlockText(editorEl(container), '/')
    fireInput(editorEl(container))

    const items = document.querySelectorAll('.tt-atref-item')
    expect(items.length).toBe(3) // Meeting, Decision, Weekly status (daily/any scope) out of the 5 builtins
    ;(items[0] as HTMLElement).click()
    vi.advanceTimersByTime(500)

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(team.dailyNotes[loc.ref.kind === 'daily' ? loc.ref.date : '']).toBeTruthy()
  })

  test('clicking a template row on a note that already has content inserts after it', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    team.dailyNotes[loc.ref.kind === 'daily' ? loc.ref.date : ''] = 'existing note text'

    render(container, loc, store, pm)
    const ed = editorEl(container)
    // Append "/" on a NEW line after the existing content (mirrors a user
    // clicking at the end of an existing note and typing "/" to insert a
    // template below it, rather than on a fresh empty note).
    ed.innerHTML += '<div>/</div>'
    const newDiv = ed.lastElementChild as HTMLElement
    const textNode = newDiv.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    fireInput(ed)

    const items = document.querySelectorAll('.tt-atref-item')
    expect(items.length).toBe(3)
    ;(items[0] as HTMLElement).click()
    vi.advanceTimersByTime(500)

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    const saved = team.dailyNotes[loc.ref.kind === 'daily' ? loc.ref.date : '']
    expect(saved).toContain('existing note text')
    expect(saved).toContain('Meeting')
  })

  test('double render leaves the live container intact under a subsequent store mutation', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)

    const before = container.querySelectorAll('.tt-calendar').length
    // NOTE: this does NOT detect a dropped unsubscribe(), despite what an
    // earlier version of this comment claimed. A leaked listener from a
    // disposed instance re-renders into its own *detached* DOM, so it neither
    // throws nor changes the live container's node counts — deleting the
    // unsubscribe() line leaves this test green. What it does pin is that the
    // surviving instance stays coherent across a re-mount. The actual leak
    // detection lives in test/lifecycle.test.ts, which counts net-live store
    // subscriptions (the only place the leak is observable).
    expect(() => store.update((d) => { d.teams[0]!.dailyNotes['2026-07-11'] = 'x' })).not.toThrow()
    expect(container.querySelectorAll('.tt-calendar').length).toBe(before)
  })
})

describe('two-month calendar anchor persistence', () => {
  function monthLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.tt-calendar-month-label')).map((e) => e.textContent ?? '')
  }

  test('picking a day already visible in the previous-month grid does not recenter the displayed months', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    render(container, loc, store, pm, 0)
    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])

    // Simulates what src/ui/panes.ts's renderBody does after pm.openInPane:
    // clears the container's DOM, then tears down and remounts
    // renderDailyNotes with the newly picked date, on the same store/pane —
    // real production remount semantics (withDisposal runs on every
    // renderDailyNotes call), just without the full PaneManager.
    container.innerHTML = ''
    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-06-10' } }, store, pm, 0)

    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])
  })

  test('opening a day outside the displayed window recenters the pair around it', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    render(container, loc, store, pm, 0)

    container.innerHTML = ''
    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-10-05' } }, store, pm, 0)

    expect(monthLabels(container)).toEqual(['September 2026', 'October 2026'])
  })

  test('each pane tracks its own anchor independently', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    const container2 = document.createElement('div')
    document.body.appendChild(container2)

    render(container, loc, store, pm, 0)
    render(container2, { teamId: team.id, ref: { kind: 'daily', date: '2026-03-01' } }, store, pm, 1)

    // Pane 0 re-anchors around July, unaffected by pane 1's March anchor.
    container.innerHTML = ''
    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-06-20' } }, store, pm, 0)
    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])
  })

  test('anchors are per-document: a second store does not inherit the first store\'s anchor', () => {
    const a = setup(makeTeam(), '2026-07-15')
    render(a.container, a.loc, a.store, a.pm, 0)
    const b = setup(makeTeam(), '2026-06-10')
    render(b.container, b.loc, b.store, b.pm, 0)
    expect(monthLabels(b.container)).toEqual(['May 2026', 'June 2026'])
  })

  test('manual month navigation (top header\'s ‹) updates the persisted anchor, so a subsequent pick in the newly-visible window does not jump the pair back', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, '2026-07-15')
    render(container, loc, store, pm, 0)
    expect(monthLabels(container)).toEqual(['June 2026', 'July 2026'])

    // Click the top header's ‹ — in two-month mode this is the only header
    // with nav arrows (see src/ui/calendar.ts). View becomes May/June.
    const topHeader = container.querySelectorAll('.tt-calendar-header')[0]!
    const prevBtn = topHeader.querySelectorAll<HTMLButtonElement>('.tt-calendar-nav-btn')[0]!
    prevBtn.click()
    expect(monthLabels(container)).toEqual(['May 2026', 'June 2026'])

    // Pick June 10, now shown in the bottom grid.
    dayButtonFor(container, 10).click()
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-06-10' } } }])

    // Simulate the real remount (src/ui/panes.ts's renderBody) with the picked date.
    container.innerHTML = ''
    render(container, { teamId: team.id, ref: { kind: 'daily', date: '2026-06-10' } }, store, pm, 0)

    // Must stay on May/June — not jump back to June/July, which is what
    // would happen if the arrow-nav never updated the persisted anchor.
    expect(monthLabels(container)).toEqual(['May 2026', 'June 2026'])
  })
})

// Regression: ui/editor.ts's debounced onChange used to be *dropped* on
// destroy(), so a module/team/pane switch landing inside the 300ms window
// after a keystroke lost those characters outright — they never reached the
// store, so they were never saved either. destroy() now flushes instead.
describe('pending editor changes survive teardown', () => {
  test('a module switch inside the debounce window still persists the edit', () => {
    vi.useFakeTimers()
    try {
      const { container, store, pm, loc } = setup(makeTeam())
      render(container, loc, store, pm)

      setBlockText(editorEl(container), 'note typed right before switching')
      fireInput(editorEl(container))

      // Switch 100ms later — inside CHANGE_DEBOUNCE_MS (300ms).
      vi.advanceTimersByTime(100)
      render(container, { teamId: 'T1', ref: { kind: 'general' } }, store, pm)
      vi.advanceTimersByTime(1000)

      expect(store.doc.teams[0]!.dailyNotes['2026-07-10']).toContain('note typed right before switching')
    } finally {
      vi.useRealTimers()
    }
  })

  test('the flushed edit lands on the day being left, not the one navigated to', () => {
    vi.useFakeTimers()
    try {
      const { container, store, pm, loc } = setup(makeTeam())
      render(container, loc, store, pm)

      setBlockText(editorEl(container), 'typed into 07-10')
      fireInput(editorEl(container))

      vi.advanceTimersByTime(100)
      render(container, { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-11' } }, store, pm)
      vi.advanceTimersByTime(1000)

      expect(store.doc.teams[0]!.dailyNotes['2026-07-10']).toContain('typed into 07-10')
      expect(store.doc.teams[0]!.dailyNotes['2026-07-11']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

test('a backlink chip renders when another field mentions this day, and is absent otherwise', () => {
  const team = makeTeam()
  team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: 'See @[Aug 4](day:2026-08-04)', order: 0, closed: false })
  const { container, store, pm, loc } = setup(team, '2026-08-04')
  render(container, loc, store, pm)
  expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')

  document.body.innerHTML = ''
  const { container: c2, store: s2, pm: pm2, loc: loc2 } = setup(makeTeam(), '2026-08-04')
  render(c2, loc2, s2, pm2)
  expect(c2.querySelector('.tt-backlinks-chip')).toBeNull()
})

test('clicking the chip and then a backlink row navigates via the pane manager', () => {
  const team = makeTeam()
  team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: 'See @[Aug 4](day:2026-08-04)', order: 0, closed: false })
  const { container, store, pm, loc } = setup(team, '2026-08-04')
  render(container, loc, store, pm)
  container.querySelector<HTMLElement>('.tt-backlinks-chip')!.click()
  document.querySelector<HTMLElement>('.tt-backlinks-row')!.click()
  expect(pm.calls).toContainEqual({ idx: 0, loc: { teamId: 'T1', ref: { kind: 'risks', itemId: 'r1' } } })
})

test('a store update scoped only to "risks" live-updates the chip via rebuildBadge() — proves the widened WATCHED list (not just initial render) drives this', () => {
  const team = makeTeam()
  team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
  const { container, store, pm, loc } = setup(team, '2026-08-04')
  render(container, loc, store, pm)
  expect(container.querySelector('.tt-backlinks-chip')).toBeNull()

  store.update((d) => {
    const risk = d.teams[0]!.risks.find((r) => r.id === 'r1')!
    risk.followup = 'See @[Aug 4](day:2026-08-04)'
  }, { teamId: 'T1', sections: ['risks'] })

  expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
})

test('renaming a milestone mentioned in this note live-updates its @mention chip, without disturbing the rest of the editor', () => {
  const team = makeTeam()
  team.milestones.push({ id: 'm1', date: '2026-08-04', title: 'Old Title', done: false, followup: '' })
  team.dailyNotes['2026-08-04'] = 'See @[Old Title](milestone:m1) for details'
  const { container, store, pm, loc } = setup(team, '2026-08-04')
  render(container, loc, store, pm)

  const chip = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="milestone:m1"]')!
  expect(chip.textContent).toBe('@Old Title')

  store.update((d) => {
    d.teams[0]!.milestones.find((m) => m.id === 'm1')!.title = 'New Title'
  }, { teamId: 'T1', sections: ['milestones'] })

  const chipAfter = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="milestone:m1"]')!
  expect(chipAfter.textContent).toBe('@New Title')
  // Same DOM node patched in place, not a full re-render — a live caret
  // elsewhere in this note would have survived untouched.
  expect(chipAfter).toBe(chip)
  expect(editorEl(container).textContent).toBe('See @New Title for details')
})
