import { renderPersonNotes } from '../src/modules/person-notes'
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
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM> } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { container, store, pm }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex }
  renderPersonNotes(container, loc, ctx)
}

function editorEl(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.editor')
  if (!found) throw new Error('.editor not found')
  return found
}

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

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('renderPersonNotes', () => {
  test('renders header as "name — role" and loads existing notes into the editor', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '## Hi Bruno' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    expect(container.querySelector('.tt-person-header')?.textContent).toBe('Bruno — Dev')
    expect(container.querySelector('.editor h2')?.textContent).toBe('Hi Bruno')
  })

  test('header shows just the name when role is empty', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-person-header')?.textContent).toBe('Bruno')
  })

  test('onChange persists the edited markdown into person.notes', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), 'New notes')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.members[0]!.notes).toBe('New notes')
  })

  test('clearing the notes (whitespace-only) persists an empty string', () => {
    vi.useFakeTimers()
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'existing' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), '   ')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.members[0]!.notes).toBe('')
  })

  test('shows a "person not found" placeholder (no crash) when the personId does not exist', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'ghost', group: 'members' } }
    expect(() => render(container, loc, store, pm)).not.toThrow()

    expect(container.querySelector('.editor')).toBeNull()
    expect(container.textContent).toBe('Person not found')
  })

  test('degrades to the "person not found" placeholder if the person is deleted while the pane is open', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.editor')).not.toBeNull()

    store.update((d) => {
      d.teams[0]!.members = d.teams[0]!.members.filter((p) => p.id !== 'mem-1')
    })

    expect(container.querySelector('.editor')).toBeNull()
    expect(container.textContent).toBe('Person not found')
  })

  // Regression: the header used to be painted once at mount and never
  // refreshed by the pane's own subscribe callback (which only rebuilt the
  // backlinks chip) — renaming the person from another pane (e.g. the
  // people-tree edit modal) left this pane showing the stale name
  // indefinitely, breaking the "labels always resolve live" guarantee every
  // other module in the app honors.
  test('the header picks up a rename made from elsewhere while the pane is open', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-person-header')?.textContent).toBe('Bruno — Dev')

    store.update((d) => {
      const p = d.teams[0]!.members.find((m) => m.id === 'mem-1')!
      p.name = 'Bruna'
      p.role = 'Lead'
    })

    expect(container.querySelector('.tt-person-header')?.textContent).toBe('Bruna — Lead')
  })

  test('double render into the same container disposes the previous instance: no duplicate @ dropdowns', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))

    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)
  })

  test('double render into the same container disposes the previous instance: no duplicate template pickers', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

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

  // Not a leak test: a leaked listener re-renders into detached DOM, so it is
  // invisible from here. See test/lifecycle.test.ts for the subscription-count
  // test that actually catches a dropped unsubscribe().
  test('double render leaves the live container intact under a subsequent store mutation', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)

    expect(() => store.update((d) => { d.teams[0]!.dailyNotes['2026-07-11'] = 'x' })).not.toThrow()
    expect(container.querySelector('.editor')).not.toBeNull()
  })

  test('clicking a ref chip navigates via makeRefClickHandler using the pane it was mounted in', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '@[Carla](person:stk-1) ' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm, 1)

    const chip = container.querySelector<HTMLAnchorElement>('a.ref')!
    chip.click()

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
  })

  test('a backlink chip renders in the header when another field mentions this person', () => {
    const team = makeTeam()
    team.actionItems.push({ id: 'a1', summary: 'Ship it', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: 'Blocked on @[Carla](person:stk-1)' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
  })

  test('no chip when nothing mentions this person', () => {
    const { container, store, pm } = setup(makeTeam())
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-backlinks-chip')).toBeNull()
  })
})
