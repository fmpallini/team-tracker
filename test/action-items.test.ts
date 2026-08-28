import { renderActionItems, itemsByStatus, isOverdue, computeFlatDropPosition, moveCard, moveColumn, resolveAssigneeDisplay, matchPersonByName } from '../src/modules/action-items'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { PaneManager, ModuleCtx, SaveStatusApi } from '../src/ui/panes'
import type { SaveStatusInfo } from '../src/ui/shell'
import type { ActionColumn, ActionItem, Loc, Team } from '../src/core/types'

/** A controllable fake for ModuleCtx.saveStatus — `emit` drives every subscriber the same way shell.ts's real setSaveState() would, and `requestCount` counts force-save clicks, for the header-pill/expand-mode tests below. Every other test just needs the default (a no-op stub, built fresh per render() call) and never touches this directly. */
function fakeSaveStatus(): { api: SaveStatusApi; emit: (info: SaveStatusInfo) => void; requestCount: () => number; subscriberCount: () => number } {
  const subs = new Set<(info: SaveStatusInfo) => void>()
  let requestCount = 0
  return {
    api: {
      requestSaveNow: () => { requestCount++ },
      subscribeSaveState: (cb) => {
        subs.add(cb)
        cb({ state: 'saved', label: 'Saved', title: 'Saved' })
        return () => { subs.delete(cb) }
      },
    },
    emit: (info) => { for (const cb of subs) cb(info) },
    requestCount: () => requestCount,
    subscriberCount: () => subs.size,
  }
}

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

function item(overrides: Partial<ActionItem>): ActionItem {
  return { id: 'i1', summary: 'Do thing', status: 'todo', dueDate: null, assignee: '', order: 0, notes: '', color: 'ledger', ...overrides }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    actionColumns: [{ id: 'wip', name: 'WIP', order: 0 }],
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM>; loc: Loc } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const loc: Loc = { teamId: team.id, ref: { kind: 'actions' } }
  return { container, store, pm, loc }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0, saveStatus: SaveStatusApi = fakeSaveStatus().api): void {
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex, saveStatus }
  renderActionItems(container, loc, ctx)
}

/** Sets an input's value and fires the real `change` event — every card field now commits on `onchange` (blur/Enter), not a Save button reading `.value` directly, so a test that only assigns `.value` would silently persist nothing. */
function setValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickByTitleOrText(root: ParentNode, text: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text || b.title === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

function cards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-card'))
}

function rightClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
}

function contextMenuItem(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item')).find((b) => b.textContent === text)!
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

function pickDate(day: number): void {
  const input = document.querySelector('.tt-date-picker-input') as HTMLInputElement
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)'))
    .find((b) => b.textContent === String(day))!
    .click()
}

afterEach(() => {
  // Tests below routinely leave a context menu or modal open (no Escape/
  // pick), and both attach a document-level keydown listener that wiping
  // document.body doesn't remove — it would otherwise leak into the next
  // test and react to that test's own keydown dispatches. Escape lets any
  // still-open one close itself and unregister before the DOM is wiped.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('pure helpers', () => {
  test('itemsByStatus filters and sorts by order', () => {
    const items = [item({ id: 'b', order: 1 }), item({ id: 'a', order: 0 }), item({ id: 'c', order: 2, status: 'done' })]
    expect(itemsByStatus(items, 'todo').map((i) => i.id)).toEqual(['a', 'b'])
    expect(itemsByStatus(items, 'done').map((i) => i.id)).toEqual(['c'])
  })

  describe('isOverdue', () => {
    test('true when dueDate is in the past and the item is todo/wip', () => {
      expect(isOverdue({ dueDate: '2000-01-01', status: 'todo' }, '2026-07-15')).toBe(true)
      expect(isOverdue({ dueDate: '2000-01-01', status: 'wip' }, '2026-07-15')).toBe(true)
    })
    test('false when done or cancelled, even if the due date is in the past', () => {
      expect(isOverdue({ dueDate: '2000-01-01', status: 'done' }, '2026-07-15')).toBe(false)
      expect(isOverdue({ dueDate: '2000-01-01', status: 'cancelled' }, '2026-07-15')).toBe(false)
    })
    test('false when there is no due date', () => {
      expect(isOverdue({ dueDate: null, status: 'todo' }, '2026-07-15')).toBe(false)
    })
    test('false when the due date is today or in the future', () => {
      expect(isOverdue({ dueDate: '2026-07-15', status: 'todo' }, '2026-07-15')).toBe(false)
      expect(isOverdue({ dueDate: '2999-01-01', status: 'todo' }, '2026-07-15')).toBe(false)
    })
  })

  describe('computeFlatDropPosition', () => {
    test('top half is before, bottom half is after', () => {
      expect(computeFlatDropPosition(0, 100)).toBe('before')
      expect(computeFlatDropPosition(49, 100)).toBe('before')
      expect(computeFlatDropPosition(50, 100)).toBe('after')
      expect(computeFlatDropPosition(100, 100)).toBe('after')
    })
    test('degenerates to after for a zero/negative height card', () => {
      expect(computeFlatDropPosition(0, 0)).toBe('after')
      expect(computeFlatDropPosition(5, -1)).toBe('after')
    })
  })

  describe('moveCard', () => {
    test('reorders within the same status group, renumbering densely', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 }), item({ id: 'c', order: 2 })]
      moveCard(items, 'c', 'todo', 'a', 'before')
      expect(itemsByStatus(items, 'todo').map((i) => i.id)).toEqual(['c', 'a', 'b'])
      expect(itemsByStatus(items, 'todo').map((i) => i.order)).toEqual([0, 1, 2])
    })

    test("moves to a different status, appending at the target group's end when targetId is null", () => {
      const items = [item({ id: 'a', status: 'todo', order: 0 }), item({ id: 'w', status: 'wip', order: 0 })]
      moveCard(items, 'a', 'wip', null, 'after')
      expect(items.find((i) => i.id === 'a')!.status).toBe('wip')
      expect(itemsByStatus(items, 'wip').map((i) => i.id)).toEqual(['w', 'a'])
      expect(itemsByStatus(items, 'todo')).toHaveLength(0)
    })

    test('moving to a different status closes the order gap in the old group', () => {
      const items = [item({ id: 'a', status: 'todo', order: 0 }), item({ id: 'b', status: 'todo', order: 1 }), item({ id: 'c', status: 'todo', order: 2 })]
      moveCard(items, 'b', 'done', null, 'after')
      expect(itemsByStatus(items, 'todo').map((i) => i.order)).toEqual([0, 1])
    })

    test('no-op when dropped onto itself in the same status', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 })]
      moveCard(items, 'a', 'todo', 'a', 'before')
      expect(items.map((i) => i.order)).toEqual([0, 1])
    })

    test('no-op when the dragged id does not exist', () => {
      const items = [item({ id: 'a', order: 0 })]
      moveCard(items, 'ghost', 'todo', 'a', 'before')
      expect(items[0]!.order).toBe(0)
    })

    test('appends at the end when the target id is not found in the destination group', () => {
      const items = [item({ id: 'a', status: 'todo', order: 0 }), item({ id: 'w', status: 'wip', order: 0 })]
      moveCard(items, 'a', 'wip', 'ghost', 'before')
      expect(itemsByStatus(items, 'wip').map((i) => i.id)).toEqual(['w', 'a'])
    })
  })

  describe('resolveAssigneeDisplay', () => {
    test('linked: a live person mention resolves to the person\'s current name', () => {
      const team = makeTeam() // stakeholder Carla (stk-1), member Bruno (mem-1)
      expect(resolveAssigneeDisplay('@[Old Name](person:stk-1)', team)).toEqual({ kind: 'linked', personId: 'stk-1', name: 'Carla' })
    })

    test('unlinked: a muted marker resolves to its frozen label', () => {
      const team = makeTeam()
      expect(resolveAssigneeDisplay('~Departed Person~', team)).toEqual({ kind: 'unlinked', label: 'Departed Person' })
    })

    test('text: plain free text passes through unchanged', () => {
      const team = makeTeam()
      expect(resolveAssigneeDisplay('External vendor', team)).toEqual({ kind: 'text', text: 'External vendor' })
    })

    test('text: empty string passes through unchanged', () => {
      const team = makeTeam()
      expect(resolveAssigneeDisplay('', team)).toEqual({ kind: 'text', text: '' })
    })

    test('text: falls back to the mention\'s frozen label when its id no longer exists in the team (defensive — unlink-on-delete should prevent this)', () => {
      const team = makeTeam()
      expect(resolveAssigneeDisplay('@[Ghost](person:gone)', team)).toEqual({ kind: 'text', text: 'Ghost' })
    })
  })

  describe('matchPersonByName', () => {
    test('finds a stakeholder or member by exact, case/accent-insensitive name match', () => {
      const team = makeTeam()
      expect(matchPersonByName('carla', team)?.id).toBe('stk-1')
      expect(matchPersonByName('BRUNO', team)?.id).toBe('mem-1')
    })

    test('returns null when there is no exact match (a partial hint is not enough)', () => {
      const team = makeTeam()
      expect(matchPersonByName('Car', team)).toBeNull()
      expect(matchPersonByName('Someone else', team)).toBeNull()
    })

    test('returns null for blank input', () => {
      const team = makeTeam()
      expect(matchPersonByName('  ', team)).toBeNull()
    })
  })

  describe('moveColumn', () => {
    function col(overrides: Partial<ActionColumn>): ActionColumn {
      return { id: 'c1', name: 'Col', order: 0, ...overrides }
    }

    test('reorders within bounds, renumbering densely', () => {
      const columns = [col({ id: 'a', order: 0 }), col({ id: 'b', order: 1 }), col({ id: 'c', order: 2 })]
      moveColumn(columns, 'c', 'a', 'before')
      expect(columns.slice().sort((x, y) => x.order - y.order).map((c) => c.id)).toEqual(['c', 'a', 'b'])
    })

    test('no-op when the dragged id does not exist', () => {
      const columns = [col({ id: 'a', order: 0 })]
      moveColumn(columns, 'ghost', 'a', 'before')
      expect(columns[0]!.order).toBe(0)
    })

    test('no-op when dropped onto itself', () => {
      const columns = [col({ id: 'a', order: 0 }), col({ id: 'b', order: 1 })]
      moveColumn(columns, 'a', 'a', 'before')
      expect(columns.map((c) => c.order)).toEqual([0, 1])
    })

    test('appends at the end when the target id is null or not found', () => {
      const columns = [col({ id: 'a', order: 0 }), col({ id: 'b', order: 1 })]
      moveColumn(columns, 'a', null, 'after')
      expect(columns.slice().sort((x, y) => x.order - y.order).map((c) => c.id)).toEqual(['b', 'a'])
    })
  })
})

describe('card context menu', () => {
  test('right-click shows only Duplicate and Delete when there is just one team', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)

    const labels = Array.from(document.querySelectorAll('.tt-context-menu-item')).map((b) => b.textContent)
    expect(labels).toEqual(['Duplicate', 'Delete'])
  })

  test('Delete opens the same confirm dialog as the pencil-icon delete button, and removes the card on confirm', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a1', order: 0, summary: 'Do the thing' })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Delete').click()

    const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Delete')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()

    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })

  test('Duplicate appends a copy to the same team', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Duplicate').click()

    expect(store.doc.teams[0]!.actionItems).toHaveLength(2)
  })

  test('Copy to team… copies into the target team with refs stripped and does not affect the source', () => {
    const from = makeTeam({ id: 'from', actionItems: [item({ id: 'a1', order: 0, notes: 'ping @[Ana](person:p1)' })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Copy to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.actionItems).toHaveLength(1)
    const copied = store.doc.teams.find((t) => t.id === 'to')!.actionItems
    expect(copied).toHaveLength(1)
    expect(copied[0]!.notes).toBe('ping Ana')
  })

  test('Move to team… removes the card from the source team', () => {
    const from = makeTeam({ id: 'from', actionItems: [item({ id: 'a1', order: 0 })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Move to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.actionItems).toHaveLength(0)
    expect(store.doc.teams.find((t) => t.id === 'to')!.actionItems).toHaveLength(1)
  })

  test('"Copy to team…" opens a combined team+column picker whose column list is the target team\'s actionColumns plus the fixed statuses', () => {
    const from = makeTeam({ id: 'from', actionItems: [item({ id: 'a1', order: 0 })] })
    const to = makeTeam({ id: 'to', name: 'Team 2', actionColumns: [{ id: 'review', name: 'Review', order: 0 }] })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'actions' } }, store, pm)

    rightClick(cards(container)[0]!)
    contextMenuItem('Copy to team…').click()
    const [teamSelect, columnSelect] = document.querySelectorAll<HTMLSelectElement>('select')
    teamSelect!.value = 'to'
    teamSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(Array.from(columnSelect!.querySelectorAll('option')).map((o) => o.value)).toEqual(['todo', 'review', 'done', 'cancelled'])
    columnSelect!.value = 'review'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'to')!.actionItems[0]!.status).toBe('review')
  })
})

// Regression for the accessibility gap the kanban cards used to have: no
// pointer-free route to the card's context menu at all (right-click or the
// small pencil button only). Mirrors risks.ts/milestones.ts's identical
// keyboard route to their own row context menu.
describe('keyboard route to the card actions', () => {
  test('the card is focusable', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const card = cards(container)[0]!
    expect(card.getAttribute('tabindex')).toBe('0')
  })

  test('Space on the card opens the context menu', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const card = cards(container)[0]!

    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(document.querySelector('.tt-context-menu')).not.toBeNull()
  })

  // Regression: with the context menu open, ArrowDown used to fall through
  // to the board's own card-to-card navigation (the menu never took
  // keyboard focus) instead of moving the menu's own selection. A second
  // team is added so the menu has more than one option ("Copy/Move to
  // team" only render when other teams exist) — otherwise ArrowDown's
  // clamp-at-the-only-item behavior would pass even without the fix.
  test('with the context menu open, arrows navigate its options, not the board', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 })] })
    const { container, store, pm, loc } = setup(team)
    store.update((d) => { d.teams.push(makeTeam({ id: 'T2', name: 'Team 2' })) })
    render(container, loc, store, pm)
    const cardA = cards(container)[0]!
    const cardB = cards(container)[1]!

    cardA.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    const menuItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item'))
    expect(menuItems.length).toBeGreaterThan(1)
    expect(document.activeElement).toBe(menuItems[0])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    expect(document.activeElement).toBe(menuItems[1]) // moved within the menu...
    expect(document.activeElement).not.toBe(cardB) // ...not onto card B
    expect(document.querySelector('.tt-context-menu')).not.toBeNull() // menu stayed open
  })

  test('Enter on the card opens the edit modal, not the context menu', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0, summary: 'Do thing' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const card = cards(container)[0]!

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(document.querySelector('.tt-context-menu')).toBeNull()
    const summaryInput = document.querySelector('.tt-modal-dialog input.tt-input') as HTMLInputElement
    expect(summaryInput?.value).toBe('Do thing')
    expect(document.activeElement).toBe(summaryInput)
  })

  // Regression: closing the edit modal used to leave focus stranded on
  // document.body, so ArrowUp/Down after Enter-to-open/close felt like it
  // had "forgotten" the card the user was just on.
  test('closing the edit modal restores focus to the card that was open', async () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const card = cards(container)[0]!

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    clickByTitleOrText(document.body, 'Close')
    // The restore is deferred a tick — see openEditModal's onClose comment:
    // a real-Chrome-only race where the browser's own delayed "focused
    // element got removed" unfocus step can otherwise outrun a synchronous
    // .focus() here and land back on <body>.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.tt-modal-dialog')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-item-id="a"]'))
  })

  // No more Save button: an edit commits the moment the field changes (see
  // "live persistence" describe block below), so closing afterward is just
  // closing — this only re-checks that the focus-restore behavior above
  // still holds once a field's actually been edited first.
  test('editing then closing the modal persists the edit and restores focus to that same card', async () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const card = cards(container)[0]!

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    setValue(document.querySelector('.tt-modal-dialog input.tt-input') as HTMLInputElement, 'Updated')
    clickByTitleOrText(document.body, 'Close')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.doc.teams[0]!.actionItems[0]!.summary).toBe('Updated')
    expect(document.activeElement).toBe(container.querySelector('[data-item-id="a"]'))
  })

  test('typing a summary into a brand-new card focuses the card it just created, once closed', async () => {
    const team = makeTeam({ actionItems: [] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const summaryInput = document.querySelector('.tt-modal-dialog input.tt-input') as HTMLInputElement
    setValue(summaryInput, 'New card')
    clickByTitleOrText(document.body, 'Close')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const newCard = cards(container)[0]!
    expect(newCard.textContent).toContain('New card')
    expect(document.activeElement).toBe(newCard)
  })

  test('closing a brand-new, never-typed-into card discards the empty draft and leaves nothing stranded on the old card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    // The draft is a real (if empty) store entry the instant the modal
    // opens — same as risks.ts's addRisk — so every field, including
    // whichever one is touched first, has something to attach to.
    expect(store.doc.teams[0]!.actionItems).toHaveLength(2)
    clickByTitleOrText(document.body, 'Close')

    expect(store.doc.teams[0]!.actionItems).toHaveLength(1) // empty draft silently discarded
    expect(document.activeElement).not.toBe(container.querySelector('[data-item-id="a"]'))
  })
})

test('the first card (To Do column) is focused as soon as the module opens', () => {
  const team = makeTeam({ actionItems: [item({ id: 'a', order: 0, status: 'todo' })] })
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  expect(document.activeElement).toBe(container.querySelector('[data-item-id="a"]'))
})

// Regression: a team switch remounts both panes in the same tick
// (PaneManager.renderAll's default renders pane 0 then pane 1), and this
// module has no idea it's mounting into the pane that ISN'T nav.focusedPane
// — without this guard, whichever pane happened to mount second (always
// pane 1) would silently steal focus from pane 0's card.
test('mounting into a pane that is not the focused pane does not steal focus', () => {
  const team = makeTeam({ actionItems: [item({ id: 'a', order: 0, status: 'todo' })] })
  const { container, store, pm, loc } = setup(team)
  store.updateNav((d) => { d.nav.focusedPane = 1 })
  render(container, loc, store, pm, 0) // mounting into pane 0, but pane 1 is focused

  expect(document.activeElement).not.toBe(container.querySelector('[data-item-id="a"]'))
})

// Grid arrow navigation across the board: Up/Down step within a column,
// Left/Right cross into the nearest card (by vertical position) in an
// adjacent, non-empty column.
describe('ArrowUp/Down/Left/Right card navigation', () => {
  test('ArrowDown/ArrowUp move focus within a column, and no-op at its ends', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'a', order: 0, status: 'todo' }), item({ id: 'b', order: 1, status: 'todo' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const [cardA, cardB] = cards(container)

    cardA!.focus()
    cardA!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(cardB)

    cardB!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(cardB) // last card in the column, no-op

    cardB!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(cardA)
  })

  test('ArrowRight crosses into the WIP column, skipping an empty To Do column on ArrowLeft back', () => {
    const team = makeTeam({ actionItems: [item({ id: 'w', order: 0, status: 'wip' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const card = cards(container)[0]!

    card.focus()
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(card) // To Do column is empty, no-op
  })

  test('ArrowLeft/ArrowRight land on the nearest card by vertical position in the adjacent column', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 't1', order: 0, status: 'todo' }),
        item({ id: 't2', order: 1, status: 'todo' }),
        item({ id: 'w1', order: 0, status: 'wip' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const t2 = container.querySelector('[data-item-id="t2"]') as HTMLElement
    const w1 = container.querySelector('[data-item-id="w1"]') as HTMLElement

    t2.focus()
    t2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(w1) // only card in WIP

    w1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    // jsdom lays out every element at rect.top === 0, so the "nearest by
    // vertical position" tie-break can't be distinguished here — this only
    // confirms landing on *a* card (the first, since ties keep the running
    // best) in the adjacent column rather than staying put or going nowhere.
    expect(document.activeElement).toBe(container.querySelector('[data-item-id="t1"]'))
  })

  // The document-level fallback: if the user clicked away entirely (focus
  // landed on document.body, not some other field) and then presses an
  // arrow key, the first card is selected instead of the keypress doing
  // nothing.
  test('any arrow key with nothing focused at all selects the first card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0, status: 'todo' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))

    expect(document.activeElement).toBe(container.querySelector('[data-item-id="a"]'))
  })
})

describe('renderActionItems — board', () => {
  test('renders cards into their status column, sorted by order', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'b', summary: 'B', order: 1, status: 'todo' }),
        item({ id: 'a', summary: 'A', order: 0, status: 'todo' }),
        item({ id: 'w', summary: 'W', order: 0, status: 'wip' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const todoCol = container.querySelectorAll('.tt-kanban-col')[0]!
    const titles = Array.from(todoCol.querySelectorAll('.tt-kanban-card-title')).map((n) => n.textContent)
    expect(titles).toEqual(['A', 'B'])
    expect(container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-card-title')!.textContent).toBe('W')
  })

  test('the WIP column header shows the column name plus its item count, refreshed on every render', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'w1', order: 0, status: 'wip' }),
        item({ id: 'w2', order: 1, status: 'wip' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const wipCol = container.querySelectorAll('.tt-kanban-col')[1]!
    const nameEl = wipCol.querySelector('.tt-kanban-col-name')!
    expect(nameEl.textContent).toBe('WIP (2)')

    // Count updates on the next render, same as the fixed-column headers.
    store.update((d) => {
      d.teams[0]!.actionItems.push(item({ id: 'w3', order: 2, status: 'wip' }))
    })
    expect(container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-col-name')!.textContent).toBe('WIP (3)')
  })

  test('shows an empty placeholder per column with no cards', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelectorAll('.tt-kanban-empty')).toHaveLength(4) // todo, wip, done, cancelled
  })

  test('an uncategorized card (color: null) renders with no color-X class', () => {
    const team = makeTeam({ actionItems: [item({ id: 'u', color: null })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const card = cards(container)[0]!
    expect(Array.from(card.classList).some((c) => c.startsWith('color-'))).toBe(false)
  })

  test('done/cancelled zone headers show a count', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'd1', status: 'done' }), item({ id: 'd2', status: 'done' }), item({ id: 'c1', status: 'cancelled' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const labels = container.querySelectorAll('.tt-kanban-zone-label')
    expect(labels[0]!.textContent).toContain('Done (2)')
    expect(labels[1]!.textContent).toContain('Cancelled (1)')
  })

  test('cancelled cards render with the cancelled status class', () => {
    const team = makeTeam({ actionItems: [item({ id: 'c1', status: 'cancelled' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(cards(container)[0]!.classList.contains('status-cancelled')).toBe(true)
  })

  test('an overdue todo card gets the overdue class on its due badge', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', dueDate: '2000-01-01', status: 'todo' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-kanban-card-due')!.classList.contains('overdue')).toBe(true)
  })

  test('a done card with a past due date is not overdue', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', dueDate: '2000-01-01', status: 'done' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-kanban-card-due')!.classList.contains('overdue')).toBe(false)
  })

  test('card carries data-item-id for search/@ref navigation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'zz' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(cards(container)[0]!.getAttribute('data-item-id')).toBe('zz')
  })

  test('a defensive no-op when loc.ref.kind is not "actions"', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm } = setup(team)
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'members' } }
    render(container, wrongLoc, store, pm)
    expect(container.children).toHaveLength(0)
  })

  test('double render into the same container disposes the previous store subscription', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)
    expect(() => store.update((d) => { d.teams[0]!.actionItems[0]!.summary = 'A2' })).not.toThrow()
    expect(cards(container)).toHaveLength(1)
  })

  const assigneeInput = (): HTMLInputElement => document.querySelector('.tt-kanban-form-row .tt-assignee-input') as HTMLInputElement
  const assigneeToggle = (): HTMLButtonElement => document.querySelector('.tt-kanban-form-row .tt-assignee-toggle') as HTMLButtonElement
  const assigneeMenuRows = (): string[] =>
    Array.from(document.querySelectorAll('.tt-kanban-form-row .tt-assignee-menu .tt-atref-item')).map((r) => r.textContent ?? '')
  const assigneeMenuHeaders = (): string[] =>
    Array.from(document.querySelectorAll('.tt-kanban-form-row .tt-assignee-menu .tt-atref-group-header')).map((h) => h.textContent ?? '')

  test('opening the assignee picker lists stakeholders and members in labelled groups with their icons', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card') // To Do column's add button (first in DOM order)
    assigneeToggle().click()

    expect(assigneeMenuHeaders()).toEqual(['🧑‍💼 Stakeholders', '👥 Members'])
    expect(assigneeMenuRows()).toEqual(['Carla', 'Bruno'])
  })

  test('the assignee picker opens the full people list even when the input already holds text', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', assignee: 'Some outside vendor' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    expect(assigneeInput().value).toBe('Some outside vendor')
    assigneeToggle().click()

    expect(assigneeMenuRows()).toEqual(['Carla', 'Bruno'])
  })

  test('typing in the assignee input filters the picker to matching people', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const input = assigneeInput()
    input.value = 'car'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(assigneeMenuRows()).toEqual(['Carla'])
    expect(assigneeMenuHeaders()).toEqual(['🧑‍💼 Stakeholders'])
  })

  test('picking a person from the assignee picker commits a live reference and shows the chip', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    assigneeToggle().click()
    Array.from(document.querySelectorAll<HTMLElement>('.tt-kanban-form-row .tt-assignee-menu .tt-atref-item'))
      .find((r) => r.textContent === 'Bruno')!
      .click()

    expect(store.doc.teams[0]!.actionItems[0]!.assignee).toBe('@[Bruno](person:mem-1)')
    expect(document.querySelector('.tt-kanban-form-row .tt-kanban-assignee-chip')?.textContent).toContain('Bruno')
  })

  test('ArrowDown opens the picker and Enter picks the highlighted person without closing the modal', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    const input = assigneeInput()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    expect(store.doc.teams[0]!.actionItems[0]!.assignee).toBe('@[Bruno](person:mem-1)')
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull()
  })

  test('Escape closes the assignee picker but leaves the modal open', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    assigneeToggle().click()
    expect(document.querySelector('.tt-kanban-form-row .tt-assignee-menu')).not.toBeNull()

    assigneeInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(document.querySelector('.tt-kanban-form-row .tt-assignee-menu')).toBeNull()
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull()
  })

  test('a backlink chip renders in the card meta row when another field mentions this action item', () => {
    const team = makeTeam()
    team.actionItems.push(item({ id: 'a1', summary: 'Ship it' }))
    team.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Beta', done: false, followup: 'Depends on @[Ship it](action:a1)' })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const chip = container.querySelector('[data-item-id="a1"] .tt-backlinks-chip')
    expect(chip?.textContent).toBe('↩ 1')
  })

  test('no chip when nothing mentions this action item', () => {
    const team = makeTeam()
    team.actionItems.push(item({ id: 'a1', summary: 'Ship it' }))
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('[data-item-id="a1"] .tt-backlinks-chip')).toBeNull()
  })

  test('a store update scoped only to "risks" still rebuilds the board and reveals the new chip — proves the widened WATCHED list (not a same-section update) drives the rebuild', () => {
    const team = makeTeam()
    team.actionItems.push(item({ id: 'a1', summary: 'Ship it' }))
    team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('[data-item-id="a1"] .tt-backlinks-chip')).toBeNull()

    store.update((d) => {
      const risk = d.teams[0]!.risks.find((r) => r.id === 'r1')!
      risk.followup = '@[Ship it](action:a1)'
    }, { teamId: 'T1', sections: ['risks'] })

    const chip = container.querySelector('[data-item-id="a1"] .tt-backlinks-chip')
    expect(chip?.textContent).toBe('↩ 1')
  })
})

describe('renderActionItems — edit modal', () => {
  test('"+ Card" in To Do creates a card in the todo column with the entered fields', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 1)) // Aug 1, 2026 — the date picker opens on "today"'s month when empty
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    setValue(summaryInput, 'New task')
    pickDate(1)
    // Scoped to the modal form: the toolbar's filter chips now share the
    // .tt-kanban-color-chip class (same square swatch pattern), so an
    // unscoped query would also match those. Selected by color class, not
    // position, so the chip display order (COLORS in action-items.ts) is
    // free to change without breaking this.
    ;(document.querySelector('.tt-kanban-form .tt-kanban-color-chip.color-sage') as HTMLButtonElement).click()

    clickByTitleOrText(document.body, 'Close')

    const created = store.doc.teams[0]!.actionItems[0]!
    expect(created.summary).toBe('New task')
    expect(created.status).toBe('todo')
    expect(created.dueDate).toBe('2026-08-01')
    expect(created.color).toBe('sage')
  })

  test('"+ Card" in WIP creates a card in the wip column', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const wipAddBtn = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === '+ Card')[1]!
    wipAddBtn.click()
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    setValue(summaryInput, 'WIP task')
    ;(document.querySelector('.tt-kanban-form .tt-kanban-color-chip.color-sage') as HTMLButtonElement).click()
    clickByTitleOrText(document.body, 'Close')

    expect(store.doc.teams[0]!.actionItems[0]!.status).toBe('wip')
  })

  test('leaving summary blank and closing discards the draft silently — no error, no confirmation', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    clickByTitleOrText(document.body, 'Close')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-field-error')).toBeNull()
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('a new card with notes but no name will not close — the modal stays, the name field takes focus, a hint shows', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    const editorEl = document.querySelector('.tt-kanban-form .editor') as HTMLElement
    setBlockText(editorEl, 'A note I do not want to lose')
    fireInput(editorEl)
    vi.advanceTimersByTime(400)

    clickByTitleOrText(document.body, 'Close')

    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull() // still open
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1) // not discarded
    expect(document.querySelector('.tt-kanban-form .tt-field-error')?.textContent).toBeTruthy()
    expect(document.activeElement).toBe(document.querySelector('.tt-kanban-form input[type="text"]'))

    setValue(document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement, 'named') // let afterEach close it
    clickByTitleOrText(document.body, 'Close')
  })

  test('once a name is entered the blocked card closes normally and keeps its notes', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    const editorEl = document.querySelector('.tt-kanban-form .editor') as HTMLElement
    setBlockText(editorEl, 'Keep me')
    fireInput(editorEl)
    vi.advanceTimersByTime(400)
    clickByTitleOrText(document.body, 'Close') // blocked

    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    setValue(summaryInput, 'Now named')
    expect(document.querySelector('.tt-kanban-form .tt-field-error')?.textContent).toBeFalsy() // hint cleared
    clickByTitleOrText(document.body, 'Close')

    expect(document.querySelector('.tt-kanban-form')).toBeNull() // closed
    expect(store.doc.teams[0]!.actionItems[0]!.summary).toBe('Now named')
    expect(store.doc.teams[0]!.actionItems[0]!.notes).toBe('Keep me')
  })

  test('a new card with only a due date picked cannot be closed nameless either', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 1))
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    pickDate(10)
    clickByTitleOrText(document.body, 'Close')

    expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)

    setValue(document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement, 'named') // let afterEach close it
    clickByTitleOrText(document.body, 'Close')
  })

  test('the Delete button on an existing card edited down to blank still closes (not blocked)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Had a name', notes: 'has notes' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    setValue(document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement, '')
    clickByTitleOrText(document.body, 'Delete')

    expect(document.querySelector('.tt-kanban-form')).toBeNull()
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })

  test('a new card starts with no color chip pre-selected', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    const chips = document.querySelectorAll('.tt-kanban-form .tt-kanban-color-chip')
    expect(chips.length).toBeGreaterThan(0)
    expect(Array.from(chips).some((c) => c.classList.contains('selected'))).toBe(false)
  })

  test('closing a new card without picking a color leaves it uncategorized (color: null)', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    setValue(summaryInput, 'No color yet')
    clickByTitleOrText(document.body, 'Close')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
    expect(store.doc.teams[0]!.actionItems[0]!.color).toBeNull()
  })

  // Regression: removeItem/clearZone never renumber the remaining cards'
  // `order` after a delete, so a status group can end up with a gap (e.g.
  // orders [0, 2]). The next card added to that group must not collide with
  // an existing order value.
  test('adding a card to a group with a gap in its order values does not collide with an existing card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 }), item({ id: 'c', order: 2 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    setValue(summaryInput, 'New one')
    clickByTitleOrText(document.body, 'Close')

    const orders = store.doc.teams[0]!.actionItems.map((i) => i.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  test('clicking an existing card\'s already-selected color chip again unsets it — live, with no Save needed', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', color: 'rust' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    const rustChip = document.querySelector('.tt-kanban-form .tt-kanban-color-chip.color-rust') as HTMLButtonElement
    expect(rustChip.classList.contains('selected')).toBe(true)
    rustChip.click()
    expect(rustChip.classList.contains('selected')).toBe(false)

    expect(store.doc.teams[0]!.actionItems[0]!.color).toBeNull()
  })

  test('editing an existing card keeps its color pre-selected', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', color: 'plum' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const plumChip = document.querySelector('.tt-kanban-form .tt-kanban-color-chip.color-plum')!
    expect(plumChip.classList.contains('selected')).toBe(true)
  })

  test('editing an existing card via dblclick pre-fills fields, and the edit persists live — no Save needed', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Old', dueDate: '2026-01-01', assignee: 'Bruno', color: 'rust' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    expect(summaryInput.value).toBe('Old')
    setValue(summaryInput, 'New')

    expect(store.doc.teams[0]!.actionItems[0]!.summary).toBe('New')
  })

  test('the pencil icon opens the same edit modal as dblclick', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, 'Double-click or use ✎ to edit')
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull()
  })

  test('the edit modal\'s Delete button closes it and opens the confirm-delete flow', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull()

    clickByTitleOrText(document.body, 'Delete')
    expect(document.querySelector('.tt-kanban-form')).toBeNull()
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')

    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })

  test('canceling the delete confirmation keeps the card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    clickByTitleOrText(document.body, 'Delete')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
  })

  test('deleting an action item unlinks every reference to it across the team\'s notes', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'a1', summary: 'Fix bug' }),
        item({ id: 'a2', summary: 'Other', order: 1, notes: 'see @[Fix bug](action:a1) for details' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA1 = cards(container).find((c) => c.getAttribute('data-item-id') === 'a1')!
    cardA1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    clickByTitleOrText(document.body, 'Delete')
    clickByTitleOrText(document.body, 'Delete')

    const remaining = store.doc.teams[0]!.actionItems
    expect(remaining.map((i) => i.id)).toEqual(['a2'])
    expect(remaining[0]!.notes).toBe('see ~Fix bug~ for details')
  })

  test('deleting a card whose summary is blank removes it immediately with no confirmation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: '' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('renaming a milestone mentioned in the open modal\'s notes live-updates its @mention chip', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'a', summary: 'Old', notes: 'See @[Old Title](milestone:m1)' })],
      milestones: [{ id: 'm1', date: '2026-01-01', title: 'Old Title', done: false, followup: '' }],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const chip = document.querySelector<HTMLAnchorElement>('a.ref[data-ref="milestone:m1"]')!
    expect(chip.textContent).toBe('@Old Title')

    store.update((d) => {
      d.teams[0]!.milestones.find((m) => m.id === 'm1')!.title = 'New Title'
    }, { teamId: 'T1', sections: ['milestones'] })

    expect(document.querySelector<HTMLAnchorElement>('a.ref[data-ref="milestone:m1"]')?.textContent).toBe('@New Title')
  })
})

describe('renderActionItems — edit modal live persistence', () => {
  test('due date and assignee commit to the store as soon as they change, with the modal still open', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    pickDate(15)
    setValue(document.querySelector('.tt-kanban-form-row .tt-assignee-input') as HTMLInputElement, 'Something else')

    const updated = store.doc.teams[0]!.actionItems[0]!
    expect(updated.assignee).toBe('Something else')
    expect(updated.dueDate).toMatch(/-15$/)
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull() // still open — no Save/close needed
  })

  test('notes commit to the store as they\'re typed, via the same debounced onChange risks.ts\'s follow-up editor uses', () => {
    vi.useFakeTimers()
    const team = makeTeam({ actionItems: [item({ id: 'a', notes: '' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    const editorEl = document.querySelector('.tt-kanban-form .editor') as HTMLElement
    setBlockText(editorEl, 'Talked to vendor today')
    fireInput(editorEl)
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.actionItems[0]!.notes).toBe('Talked to vendor today')
  })
})

describe('renderActionItems — assignee reference chip', () => {
  test('committing text that exactly matches an existing person turns the field into a live reference chip', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    setValue(document.querySelector('.tt-kanban-form-row .tt-assignee-input') as HTMLInputElement, 'Carla')

    expect(store.doc.teams[0]!.actionItems[0]!.assignee).toBe('@[Carla](person:stk-1)')
    const chip = document.querySelector('.tt-kanban-form-row .tt-kanban-assignee-chip')
    expect(chip?.textContent).toContain('Carla')
    expect(document.querySelector('.tt-kanban-form-row .tt-assignee-input')).toBeNull() // input replaced by the chip
  })

  test('the chip shows the person\'s live name, updating in place when the person is renamed elsewhere while the modal stays open', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', assignee: '@[Carla](person:stk-1)' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    expect(document.querySelector('.tt-kanban-form-row .tt-kanban-assignee-chip')?.textContent).toContain('Carla')

    store.update((d) => { d.teams[0]!.stakeholders[0]!.name = 'Carla Renamed' }, { teamId: 'T1', sections: ['people'] })

    expect(document.querySelector('.tt-kanban-form-row .tt-kanban-assignee-chip')?.textContent).toContain('Carla Renamed')
  })

  test('clicking the chip\'s clear button unlinks it back to an empty, editable input', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', assignee: '@[Carla](person:stk-1)' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    const clearBtn = document.querySelector<HTMLButtonElement>('.tt-kanban-form-row .tt-kanban-assignee-clear')!
    clearBtn.click()

    expect(store.doc.teams[0]!.actionItems[0]!.assignee).toBe('')
    expect(document.querySelector('.tt-kanban-form-row .tt-kanban-assignee-chip')).toBeNull()
    expect((document.querySelector('.tt-kanban-form-row .tt-assignee-input') as HTMLInputElement).value).toBe('')
  })

  test('the chip\'s name/icon is not interactive — the clear button is its only clickable control', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', assignee: '@[Carla](person:stk-1)' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '✎')
    const chip = document.querySelector<HTMLElement>('.tt-kanban-form-row .tt-kanban-assignee-chip')!
    expect(chip.querySelectorAll('button')).toHaveLength(1)
    expect(chip.querySelector('button')?.classList.contains('tt-kanban-assignee-clear')).toBe(true)
    expect(pm.calls).toEqual([]) // opening the modal itself never navigates
  })

  test('a card whose assignee is a live person reference shows the person icon and current name in the card meta row', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', assignee: '@[Carla](person:stk-1)' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const assigneeEl = container.querySelector('.tt-kanban-card-assignee')!
    expect(assigneeEl.textContent).toBe('🧑 Carla')
  })

  test('deleting the referenced person turns the assignee into a muted plain marker on the card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', assignee: '~Carla~' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const assigneeEl = container.querySelector('.tt-kanban-card-assignee')!
    expect(assigneeEl.textContent).toBe('Carla')
  })
})

describe('renderActionItems — expand mode and the header save-state pill', () => {
  function openModal(container: HTMLElement): void {
    clickByTitleOrText(container, '✎')
  }

  test('the expand button starts collapsed, with the mini save-state pill hidden', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    openModal(container)

    const dialog = document.querySelector('.tt-modal-dialog')!
    const pill = dialog.querySelector<HTMLElement>('.tt-save-pill')!
    expect(dialog.classList.contains('tt-kanban-expanded')).toBe(false)
    // Not `.hidden`: `.tt-save-pill`'s own `display: inline-flex` rule beats
    // the low-specificity UA `[hidden]` rule, so the pill is hidden via
    // `style.display` directly instead — see action-items.ts's comment.
    expect(pill.style.display).toBe('none')
  })

  test('clicking expand grows the dialog and reveals the mini pill; clicking again restores it', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    openModal(container)

    const dialog = document.querySelector('.tt-modal-dialog')!
    const expandBtn = dialog.querySelector<HTMLButtonElement>('.tt-kanban-expand-btn')!
    const pill = dialog.querySelector<HTMLElement>('.tt-save-pill')!

    expandBtn.click()
    expect(dialog.classList.contains('tt-kanban-expanded')).toBe(true)
    expect(pill.style.display).not.toBe('none')

    expandBtn.click()
    expect(dialog.classList.contains('tt-kanban-expanded')).toBe(false)
    expect(pill.style.display).toBe('none')
  })

  test('the mini pill mirrors whatever ctx.saveStatus broadcasts, including after the state changes', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    const fake = fakeSaveStatus()
    render(container, loc, store, pm, 0, fake.api)
    openModal(container)
    document.querySelector<HTMLButtonElement>('.tt-kanban-expand-btn')!.click()

    const pillText = document.querySelector('.tt-save-pill-text')!
    expect(pillText.textContent).toBe('Saved') // fakeSaveStatus's immediate subscribe() callback

    fake.emit({ state: 'dirty', label: 'Unsaved', title: 'Unsaved changes' })
    expect(pillText.textContent).toBe('Unsaved')
    expect(document.querySelector('.tt-save-pill')!.getAttribute('data-state')).toBe('dirty')
  })

  test('clicking the mini pill triggers ctx.saveStatus.requestSaveNow(), the same explicit-save action Ctrl+S uses', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    const fake = fakeSaveStatus()
    render(container, loc, store, pm, 0, fake.api)
    openModal(container)
    document.querySelector<HTMLButtonElement>('.tt-kanban-expand-btn')!.click()

    document.querySelector<HTMLElement>('.tt-save-pill')!.click()
    expect(fake.requestCount()).toBe(1)
  })

  test('closing the modal unsubscribes from saveStatus, same as the container disposer would if the module unmounted mid-edit', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    const fake = fakeSaveStatus()
    render(container, loc, store, pm, 0, fake.api)
    openModal(container)
    expect(fake.subscriberCount()).toBe(1)

    clickByTitleOrText(document.body, 'Close')
    expect(fake.subscriberCount()).toBe(0)
  })

  test('unmounting the module while the modal is still open also unsubscribes (double-mount disposer path)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    const fake = fakeSaveStatus()
    render(container, loc, store, pm, 0, fake.api)
    openModal(container)
    expect(fake.subscriberCount()).toBe(1)

    container.innerHTML = '' // mirrors panes.ts's renderBody clearing the container before re-invoking the renderer
    render(container, loc, store, pm, 0, fake.api)
    expect(fake.subscriberCount()).toBe(0)
  })
})

// Landing on a Tasks search result is handled generically now, not by this
// module: search-ui.ts's commit() resolves the matched card via
// `[data-item-id]` and search-highlight.ts's applySearchHighlight() gives it
// real focus (see that file's own tests) — which is enough on its own,
// since the card's existing Enter handler (tested above, under "keyboard
// route to the card actions") already opens the modal from a focused card.
// No SEARCH_FOCUS_ITEM_EVENT listener needed here — see the comment on that
// in action-items.ts itself.

describe('renderActionItems — zone clear-all', () => {
  test('zone trash clears all cards in that zone after confirmation', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'd1', status: 'done' }), item({ id: 'd2', status: 'done' }), item({ id: 'c1', status: 'cancelled' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Clear cards') // first zone-trash button = Done zone
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete all 2 cards in this area?')
    clickByTitleOrText(document.body, 'Delete all')

    expect(store.doc.teams[0]!.actionItems.filter((i) => i.status === 'done')).toHaveLength(0)
    expect(store.doc.teams[0]!.actionItems.filter((i) => i.status === 'cancelled')).toHaveLength(1)
  })

  test('zone trash is a no-op on an empty zone (no modal opens)', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, 'Clear cards')
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('canceling clear-zone keeps the cards', () => {
    const team = makeTeam({ actionItems: [item({ id: 'd1', status: 'done' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, 'Clear cards')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
  })

  test('clearing a zone unlinks references to every removed card across the team\'s notes', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'd1', status: 'done', summary: 'Done thing' }),
        item({ id: 'todo1', status: 'todo', notes: 'follows up on @[Done thing](action:d1)' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Clear cards') // first zone-trash button = Done zone
    clickByTitleOrText(document.body, 'Delete all')

    const remaining = store.doc.teams[0]!.actionItems
    expect(remaining.map((i) => i.id)).toEqual(['todo1'])
    expect(remaining[0]!.notes).toBe('follows up on ~Done thing~')
  })
})

describe('renderActionItems — edit tags modal (toolbar)', () => {
  // Finds the naming row whose swatch carries `color-${color}`.
  function nameRowInput(color: string): HTMLInputElement {
    const row = Array.from(document.querySelectorAll('.tt-kanban-color-name-row')).find((r) => r.querySelector(`.color-${color}`))
    if (!row) throw new Error(`no color-name row for color "${color}"`)
    return row.querySelector('input') as HTMLInputElement
  }
  function openTagsModal(container: HTMLElement): void {
    clickByTitleOrText(container, 'Edit tags')
  }

  test('the toolbar has an "Edit tags" button, right-aligned as the last element (no card-modal entry point anymore)', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const toolbar = container.querySelector('.tt-kanban-toolbar')!
    const btn = toolbar.querySelector('.tt-kanban-edit-tags-btn')!
    expect(btn.textContent).toBe('Edit tags')
    expect(toolbar.lastElementChild).toBe(btn) // right-aligned via margin-left: auto
  })

  test('a card\'s color picker no longer offers a way to edit tag names', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    expect(document.querySelector('.tt-kanban-color-names-btn')).toBeNull()
  })

  test('opens a modal with one row per color, square swatches and no generic-name text — pre-filled from actionTagNames', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    openTagsModal(container)
    expect(document.querySelectorAll('.tt-kanban-color-name-row')).toHaveLength(6)
    const rustSwatch = document.querySelector('.tt-kanban-color-name-row .color-rust')!
    expect(rustSwatch.textContent?.trim()).toBe('')
    expect(nameRowInput('rust').value).toBe('Blocked')
    expect(nameRowInput('slate').value).toBe('')
  })

  test('all six colors suggest a starter category name as the placeholder', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    openTagsModal(container)
    expect(nameRowInput('rust').placeholder).toBe('Process')
    expect(nameRowInput('brass').placeholder).toBe('People')
    expect(nameRowInput('slate').placeholder).toBe('Financial')
    expect(nameRowInput('sage').placeholder).toBe('Technical')
    expect(nameRowInput('plum').placeholder).toBe('Operations')
    expect(nameRowInput('ledger').placeholder).toBe('Legal')
  })

  test('saving writes trimmed, non-empty names into actionTagNames', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    openTagsModal(container)
    nameRowInput('rust').value = '  Blocked  '
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })

  test('clearing a name back to empty removes that key instead of storing an empty string', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked', plum: 'Urgent' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    openTagsModal(container)
    nameRowInput('rust').value = ''
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ plum: 'Urgent' })
  })

  test('canceling leaves actionTagNames untouched', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    openTagsModal(container)
    nameRowInput('rust').value = 'Something else'
    clickByTitleOrText(document.body, 'Cancel')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })
})

describe('renderActionItems — custom columns: add + rename', () => {
  test('"+ Add column" appends a new middle column, focused for immediate rename', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Column')

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(2)
    const added = store.doc.teams[0]!.actionColumns![1]!
    expect(added.name).toBe('New column')
    // Every middle column carries its own (hidden-unless-active) rename
    // input — makeTeam()'s default "WIP" column has one too — so the new
    // column's input is the last one in DOM order, not the first match.
    const inputs = document.querySelectorAll<HTMLInputElement>('.tt-kanban-col-rename-input')
    const input = inputs[inputs.length - 1]
    expect(document.activeElement).toBe(input)
  })

  test('a new column always lands at the right end of the middle zone', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Column')

    // Middle-column headers carry a live "(n)" item count (see
    // middleNameSpans in action-items.ts) alongside the name — asserting the
    // raw name here would false-fail against that existing behavior.
    const names = Array.from(container.querySelectorAll('.tt-kanban-col-name')).map((n) => n.textContent)
    expect(names).toEqual(['WIP (0)', 'New column (0)'])
  })

  test('clicking a column name switches it to an editable input pre-filled with the current name', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    expect(input.value).toBe('WIP')
  })

  test('blurring the rename input commits the new name to the store', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    input.value = 'In Review'
    input.dispatchEvent(new Event('blur'))

    expect(store.doc.teams[0]!.actionColumns![0]!.name).toBe('In Review')
  })

  test('Enter in the rename input blurs it, committing the same way', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    input.value = 'In Review'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.doc.teams[0]!.actionColumns![0]!.name).toBe('In Review')
  })

  test('committing an empty name reverts to the previous name instead of storing blank', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-kanban-col-name') as HTMLElement).click()
    const input = document.querySelector('.tt-kanban-col-rename-input') as HTMLInputElement
    input.value = '   '
    input.dispatchEvent(new Event('blur'))

    expect(store.doc.teams[0]!.actionColumns![0]!.name).toBe('WIP')
  })
})

describe('renderActionItems — custom columns: delete', () => {
  function deleteColumnBtn(container: HTMLElement, index = 0): HTMLButtonElement {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.tt-kanban-col-delete-btn'))[index]!
  }

  test('deletes an empty column immediately, with no confirmation', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('a non-empty column opens a landing-column picker instead of deleting immediately', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'wip' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(1) // not deleted yet
    expect(document.querySelector('.tt-modal-dialog')).not.toBeNull()
    const options = Array.from(document.querySelectorAll<HTMLOptionElement>('.tt-kanban-column-landing-select option')).map((o) => o.textContent)
    expect(options).toEqual(['To Do', 'Done', 'Cancelled']) // every column except the one being deleted
  })

  test('confirming the landing picker moves every card in the deleted column to the chosen target, then removes the column', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'a', status: 'wip', order: 0 }), item({ id: 'b', status: 'wip', order: 1 })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()
    const select = document.querySelector('.tt-kanban-column-landing-select') as HTMLSelectElement
    select.value = 'todo'
    // Scoped to the dialog, not document.body: the column header's own
    // trash-icon button shares this exact label text (both route through
    // kanban_delete_column_title/_btn — see i18n.ts), and it sits earlier in
    // DOM order, so a body-wide clickByTitleOrText would hit it instead of
    // the modal's confirm button.
    clickByTitleOrText(document.querySelector('.tt-modal-dialog')!, 'Delete column')

    const items = store.doc.teams[0]!.actionItems
    expect(items.every((i) => i.status === 'todo')).toBe(true)
    expect(new Set(items.map((i) => i.order)).size).toBe(2) // appended past destination's highest order, no collision
    expect(store.doc.teams[0]!.actionColumns).toHaveLength(0)
  })

  test('canceling the landing picker keeps the column and its cards untouched', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'wip' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    deleteColumnBtn(container).click()
    clickByTitleOrText(document.body, 'Cancel')

    expect(store.doc.teams[0]!.actionColumns).toHaveLength(1)
    expect(store.doc.teams[0]!.actionItems[0]!.status).toBe('wip')
  })
})

describe('renderActionItems — tag display and filter', () => {
  // Finds the chip/badge carrying `color-${color}` — avoids relying on
  // visible text, which is now blank for colors without a custom name.
  function chipByColor(container: ParentNode, selector: string, color: string): HTMLElement {
    const found = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((c) => c.classList.contains(`color-${color}`))
    if (!found) throw new Error(`no "${selector}" for color "${color}"`)
    return found
  }

  test('a "Filter:" label sits to the left of the tag chips', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const toolbar = container.querySelector('.tt-kanban-toolbar')!
    const label = toolbar.querySelector('.tt-kanban-filter-label')!
    expect(label.textContent).toBe('Filter:')
    // Precedes the chips row in DOM order — reads left-to-right in the toolbar.
    expect(label.compareDocumentPosition(toolbar.querySelector('.tt-kanban-tag-chips')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('a card shows a tag badge only when its color has a custom name; unnamed colors get no badge', () => {
    const team = makeTeam({
      actionTagNames: { rust: 'Blocked' },
      actionItems: [item({ id: 'a', color: 'rust' }), item({ id: 'b', color: 'slate' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA = cards(container).find((c) => c.getAttribute('data-item-id') === 'a')!
    const cardB = cards(container).find((c) => c.getAttribute('data-item-id') === 'b')!
    expect(cardA.querySelector('.tt-kanban-card-tag')?.textContent).toBe('Blocked')
    expect(cardB.querySelector('.tt-kanban-card-tag')).toBeNull()
  })

  test('renders one filter chip per color; only custom-named colors show visible text, unnamed ones stay blank with an aria-label', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const rustChip = chipByColor(container, '.tt-kanban-tag-chip', 'rust')
    const slateChip = chipByColor(container, '.tt-kanban-tag-chip', 'slate')
    expect(rustChip.classList.contains('tt-kanban-color-chip')).toBe(true) // same square swatch pattern as the modal's color picker
    expect(rustChip.textContent?.trim()).toBe('Blocked')
    expect(slateChip.textContent?.trim()).toBe('')
    expect(slateChip.getAttribute('aria-label')).toBe('Financial') // slate is one of the suggested starter names
  })

  test('an unnamed chip shows its count too — the swatch carries the number, just not a name', () => {
    const team = makeTeam({
      actionTagNames: { rust: 'Blocked' },
      actionItems: [
        item({ id: 'a', color: 'rust', status: 'todo' }),
        item({ id: 'b', color: 'slate', status: 'todo' }),
        item({ id: 'c', color: 'slate', status: 'wip' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    // slate has no name but two open cards — the count is exactly what tells
    // you whether clicking the swatch is worth the trip.
    const slateChip = chipByColor(container, '.tt-kanban-tag-chip', 'slate')
    expect(slateChip.querySelector('.tt-kanban-tag-chip-count')?.textContent).toBe('2')
    expect(slateChip.textContent?.trim()).toBe('2') // count only, no name

    const rustChip = chipByColor(container, '.tt-kanban-tag-chip', 'rust')
    expect(rustChip.querySelector('.tt-kanban-tag-chip-count')?.textContent).toBe('1')
    expect(rustChip.textContent?.trim()).toBe('Blocked1')
  })

  // An unnamed color is still a perfectly good thing to filter by — the
  // swatch identifies it. Naming lives behind the "Edit tags" button only.
  test('an unnamed chip filters by its color like any other, and does not open Edit tags', () => {
    const team = makeTeam({
      actionTagNames: { rust: 'Blocked' },
      actionItems: [item({ id: 'a', color: 'rust' }), item({ id: 'b', color: 'slate' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    chipByColor(container, '.tt-kanban-tag-chip', 'slate').click()

    expect(document.querySelector('.tt-kanban-color-name-rows')).toBeNull()
    expect(cards(container).map((c) => c.getAttribute('data-item-id'))).toEqual(['b'])
    expect(chipByColor(container, '.tt-kanban-tag-chip', 'slate').classList.contains('selected')).toBe(true)
  })

  test('named chips carry the number of open cards they would filter to', () => {
    const team = makeTeam({
      actionTagNames: { rust: 'Blocked' },
      actionItems: [
        item({ id: 'a', color: 'rust', status: 'todo' }),
        item({ id: 'b', color: 'rust', status: 'wip' }),
        // Done and cancelled cards are deliberately not counted: a chip
        // reading "Blocked 3" where one is already done answers nothing.
        item({ id: 'c', color: 'rust', status: 'done' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const rustChip = chipByColor(container, '.tt-kanban-tag-chip', 'rust')
    expect(rustChip.querySelector('.tt-kanban-tag-chip-count')?.textContent).toBe('2')
  })

  test('creating a card whose color differs from the active filter clears the filter, so the new card is guaranteed visible', () => {
    const team = makeTeam({ actionItems: [item({ id: 'old', color: 'slate' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    chipByColor(container, '.tt-kanban-tag-chip', 'slate').click() // filter to slate
    expect(cards(container).map((c) => c.getAttribute('data-item-id'))).toEqual(['old'])

    clickByTitleOrText(container, '+ Card')
    setValue(document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement, 'New task')
    ;(document.querySelector('.tt-kanban-form .tt-kanban-color-chip.color-rust') as HTMLButtonElement).click()
    clickByTitleOrText(document.body, 'Close')

    expect(cards(container)).toHaveLength(2)
    expect(chipByColor(container, '.tt-kanban-tag-chip', 'slate').classList.contains('selected')).toBe(false)
  })

  test('creating a card whose color matches the active filter leaves the filter in place', () => {
    const team = makeTeam({ actionItems: [item({ id: 'old', color: 'slate' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    chipByColor(container, '.tt-kanban-tag-chip', 'slate').click() // filter to slate

    clickByTitleOrText(container, '+ Card')
    setValue(document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement, 'New slate task')
    ;(document.querySelector('.tt-kanban-form .tt-kanban-color-chip.color-slate') as HTMLButtonElement).click()
    clickByTitleOrText(document.body, 'Close')

    expect(cards(container)).toHaveLength(2) // both slate cards still shown
    expect(chipByColor(container, '.tt-kanban-tag-chip', 'slate').classList.contains('selected')).toBe(true)
  })

  test('clicking a chip filters cards to that color across all columns; clicking again clears it', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'rust-1', color: 'rust', status: 'todo' }),
        item({ id: 'slate-1', color: 'slate', status: 'todo' }),
        item({ id: 'rust-2', color: 'rust', status: 'done' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    // renderTagChips() rebuilds .tt-kanban-tag-chip nodes from scratch on
    // every renderAll() (i.e. after every click), so a chip reference held
    // across a click goes stale (detached node, frozen class list from
    // before the click) — re-query by color each time instead of reusing one handle.
    function findRustChip(): HTMLButtonElement {
      return chipByColor(container, '.tt-kanban-tag-chip', 'rust') as HTMLButtonElement
    }

    findRustChip().click()

    expect(cards(container).map((c) => c.getAttribute('data-item-id')).sort()).toEqual(['rust-1', 'rust-2'])
    expect(findRustChip().classList.contains('selected')).toBe(true)

    findRustChip().click()
    expect(cards(container)).toHaveLength(3)
    expect(findRustChip().classList.contains('selected')).toBe(false)
  })

  test('the Done/Cancelled zone-label counts stay unfiltered while a tag filter is active', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'd1', color: 'rust', status: 'done' }),
        item({ id: 'd2', color: 'slate', status: 'done' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const rustChip = chipByColor(container, '.tt-kanban-tag-chip', 'rust') as HTMLButtonElement
    rustChip.click()

    expect(container.querySelector('.tt-kanban-zone-label')!.textContent).toContain('Done (2)')
    expect(cards(container)).toHaveLength(1) // only the rust card is drawn
  })
})

describe('renderActionItems — color chip labels in the edit modal', () => {
  test('color chips show their custom tag name once assigned, and stay blank (with an aria-label) otherwise', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const chips = Array.from(document.querySelectorAll('.tt-kanban-form .tt-kanban-color-chip'))
    const rustChip = chips.find((c) => c.classList.contains('color-rust'))!
    const slateChip = chips.find((c) => c.classList.contains('color-slate'))!

    expect(rustChip.textContent?.trim()).toBe('Blocked')
    expect(slateChip.textContent?.trim()).toBe('')
    expect(slateChip.getAttribute('aria-label')).toBe('Financial') // slate is one of the suggested starter names
  })
})

describe('renderActionItems — drag and drop', () => {
  test('dragstart on a card shows the floating trash zone; dragend hides it', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const card = cards(container)[0]!
    const trash = container.querySelector('.tt-kanban-trash')!
    expect(trash.classList.contains('active')).toBe(false)
    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(trash.classList.contains('active')).toBe(true)
    card.dispatchEvent(new Event('dragend', { bubbles: true }))
    expect(trash.classList.contains('active')).toBe(false)
  })

  test('dropping a card on the WIP column body moves it to wip, appended at the end', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'w', status: 'wip', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA = cards(container)[0]!
    const wipBody = container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-col-body')!
    cardA.dispatchEvent(new Event('dragstart', { bubbles: true }))
    wipBody.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    const updated = store.doc.teams[0]!.actionItems.find((i) => i.id === 'a')!
    expect(updated.status).toBe('wip')
    expect(itemsByStatus(store.doc.teams[0]!.actionItems, 'wip').map((i) => i.id)).toEqual(['w', 'a'])
  })

  test('a successful drop hides the floating trash zone immediately, without waiting for dragend (the store rebuild can detach the drag source before dragend fires in a real browser)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'w', status: 'wip', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA = cards(container)[0]!
    const wipBody = container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-col-body')!
    const trash = container.querySelector('.tt-kanban-trash')!
    cardA.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(trash.classList.contains('active')).toBe(true)
    wipBody.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    // No dragend dispatched here on purpose.
    expect(trash.classList.contains('active')).toBe(false)
  })

  test('dropping a card directly onto another card moves it into that card\'s zone (jsdom has no real layout, so it always lands "after")', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'd', status: 'done', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardA = cards(container).find((c) => c.getAttribute('data-item-id') === 'a')!
    const cardD = cards(container).find((c) => c.getAttribute('data-item-id') === 'd')!
    cardA.dispatchEvent(new Event('dragstart', { bubbles: true }))
    cardD.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    expect(store.doc.teams[0]!.actionItems.find((i) => i.id === 'a')!.status).toBe('done')
  })

  test('dropping a card on the floating trash zone opens the delete-confirm modal', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const card = cards(container)[0]!
    const trash = container.querySelector('.tt-kanban-trash')!
    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    trash.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')
    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })

  test('dragstart on a card reveals a dashed highlight on all 4 drop zones (todo/wip/done/cancelled); dragend hides them', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const zones = Array.from(container.querySelectorAll('.tt-kanban-dropzone'))
    expect(zones).toHaveLength(4)
    expect(zones.every((z) => !z.classList.contains('active'))).toBe(true)

    const card = cards(container)[0]!
    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(zones.every((z) => z.classList.contains('active'))).toBe(true)

    card.dispatchEvent(new Event('dragend', { bubbles: true }))
    expect(zones.every((z) => z.classList.contains('active'))).toBe(false)
  })

  test('dragover on a column body highlights only that zone; dropping clears every zone\'s highlight', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'w', status: 'wip', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const todoCol = container.querySelectorAll('.tt-kanban-col')[0]!
    const wipCol = container.querySelectorAll('.tt-kanban-col')[1]!
    const wipBody = wipCol.querySelector('.tt-kanban-col-body')!
    // The zone overlay lives beside the body (inside the shared wrap), not
    // inside it — see the comment on .tt-kanban-col-body-wrap in styles.css.
    const todoZone = todoCol.querySelector('.tt-kanban-dropzone')!
    const wipZone = wipCol.querySelector('.tt-kanban-dropzone')!

    cards(container)[0]!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    wipBody.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
    expect(wipZone.classList.contains('drag-over')).toBe(true)
    expect(todoZone.classList.contains('drag-over')).toBe(false)

    wipBody.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    expect(wipZone.classList.contains('drag-over')).toBe(false)
    expect(wipZone.classList.contains('active')).toBe(false)
    expect(todoZone.classList.contains('active')).toBe(false)
  })

  test('dragstart marks the module as dragging (CSS shrinks the column drop-zones to clear space for the full-width trash bar); dragend/drop clear it', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const root = container.querySelector('.tt-kanban')!
    const card = cards(container)[0]!
    expect(root.classList.contains('dragging')).toBe(false)

    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(root.classList.contains('dragging')).toBe(true)

    card.dispatchEvent(new Event('dragend', { bubbles: true }))
    expect(root.classList.contains('dragging')).toBe(false)
  })

  test('dropping a card (not just dragend) also clears the dragging class', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', status: 'todo' }), item({ id: 'w', status: 'wip', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const root = container.querySelector('.tt-kanban')!
    const wipBody = container.querySelectorAll('.tt-kanban-col')[1]!.querySelector('.tt-kanban-col-body')!
    cards(container)[0]!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    wipBody.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))

    expect(root.classList.contains('dragging')).toBe(false)
  })
})

describe('renderActionItems — custom columns: drag-and-drop reorder', () => {
  function fire(el: HTMLElement, type: string, dataTransfer: Partial<DataTransfer> = {}): void {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent & { dataTransfer: Partial<DataTransfer> }
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    el.dispatchEvent(event)
  }

  /** A 'drop' fired with a real clientX, against a stubbed getBoundingClientRect, so wireColumnHeaderDrag's before/after split (left half vs. right half of the header) is exercised instead of degenerating on jsdom's all-zero layout rect. */
  function fireDropAt(headEl: HTMLElement, clientX: number): void {
    headEl.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) })
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent & { dataTransfer: Partial<DataTransfer>; clientX: number }
    Object.defineProperty(event, 'dataTransfer', { value: {} })
    Object.defineProperty(event, 'clientX', { value: clientX })
    headEl.dispatchEvent(event)
  }

  // The drag source is the grip icon (.tt-kanban-col-grip), not the header
  // itself — see wireColumnHeaderDrag's doc comment in action-items.ts.
  function grip(headEl: HTMLElement): HTMLElement {
    return headEl.querySelector<HTMLElement>('.tt-kanban-col-grip')!
  }

  test('dragging one middle column header before another persists the new order', () => {
    const team = makeTeam({
      actionColumns: [{ id: 'a', name: 'A', order: 0 }, { id: 'b', name: 'B', order: 1 }, { id: 'c', name: 'C', order: 2 }],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const heads = Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-col-head'))
    const [todoHead, headA, headB, headC] = heads // eslint-disable-line @typescript-eslint/no-unused-vars

    fire(grip(headC!), 'dragstart', { setData: () => {} })
    fire(headA!, 'dragover')
    fireDropAt(headA!, 10) // left half of the header -> before A

    const ids = store.doc.teams[0]!.actionColumns!.slice().sort((x, y) => x.order - y.order).map((c) => c.id)
    expect(ids).toEqual(['c', 'a', 'b'])
  })

  test('dropping on the right half of a header places the dragged column after it', () => {
    const team = makeTeam({
      actionColumns: [{ id: 'a', name: 'A', order: 0 }, { id: 'b', name: 'B', order: 1 }, { id: 'c', name: 'C', order: 2 }],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const heads = Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-col-head'))
    const [, headA, , headC] = heads

    fire(grip(headC!), 'dragstart', { setData: () => {} })
    fire(headA!, 'dragover')
    fireDropAt(headA!, 150) // right half of the header -> after A

    const ids = store.doc.teams[0]!.actionColumns!.slice().sort((x, y) => x.order - y.order).map((c) => c.id)
    expect(ids).toEqual(['a', 'c', 'b'])
  })

  test('the fixed Todo and Done+Cancelled column headers are not drop targets for a column drag', () => {
    const team = makeTeam({ actionColumns: [{ id: 'a', name: 'A', order: 0 }] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const todoHead = container.querySelector<HTMLElement>('.tt-kanban-col-head')!
    const heads = Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-col-head'))
    const headA = heads[1]!

    fire(todoHead, 'dragstart', { setData: () => {} })
    expect(todoHead.getAttribute('draggable')).toBeNull()

    // Not just missing `draggable` — the fixed header must genuinely have no
    // drag listeners wired: dragging a real column onto it must not reorder
    // anything.
    fire(grip(headA), 'dragstart', { setData: () => {} })
    fire(todoHead, 'dragover')
    fire(todoHead, 'drop')

    const idsAfter = store.doc.teams[0]!.actionColumns!.slice().sort((x, y) => x.order - y.order).map((c) => c.id)
    expect(idsAfter).toEqual(['a'])
  })

  test('dropping a dragged CARD onto a middle column\'s header does not reorder actionColumns, even after an earlier column drag was aborted (regression: an aborted column drag left draggedColumnId set forever, since headEl had no dragend handler — a later card drop onto a different column\'s header was then misread as a pending column reorder)', () => {
    const team = makeTeam({
      actionColumns: [{ id: 'a', name: 'A', order: 0 }, { id: 'b', name: 'B', order: 1 }, { id: 'c', name: 'C', order: 2 }],
      actionItems: [item({ id: 'i1', status: 'todo' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const heads = Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-col-head'))
    const headA = heads[1]!
    const headC = heads[3]! // todo, a, b, c, done+cancelled
    const card = cards(container)[0]!

    // Start (and abort) a column-header drag on 'a': released somewhere that
    // isn't a valid column-header drop target, so no `drop` ever fires on
    // any header — the exact scenario that used to leak `draggedColumnId`.
    fire(grip(headA), 'dragstart', { setData: () => {} })

    // Now drag a CARD and drop it on a *different* middle column's header
    // ('c') — dragging 'a' before 'c' would visibly change the order (unlike
    // 'a' before 'b', which is already 'a' before 'b'), so this actually
    // exercises the bug rather than landing on a no-op reorder.
    card.dispatchEvent(new Event('dragstart', { bubbles: true }))
    fire(headC, 'dragover')
    fire(headC, 'drop')

    const idsAfter = store.doc.teams[0]!.actionColumns!.slice().sort((x, y) => x.order - y.order).map((c) => c.id)
    expect(idsAfter).toEqual(['a', 'b', 'c'])
  })
})

describe('backlink-only foreign changes patch chips in place (no full rebuild)', () => {
  test('a notes-scoped edit that adds a mention shows the chip without rebuilding the card', () => {
    const team = makeTeam({ actionItems: [item({ id: 'i1', summary: 'Do thing' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardBefore = container.querySelector('[data-item-id="i1"].tt-kanban-card')
    expect(cardBefore).not.toBeNull()
    expect(container.querySelector('[data-item-id="i1"] .tt-backlinks-chip')).toBeNull()

    store.update((d) => {
      d.teams[0]!.dailyNotes['2026-02-02'] = 'do @[Do thing](action:i1)'
    }, { teamId: 'T1', sections: ['notes'] })

    expect(container.querySelector('[data-item-id="i1"] .tt-backlinks-chip')?.textContent).toBe('↩ 1')
    expect(container.querySelector('[data-item-id="i1"].tt-kanban-card')).toBe(cardBefore)
  })

  test('a notes-scoped edit that removes the last mention removes the chip in place', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'i1', summary: 'Do thing' })],
      dailyNotes: { '2026-02-02': 'do @[Do thing](action:i1)' },
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardBefore = container.querySelector('[data-item-id="i1"].tt-kanban-card')
    expect(container.querySelector('[data-item-id="i1"] .tt-backlinks-chip')?.textContent).toBe('↩ 1')

    store.update((d) => {
      d.teams[0]!.dailyNotes['2026-02-02'] = 'do it'
    }, { teamId: 'T1', sections: ['notes'] })

    expect(container.querySelector('[data-item-id="i1"] .tt-backlinks-chip')).toBeNull()
    expect(container.querySelector('[data-item-id="i1"].tt-kanban-card')).toBe(cardBefore)
  })

  test('an actions-scoped edit from elsewhere still rebuilds the board', () => {
    const team = makeTeam({ actionItems: [item({ id: 'i1', summary: 'Do thing' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardBefore = container.querySelector('[data-item-id="i1"].tt-kanban-card')
    store.update((d) => {
      d.teams[0]!.actionItems.push(item({ id: 'i2', summary: 'Second', order: 1 }))
    }, { teamId: 'T1', sections: ['actions'] })

    expect(cards(container)).toHaveLength(2)
    expect(container.querySelector('[data-item-id="i1"].tt-kanban-card')).not.toBe(cardBefore)
  })

  test('a people-scoped edit from elsewhere still rebuilds the board (assignee display and datalist read people)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'i1', summary: 'Do thing' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const cardBefore = container.querySelector('[data-item-id="i1"].tt-kanban-card')
    store.update((d) => {
      d.teams[0]!.members.push({ id: 'mem-2', name: 'Dana', role: 'Dev', parentId: null, order: 1, notes: '' })
    }, { teamId: 'T1', sections: ['people'] })

    expect(container.querySelector('[data-item-id="i1"].tt-kanban-card')).not.toBe(cardBefore)
  })
})
