import { renderPersonNotes } from '../src/modules/person-notes'
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
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
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

  test('double render unsubscribes the previous store listener (no throw, no leaked "not found" flip)', () => {
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
})
