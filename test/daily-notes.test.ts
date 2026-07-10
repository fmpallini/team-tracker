import { renderDailyNotes } from '../src/modules/daily-notes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Team } from '../src/core/types'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
  const calls: { idx: 0 | 1; loc: Loc }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
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
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
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

function dayButtonFor(container: HTMLElement, day: number): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)'))
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

  test('double render unsubscribes the previous store listener (calendar rebuild count does not grow)', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)

    const before = container.querySelectorAll('.tt-calendar').length
    // Any store mutation triggers subscribers; if the first instance's
    // listener were still attached, this would rebuild (and re-append) the
    // calendar twice into the (single, current) calendarSlot — but a leaked
    // listener from a disposed instance would throw (its calendarSlot/ctx
    // still reference the old, detached DOM) rather than silently duplicate,
    // so simply not throwing here is the meaningful assertion.
    expect(() => store.update((d) => { d.teams[0]!.dailyNotes['2026-07-11'] = 'x' })).not.toThrow()
    expect(container.querySelectorAll('.tt-calendar').length).toBe(before)
  })
})
