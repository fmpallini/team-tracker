import { renderGeneralNotes } from '../src/modules/general-notes'
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
    stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    generalNotes: '',
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
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex, saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} } }
  renderGeneralNotes(container, loc, ctx)
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

describe('renderGeneralNotes', () => {
  test('loads existing generalNotes content into the editor', () => {
    const team = makeTeam({ generalNotes: '## Team scratchpad' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    expect(container.querySelector('.editor h2')?.textContent).toBe('Team scratchpad')
  })

  test('renders an empty editor when generalNotes is undefined (older-doc case)', () => {
    const team = makeTeam()
    delete (team as { generalNotes?: string }).generalNotes
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    expect(() => render(container, loc, store, pm)).not.toThrow()
    expect(editorEl(container).textContent).toBe('')
  })

  test('onChange persists the edited markdown into team.generalNotes', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), 'New note')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.generalNotes).toBe('New note')
  })

  test('clearing the notes (whitespace-only) persists an empty string', () => {
    vi.useFakeTimers()
    const team = makeTeam({ generalNotes: 'existing' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), '   ')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.generalNotes).toBe('')
  })

  test('double render into the same container disposes the previous instance: no duplicate @ dropdowns', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }

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

  test('template picker only offers scope:any templates', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), '/')
    fireInput(editorEl(container))

    const items = document.querySelectorAll('.tt-atref-item')
    expect(items.length).toBe(1) // only the single scope:'any' builtin (Decision) out of the 5 builtins
    ;(items[0] as HTMLElement).click()
    vi.advanceTimersByTime(500)

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(store.doc.teams[0]!.generalNotes).toBeTruthy()
  })

  test('clicking a ref chip navigates via makeRefClickHandler using the pane it was mounted in', () => {
    const team = makeTeam({
      stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
      generalNotes: '@[Carla](person:stk-1) ',
    })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'general' } }
    render(container, loc, store, pm, 1)

    const chip = container.querySelector<HTMLAnchorElement>('a.ref')!
    chip.click()

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
  })
})
