import { renderActionItems, itemsByStatus, isOverdue, computeDropPosition, moveCard } from '../src/modules/action-items'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { ActionItem, Loc, Team } from '../src/core/types'

function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
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
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: PaneManager; loc: Loc } {
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

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
  renderActionItems(container, loc, ctx)
}

function clickByTitleOrText(root: ParentNode, text: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text || b.title === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

function cards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-kanban-card'))
}

afterEach(() => {
  document.body.innerHTML = ''
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

  describe('computeDropPosition', () => {
    test('top half is before, bottom half is after', () => {
      expect(computeDropPosition(0, 100)).toBe('before')
      expect(computeDropPosition(49, 100)).toBe('before')
      expect(computeDropPosition(50, 100)).toBe('after')
      expect(computeDropPosition(100, 100)).toBe('after')
    })
    test('degenerates to after for a zero/negative height card', () => {
      expect(computeDropPosition(0, 0)).toBe('after')
      expect(computeDropPosition(5, -1)).toBe('after')
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

  test('shows an empty placeholder per column with no cards', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelectorAll('.tt-kanban-empty')).toHaveLength(4) // todo, wip, done, cancelled
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

  test("the assignee input's datalist lists stakeholders and members by name", () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card') // To Do column's add button (first in DOM order)
    const assigneeInput = document.querySelector('.tt-kanban-form-row input[type="text"]') as HTMLInputElement
    const datalist = document.getElementById(assigneeInput.getAttribute('list')!)!
    const options = Array.from(datalist.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(options).toEqual(expect.arrayContaining(['Carla', 'Bruno']))
  })
})

describe('renderActionItems — edit modal', () => {
  test('"+ Card" in To Do creates a card in the todo column with the entered fields', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    summaryInput.value = 'New task'
    const dueInput = document.querySelector('.tt-kanban-form input[type="date"]') as HTMLInputElement
    dueInput.value = '2026-08-01'
    ;(document.querySelectorAll('.tt-kanban-color-chip')[2] as HTMLButtonElement).click() // 3rd = sage

    clickByTitleOrText(document.body, 'Save')

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
    summaryInput.value = 'WIP task'
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionItems[0]!.status).toBe('wip')
  })

  test('leaving summary blank shows a validation error and does not save', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Card')
    clickByTitleOrText(document.body, 'Save')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-field-error')!.textContent).toBe('Summary is required')
  })

  test('editing an existing card via dblclick pre-fills fields and Save persists changes', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: 'Old', dueDate: '2026-01-01', assignee: 'Bruno', color: 'rust' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    expect(summaryInput.value).toBe('Old')
    summaryInput.value = 'New'
    clickByTitleOrText(document.body, 'Save')

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

  test('deleting a card whose summary is blank removes it immediately with no confirmation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', summary: '' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    cards(container)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })
})

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
})

describe('renderActionItems — edit tags modal', () => {
  // Finds the text input in the edit-tags row whose swatch carries `color-${color}`
  // — avoids the `:has()` CSS selector, whose jsdom/nwsapi support is version-
  // dependent, in favor of a plain DOM walk.
  function tagRowInput(color: string): HTMLInputElement {
    const row = Array.from(document.querySelectorAll('.tt-edit-tags-row')).find((r) => r.querySelector(`.color-${color}`))
    if (!row) throw new Error(`no edit-tags row for color "${color}"`)
    return row.querySelector('input') as HTMLInputElement
  }

  test('"Edit tags" opens a modal with one row per color, pre-filled from actionTagNames', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    expect(document.querySelectorAll('.tt-edit-tags-row')).toHaveLength(6)
    expect(tagRowInput('rust').value).toBe('Blocked')
    expect(tagRowInput('slate').value).toBe('')
  })

  test('saving writes trimmed, non-empty names into actionTagNames', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    tagRowInput('rust').value = '  Blocked  '
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })

  test('clearing a name back to empty removes that key instead of storing an empty string', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked', plum: 'Urgent' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    tagRowInput('rust').value = ''
    clickByTitleOrText(document.body, 'Save')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ plum: 'Urgent' })
  })

  test('canceling leaves actionTagNames untouched', () => {
    const team = makeTeam({ actionTagNames: { rust: 'Blocked' } })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Edit tags')
    tagRowInput('rust').value = 'Something else'
    clickByTitleOrText(document.body, 'Cancel')

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
  })
})

describe('renderActionItems — tag display and filter', () => {
  // Finds the chip/badge whose swatch (or the element itself) carries
  // `color-${color}` — avoids relying on visible text, which is now blank
  // for colors without a custom name.
  function chipByColor(container: ParentNode, selector: string, color: string): HTMLElement {
    const found = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((c) => c.querySelector(`.color-${color}`))
    if (!found) throw new Error(`no "${selector}" for color "${color}"`)
    return found
  }

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
    expect(rustChip.textContent?.trim()).toBe('Blocked')
    expect(slateChip.textContent?.trim()).toBe('')
    expect(slateChip.getAttribute('aria-label')).toBe('Slate')
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
    const chips = Array.from(document.querySelectorAll('.tt-kanban-color-chip'))
    const rustChip = chips.find((c) => c.classList.contains('color-rust'))!
    const slateChip = chips.find((c) => c.classList.contains('color-slate'))!

    expect(rustChip.textContent?.trim()).toBe('Blocked')
    expect(slateChip.textContent?.trim()).toBe('')
    expect(slateChip.getAttribute('aria-label')).toBe('Slate')
  })

  test('a button beside the color chips opens Edit tags; saving refreshes the chip in place without closing the card modal', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const openNamesBtn = document.querySelector('.tt-kanban-color-names-btn') as HTMLButtonElement
    expect(openNamesBtn).not.toBeNull()
    openNamesBtn.click()

    const rows = Array.from(document.querySelectorAll('.tt-edit-tags-row'))
    expect(rows).toHaveLength(6) // opened from the card modal, not the toolbar — still the full color list
    const rustRow = rows.find((r) => r.querySelector('.color-rust'))!
    ;(rustRow.querySelector('input') as HTMLInputElement).value = 'Blocked'

    const tagsDialog = document.querySelector('.tt-edit-tags-form')!.closest('.tt-modal-dialog')!
    const saveBtn = Array.from(tagsDialog.querySelectorAll('button')).find((b) => b.textContent === 'Save')! as HTMLButtonElement
    saveBtn.click()

    expect(store.doc.teams[0]!.actionTagNames).toEqual({ rust: 'Blocked' })
    expect(document.querySelectorAll('.tt-edit-tags-form')).toHaveLength(0) // tags modal closed
    expect(document.querySelector('.tt-kanban-form')).not.toBeNull() // card modal still open

    const rustChip = Array.from(document.querySelectorAll('.tt-kanban-color-chip')).find((c) => c.classList.contains('color-rust'))!
    expect(rustChip.textContent?.trim()).toBe('Blocked')
  })

  test('picking a color survives refreshing the chips after an Edit tags save', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Card')
    const rustChipBefore = Array.from(document.querySelectorAll('.tt-kanban-color-chip')).find((c) => c.classList.contains('color-rust'))! as HTMLButtonElement
    rustChipBefore.click()
    expect(rustChipBefore.classList.contains('selected')).toBe(true)

    ;(document.querySelector('.tt-kanban-color-names-btn') as HTMLButtonElement).click()
    const tagsDialog = document.querySelector('.tt-edit-tags-form')!.closest('.tt-modal-dialog')!
    const saveBtn = Array.from(tagsDialog.querySelectorAll('button')).find((b) => b.textContent === 'Save')! as HTMLButtonElement
    saveBtn.click()

    const rustChipAfter = Array.from(document.querySelectorAll('.tt-kanban-color-chip')).find((c) => c.classList.contains('color-rust'))!
    expect(rustChipAfter.classList.contains('selected')).toBe(true)

    const summaryInput = document.querySelector('.tt-kanban-form input[type="text"]') as HTMLInputElement
    summaryInput.value = 'Task'
    clickByTitleOrText(document.body, 'Save')
    expect(store.doc.teams[0]!.actionItems[0]!.color).toBe('rust')
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
})
