import {
  renderPeopleTree,
  childrenOf,
  isDescendant,
  computeDropPosition,
  moveInTree,
  moveToRoot,
  deletePerson,
} from '../src/modules/people-tree'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { unlinkRefsInTeam } from '../src/core/refs'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Person, Team } from '../src/core/types'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
  const calls: { idx: 0 | 1; loc: Loc }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
    openBothPanes: () => {},
    openInFocused: (loc: Loc) => { calls.push({ idx: 0, loc }) },
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
  }
}

function person(overrides: Partial<Person>): Person {
  return { id: 'p', name: 'Name', role: '', parentId: null, order: 0, notes: '', ...overrides }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team, group: 'stakeholders' | 'members' = 'members'): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM>; loc: Loc } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const loc: Loc = { teamId: team.id, ref: { kind: group } }
  return { container, store, pm, loc }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, group: 'stakeholders' | 'members', paneIdx: 0 | 1 = 0): void {
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
  renderPeopleTree(group)(container, loc, ctx)
}

function clickByTitleOrText(root: ParentNode, text: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text || b.title === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

function boxes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-org-box'))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('pure helpers', () => {
  test('childrenOf returns roots sorted by order', () => {
    const people = [
      person({ id: 'b', order: 1 }),
      person({ id: 'a', order: 0 }),
      person({ id: 'c', order: 2, parentId: 'a' }),
    ]
    expect(childrenOf(people, null).map((p) => p.id)).toEqual(['a', 'b'])
    expect(childrenOf(people, 'a').map((p) => p.id)).toEqual(['c'])
  })

  test('isDescendant: a node is its own descendant (self) and detects nested descendants', () => {
    const people = [
      person({ id: 'a', parentId: null }),
      person({ id: 'b', parentId: 'a' }),
      person({ id: 'c', parentId: 'b' }),
      person({ id: 'x', parentId: null }),
    ]
    expect(isDescendant(people, 'a', 'a')).toBe(true)
    expect(isDescendant(people, 'c', 'a')).toBe(true)
    expect(isDescendant(people, 'b', 'c')).toBe(false)
    expect(isDescendant(people, 'x', 'a')).toBe(false)
  })

  test('computeDropPosition: top quarter is before, bottom quarter is after, middle half is child', () => {
    expect(computeDropPosition(0, 100)).toBe('before')
    expect(computeDropPosition(24, 100)).toBe('before')
    expect(computeDropPosition(25, 100)).toBe('child')
    expect(computeDropPosition(50, 100)).toBe('child')
    expect(computeDropPosition(75, 100)).toBe('child')
    expect(computeDropPosition(76, 100)).toBe('after')
    expect(computeDropPosition(100, 100)).toBe('after')
  })

  test('computeDropPosition: degenerates to child for a zero/negative height row', () => {
    expect(computeDropPosition(0, 0)).toBe('child')
    expect(computeDropPosition(5, -1)).toBe('child')
  })

  test('moveToRoot: promotes a nested person to the end of the root list, renumbering both groups', () => {
    const people = [
      person({ id: 'a', parentId: null, order: 0 }),
      person({ id: 'b', parentId: null, order: 1 }),
      person({ id: 'c', parentId: 'a', order: 0 }),
      person({ id: 'd', parentId: 'a', order: 1 }),
    ]
    moveToRoot(people, 'c')
    expect(childrenOf(people, null).map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(childrenOf(people, 'a').map((p) => p.id)).toEqual(['d'])
    expect(childrenOf(people, 'a').map((p) => p.order)).toEqual([0])
  })

  test('moveToRoot: no-ops for a person already at the root and for unknown ids', () => {
    const people = [
      person({ id: 'a', parentId: null, order: 0 }),
      person({ id: 'b', parentId: null, order: 1 }),
    ]
    moveToRoot(people, 'a')
    expect(childrenOf(people, null).map((p) => p.id)).toEqual(['a', 'b'])
    moveToRoot(people, 'nope')
    expect(childrenOf(people, null).map((p) => p.id)).toEqual(['a', 'b'])
  })

  test('moveInTree: reparents as a child and appends at the end, renumbering both groups', () => {
    const people = [
      person({ id: 'a', parentId: null, order: 0 }),
      person({ id: 'b', parentId: null, order: 1 }),
      person({ id: 'c', parentId: 'a', order: 0 }),
    ]
    moveInTree(people, 'b', 'a', 'child')
    expect(people.find((p) => p.id === 'b')!.parentId).toBe('a')
    expect(childrenOf(people, 'a').map((p) => p.id)).toEqual(['c', 'b'])
    expect(childrenOf(people, null).map((p) => p.id)).toEqual(['a'])
  })

  test('moveInTree: reorders as a sibling before/after the target', () => {
    const people = [
      person({ id: 'a', parentId: null, order: 0 }),
      person({ id: 'b', parentId: null, order: 1 }),
      person({ id: 'c', parentId: null, order: 2 }),
    ]
    moveInTree(people, 'c', 'a', 'before')
    expect(childrenOf(people, null).map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  test('moveInTree: refuses to drop a node onto itself or onto its own descendant (cycle guard)', () => {
    const people = [
      person({ id: 'a', parentId: null, order: 0 }),
      person({ id: 'b', parentId: 'a', order: 0 }),
    ]
    moveInTree(people, 'a', 'a', 'child')
    moveInTree(people, 'a', 'b', 'child') // 'b' is a descendant of 'a' — forbidden
    expect(people.find((p) => p.id === 'a')!.parentId).toBeNull()
    expect(people.find((p) => p.id === 'b')!.parentId).toBe('a')
  })

  test('deletePerson: promotes children into the deleted node\'s slot among its former siblings', () => {
    const people = [
      person({ id: 'a', parentId: null, order: 0 }),
      person({ id: 'mid', parentId: null, order: 1 }),
      person({ id: 'z', parentId: null, order: 2 }),
      person({ id: 'child1', parentId: 'mid', order: 0 }),
      person({ id: 'child2', parentId: 'mid', order: 1 }),
    ]
    const result = deletePerson(people, 'mid')
    expect(result.map((p) => p.id)).not.toContain('mid')
    expect(childrenOf(result, null).map((p) => p.id)).toEqual(['a', 'child1', 'child2', 'z'])
    expect(result.find((p) => p.id === 'child1')!.parentId).toBeNull()
    expect(result.find((p) => p.id === 'child2')!.parentId).toBeNull()
  })

  test('deletePerson: deleting a leaf with no children just removes it', () => {
    const people = [person({ id: 'a', parentId: null, order: 0 }), person({ id: 'b', parentId: null, order: 1 })]
    const result = deletePerson(people, 'a')
    expect(result.map((p) => p.id)).toEqual(['b'])
    expect(result[0]!.order).toBe(0)
  })

  test('deletePerson: deleting an id that does not exist is a no-op', () => {
    const people = [person({ id: 'a' })]
    expect(deletePerson(people, 'nope')).toBe(people)
  })
})

describe('renderPeopleTree', () => {
  test('renders roots sorted by order, with children nested and indented', () => {
    const team = makeTeam({
      members: [
        person({ id: 'b', name: 'Bruno', order: 1 }),
        person({ id: 'a', name: 'Ana', order: 0 }),
        person({ id: 'c', name: 'Carla', parentId: 'a', order: 0 }),
      ],
    })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    const names = boxes(container).map((b) => b.querySelector('.tt-org-name')!.textContent)
    expect(names).toEqual(['Ana', 'Carla', 'Bruno'])

    // Carla is nested inside a's .tt-org-children wrapper.
    const carlaBox = boxes(container).find((b) => b.querySelector('.tt-org-name')!.textContent === 'Carla')!
    expect(carlaBox.closest('.tt-org-children')).not.toBeNull()
  })

  test('renders name and role on separate lines', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', role: 'PM', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')
    const box = boxes(container)[0]!
    expect(box.querySelector('.tt-org-name')!.textContent).toBe('Ana')
    expect(box.querySelector('.tt-org-role')!.textContent).toBe('PM')
  })

  test('box has a hover hint telling the user to double-click to open notes', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')
    const box = boxes(container)[0]!
    expect(box.title).toBe('Double-click to open person notes')
  })

  test('double-click on a box opens person notes via pm.openInPane at the module\'s paneIdx', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members', 1)

    const box = boxes(container)[0]!
    box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'a', group: 'members' } } }])
  })

  test('shows a placeholder when the group is empty', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')
    expect(container.querySelector('.tt-people-empty')).not.toBeNull()
  })

  test('"+ Person" adds a root person via a modal', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    clickByTitleOrText(container, '+ Person')
    const nameInput = document.querySelector('input[name="tt-person-name"]') as HTMLInputElement
    const roleInput = document.querySelector('input[name="tt-person-role"]') as HTMLInputElement
    nameInput.value = 'Diana'
    nameInput.dispatchEvent(new Event('input'))
    roleInput.value = 'Eng'
    roleInput.dispatchEvent(new Event('input'))
    clickByTitleOrText(document.body, 'OK')

    expect(store.doc.teams[0]!.members).toHaveLength(1)
    const added = store.doc.teams[0]!.members[0]!
    expect(added.name).toBe('Diana')
    expect(added.role).toBe('Eng')
    expect(added.parentId).toBeNull()
    expect(added.order).toBe(0)
    expect(added.notes).toBe('')
  })

  test('add modal requires a name', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    clickByTitleOrText(container, '+ Person')
    clickByTitleOrText(document.body, 'OK')

    expect(document.querySelector('.tt-field-error')?.textContent).toBe('Name is required')
    expect(store.doc.teams[0]!.members).toHaveLength(0)
  })

  test('the + (add child) hover button adds a child under that node', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    clickByTitleOrText(container, 'Add report')
    const nameInput = document.querySelector('input[name="tt-person-name"]') as HTMLInputElement
    nameInput.value = 'Child'
    nameInput.dispatchEvent(new Event('input'))
    clickByTitleOrText(document.body, 'OK')

    const child = store.doc.teams[0]!.members.find((p) => p.name === 'Child')!
    expect(child.parentId).toBe('a')
  })

  test('the pencil hover button edits name/role in place', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', role: 'PM', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    clickByTitleOrText(container, 'Edit person')
    const nameInput = document.querySelector('input[name="tt-person-name"]') as HTMLInputElement
    expect(nameInput.value).toBe('Ana')
    nameInput.value = 'Ana Renamed'
    nameInput.dispatchEvent(new Event('input'))
    clickByTitleOrText(document.body, 'OK')

    expect(store.doc.teams[0]!.members[0]!.name).toBe('Ana Renamed')
    expect(store.doc.teams[0]!.members[0]!.role).toBe('PM')
  })

  test('the trash hover button deletes after confirmation, promoting children', () => {
    const team = makeTeam({
      members: [
        person({ id: 'a', name: 'Ana', order: 0 }),
        person({ id: 'child', name: 'Child', parentId: 'a', order: 0 }),
      ],
    })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    clickByTitleOrText(container, 'Delete person')
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete Ana? Their reports will be promoted.')
    clickByTitleOrText(document.body, 'Delete')

    const remaining = store.doc.teams[0]!.members
    expect(remaining.map((p) => p.name)).toEqual(['Child'])
    expect(remaining[0]!.parentId).toBeNull()
  })

  test('the notes hover button opens the person via pm.openInFocused', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    clickByTitleOrText(container, 'Open notes')

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'a', group: 'members' } } }])
  })

  test('double render into the same container disposes the previous store subscription (no duplicate tree rebuilds/leaks)', () => {
    const team = makeTeam({ members: [person({ id: 'a', name: 'Ana', order: 0 })] })
    const { container, store, pm, loc } = setup(team, 'members')

    render(container, loc, store, pm, 'members')
    container.innerHTML = ''
    render(container, loc, store, pm, 'members')

    expect(() => store.update((d) => { d.teams[0]!.members[0]!.name = 'Ana 2' })).not.toThrow()
    expect(boxes(container)).toHaveLength(1)
    expect(boxes(container)[0]!.querySelector('.tt-org-name')!.textContent).toBe('Ana 2')
  })

  test('a defensive no-op when loc.ref.kind does not match the registered group', () => {
    const team = makeTeam({ stakeholders: [person({ id: 'a', name: 'Ana', order: 0 })] })
    const { container, store, pm } = setup(team, 'stakeholders')
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'members' } }
    render(container, wrongLoc, store, pm, 'stakeholders')
    expect(container.children).toHaveLength(0)
  })

  test('the trash hover button\'s delete-confirm handler unlinks references to the deleted person from another person\'s notes', () => {
    const team = makeTeam({
      members: [
        person({ id: 'a', name: 'Ana', order: 0 }),
        person({ id: 'b', name: 'Bruno', order: 1, notes: 'ping @[Ana](person:a) about this' }),
      ],
    })
    const { container, store, pm, loc } = setup(team, 'members')
    render(container, loc, store, pm, 'members')

    const anaBox = boxes(container).find((b) => b.querySelector('.tt-org-name')!.textContent === 'Ana')!
    clickByTitleOrText(anaBox, 'Delete person')
    clickByTitleOrText(document.body, 'Delete')

    const remaining = store.doc.teams[0]!.members
    expect(remaining.map((p) => p.name)).toEqual(['Bruno'])
    expect(remaining[0]!.notes).toBe('ping Ana about this')
  })

  describe('root drop zone', () => {
    function nestedTeam(): Team {
      return makeTeam({
        members: [
          person({ id: 'a', name: 'Ana', parentId: null, order: 0 }),
          person({ id: 'c', name: 'Carla', parentId: 'a', order: 0 }),
        ],
      })
    }

    test('appears when dragging a nested person and promotes them to the top level on drop', () => {
      const { container, store, pm, loc } = setup(nestedTeam(), 'members')
      render(container, loc, store, pm, 'members')

      const zone = container.querySelector<HTMLElement>('.tt-people-root-drop')!
      expect(zone).not.toBeNull()
      expect(zone.classList.contains('active')).toBe(false)

      const carlaBox = boxes(container).find((b) => b.querySelector('.tt-org-name')!.textContent === 'Carla')!
      carlaBox.dispatchEvent(new Event('dragstart', { bubbles: true }))
      expect(zone.classList.contains('active')).toBe(true)

      const over = new Event('dragover', { bubbles: true, cancelable: true })
      zone.dispatchEvent(over)
      expect(over.defaultPrevented).toBe(true)

      zone.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
      const members = store.doc.teams[0]!.members
      expect(members.find((p) => p.id === 'c')!.parentId).toBeNull()
      expect(childrenOf(members, null).map((p) => p.id)).toEqual(['a', 'c'])
      expect(zone.classList.contains('active')).toBe(false)
    })

    test('does not appear when dragging a person already at the top level', () => {
      const { container, store, pm, loc } = setup(nestedTeam(), 'members')
      render(container, loc, store, pm, 'members')

      const zone = container.querySelector<HTMLElement>('.tt-people-root-drop')!
      const anaBox = boxes(container).find((b) => b.querySelector('.tt-org-name')!.textContent === 'Ana')!
      anaBox.dispatchEvent(new Event('dragstart', { bubbles: true }))
      expect(zone.classList.contains('active')).toBe(false)
    })
  })
})

test('deleting a person unlinks every reference to them across the team\'s notes', () => {
  const doc = createEmptyDocument('pt-BR')
  doc.teams.push({
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'carla', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'bruno', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'ping @[Carla](person:carla)' }],
    actionItems: [], milestones: [], risks: [],
    dailyNotes: { '2026-07-01': 'saw @[Carla](person:carla) today' },
  })
  const store = createStore(doc)
  store.update((d) => {
    const tm = d.teams.find((t) => t.id === 'T1')!
    unlinkRefsInTeam(tm, 'person', ['carla'])
    tm.stakeholders = deletePerson(tm.stakeholders, 'carla')
  })
  const tm = store.doc.teams[0]!
  expect(tm.members[0]!.notes).toBe('ping Carla')
  expect(tm.dailyNotes['2026-07-01']).toBe('saw Carla today')
  expect(tm.stakeholders).toEqual([])
})
