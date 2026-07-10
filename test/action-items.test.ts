import {
  renderActionItems,
  openItems,
  doneItems,
  isOverdue,
  computeFlatDropPosition,
  moveActionItem,
} from '../src/modules/action-items'
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
  return { id: 'i1', text: 'Do thing', done: false, dueDate: null, assignee: '', order: 0, notes: '', ...overrides }
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

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-action-row'))
}

function clickByTitleOrText(root: ParentNode, text: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text || b.title === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
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

describe('pure helpers', () => {
  test('openItems returns not-done items sorted by order', () => {
    const items = [item({ id: 'b', order: 1 }), item({ id: 'a', order: 0 }), item({ id: 'c', order: 2, done: true })]
    expect(openItems(items).map((i) => i.id)).toEqual(['a', 'b'])
  })

  test('doneItems returns done items sorted by order', () => {
    const items = [item({ id: 'b', order: 1, done: true }), item({ id: 'a', order: 0, done: true }), item({ id: 'c', order: 2 })]
    expect(doneItems(items).map((i) => i.id)).toEqual(['a', 'b'])
  })

  describe('isOverdue', () => {
    test('true when dueDate is in the past and the item is not done', () => {
      expect(isOverdue({ dueDate: '2000-01-01', done: false }, '2026-07-04')).toBe(true)
    })
    test('false when done, even if the due date is in the past', () => {
      expect(isOverdue({ dueDate: '2000-01-01', done: true }, '2026-07-04')).toBe(false)
    })
    test('false when there is no due date', () => {
      expect(isOverdue({ dueDate: null, done: false }, '2026-07-04')).toBe(false)
    })
    test('false when the due date is today or in the future', () => {
      expect(isOverdue({ dueDate: '2026-07-04', done: false }, '2026-07-04')).toBe(false)
      expect(isOverdue({ dueDate: '2999-01-01', done: false }, '2026-07-04')).toBe(false)
    })
  })

  describe('computeFlatDropPosition', () => {
    test('top half is before, bottom half is after', () => {
      expect(computeFlatDropPosition(0, 100)).toBe('before')
      expect(computeFlatDropPosition(49, 100)).toBe('before')
      expect(computeFlatDropPosition(50, 100)).toBe('after')
      expect(computeFlatDropPosition(100, 100)).toBe('after')
    })
    test('degenerates to after for a zero/negative height row', () => {
      expect(computeFlatDropPosition(0, 0)).toBe('after')
      expect(computeFlatDropPosition(5, -1)).toBe('after')
    })
  })

  describe('moveActionItem', () => {
    test('moves an item before another, renumbering densely', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 }), item({ id: 'c', order: 2 })]
      moveActionItem(items, 'c', 'a', 'before')
      expect(openItems(items).map((i) => i.id)).toEqual(['c', 'a', 'b'])
      expect(openItems(items).map((i) => i.order)).toEqual([0, 1, 2])
    })

    test('moves an item after another', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 }), item({ id: 'c', order: 2 })]
      moveActionItem(items, 'a', 'b', 'after')
      expect(openItems(items).map((i) => i.id)).toEqual(['b', 'a', 'c'])
    })

    test('no-op when dragging an item onto itself', () => {
      const items = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 })]
      moveActionItem(items, 'a', 'a', 'before')
      expect(items.map((i) => i.order)).toEqual([0, 1])
    })

    test('no-op when the target id does not exist', () => {
      const items = [item({ id: 'a', order: 0 })]
      moveActionItem(items, 'a', 'ghost', 'before')
      expect(items[0]!.order).toBe(0)
    })

    test('no-op when the dragged id does not exist', () => {
      const items = [item({ id: 'a', order: 0 })]
      moveActionItem(items, 'ghost', 'a', 'before')
      expect(items[0]!.order).toBe(0)
    })
  })
})

describe('renderActionItems', () => {
  test('renders open items sorted by order; done items are grouped, collapsed by default, with a count', () => {
    const team = makeTeam({
      actionItems: [
        item({ id: 'b', text: 'B', order: 1 }),
        item({ id: 'a', text: 'A', order: 0 }),
        item({ id: 'd', text: 'D done', order: 0, done: true }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const openTexts = Array.from(container.querySelectorAll<HTMLInputElement>('.tt-action-list .tt-action-text')).map((i) => i.value)
    expect(openTexts).toEqual(['A', 'B'])

    const doneDetails = container.querySelector('.tt-actions-done') as HTMLDetailsElement
    expect(doneDetails.open).toBe(false)
    expect(doneDetails.querySelectorAll('.tt-action-row')).toHaveLength(1)
    expect(doneDetails.querySelector('summary')!.textContent).toBe('Completed items (1)')

    doneDetails.open = true
    expect(doneDetails.open).toBe(true)
  })

  test('shows a placeholder when there are no items at all', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-action-empty')?.textContent).toBe('No items')
  })

  test('the done checkbox persists to the store and moves the row into the done group', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const checkbox = container.querySelector('.tt-action-done') as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))

    expect(store.doc.teams[0]!.actionItems[0]!.done).toBe(true)
    expect(container.querySelector('.tt-actions-done')!.querySelectorAll('.tt-action-row')).toHaveLength(1)
    expect(container.querySelector('.tt-action-list .tt-action-row')).toBeNull()
  })

  test('editing the text input persists on change', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const textInput = container.querySelector('.tt-action-text') as HTMLInputElement
    textInput.value = 'Updated text'
    textInput.dispatchEvent(new Event('change'))

    expect(store.doc.teams[0]!.actionItems[0]!.text).toBe('Updated text')
  })

  test('setting and clearing the due date persists an ISO string or null', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const dueInput = container.querySelector('.tt-action-due') as HTMLInputElement
    dueInput.value = '2026-01-01'
    dueInput.dispatchEvent(new Event('change'))
    expect(store.doc.teams[0]!.actionItems[0]!.dueDate).toBe('2026-01-01')

    dueInput.value = ''
    dueInput.dispatchEvent(new Event('change'))
    expect(store.doc.teams[0]!.actionItems[0]!.dueDate).toBeNull()
  })

  test('an open item with a past due date gets the overdue class', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0, dueDate: '2000-01-01' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(rows(container)[0]!.classList.contains('overdue')).toBe(true)
  })

  test('a done item with a past due date is not overdue', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0, dueDate: '2000-01-01', done: true })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const doneRow = container.querySelector('.tt-actions-done .tt-action-row')!
    expect(doneRow.classList.contains('overdue')).toBe(false)
  })

  test('an open item with a future due date is not overdue', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0, dueDate: '2999-01-01' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(rows(container)[0]!.classList.contains('overdue')).toBe(false)
  })

  test('"+ Item" appends an empty item with order = max+1 and focuses its text input', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 }), item({ id: 'b', order: 3 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Item')

    const allItems = store.doc.teams[0]!.actionItems
    expect(allItems).toHaveLength(3)
    const added = allItems[2]!
    expect(added.order).toBe(4)
    expect(added.text).toBe('')
    expect(added.done).toBe(false)
    expect(added.dueDate).toBeNull()

    const focused = document.activeElement as HTMLInputElement
    expect(focused.classList.contains('tt-action-text')).toBe(true)
    expect(focused.closest('.tt-action-row')?.getAttribute('data-item-id')).toBe(added.id)
  })

  test('"+ Item" on an empty list starts order at 0', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    clickByTitleOrText(container, '+ Item')
    expect(store.doc.teams[0]!.actionItems[0]!.order).toBe(0)
  })

  test('deleting an item with empty text removes it immediately with no confirmation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: '', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete item')

    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('deleting an item with non-empty text requires confirmation', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'Important', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete item')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')

    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(0)
  })

  test('canceling the delete confirmation keeps the item', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'Important', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete item')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.actionItems).toHaveLength(1)
  })

  test("the assignee input's datalist lists stakeholders and members by name", () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const assigneeInput = container.querySelector('.tt-action-assignee') as HTMLInputElement
    const datalist = document.getElementById(assigneeInput.getAttribute('list')!)!
    const options = Array.from(datalist.querySelectorAll('option')).map((o) => o.getAttribute('value'))
    expect(options).toEqual(expect.arrayContaining(['Carla', 'Bruno']))
  })

  test('assignee accepts free text not present in the datalist (e.g. an external vendor)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const assigneeInput = container.querySelector('.tt-action-assignee') as HTMLInputElement
    assigneeInput.value = 'Fornecedor X'
    assigneeInput.dispatchEvent(new Event('change'))
    expect(store.doc.teams[0]!.actionItems[0]!.assignee).toBe('Fornecedor X')
  })

  test('preserves an in-progress text edit (skips rebuild, defers to blur) when the store changes elsewhere while focused', () => {
    const team = makeTeam({
      actionItems: [item({ id: 'a', text: 'A', order: 0 }), item({ id: 'b', text: 'B', order: 1 })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const textInputs = (): HTMLInputElement[] => Array.from(container.querySelectorAll<HTMLInputElement>('.tt-action-text'))
    const aInput = textInputs().find((i) => i.value === 'A')!
    aInput.focus()

    store.update((d) => { d.teams[0]!.actionItems[1]!.text = 'B changed' })

    expect(document.activeElement).toBe(aInput)
    expect(textInputs().find((i) => i.value === 'B changed')).toBeUndefined()

    aInput.dispatchEvent(new Event('blur'))
    expect(textInputs().find((i) => i.value === 'B changed')).not.toBeUndefined()
  })

  test('double render into the same container disposes the previous store subscription (no duplicate rebuilds/leaks)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'A', order: 0 })] })
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)

    expect(() => store.update((d) => { d.teams[0]!.actionItems[0]!.text = 'A2' })).not.toThrow()
    expect(rows(container)).toHaveLength(1)
  })

  describe('notes editor', () => {
    test('expand button reveals a notes editor that persists to item.notes', () => {
      vi.useFakeTimers()
      const team = makeTeam({ actionItems: [item({ id: 'a', notes: '' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      expect(container.querySelector('.editor')).toBeNull()
      container.querySelector<HTMLButtonElement>('.tt-action-expand-btn')!.click()

      const editorEl = container.querySelector('.tt-action-notes-row .editor') as HTMLElement
      expect(editorEl).not.toBeNull()
      setBlockText(editorEl, 'nota livre')
      fireInput(editorEl)
      vi.advanceTimersByTime(400)

      expect(store.doc.teams[0]!.actionItems[0]!.notes).toContain('nota livre')
    })

    test('expanding pre-loads the editor with the item\'s existing notes', () => {
      const team = makeTeam({ actionItems: [item({ id: 'a', notes: '## Context' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      container.querySelector<HTMLButtonElement>('.tt-action-expand-btn')!.click()
      const editorEl = container.querySelector('.editor') as HTMLElement
      expect(editorEl.querySelector('h2')?.textContent).toBe('Context')
    })

    test('collapsing a row disposes its editor', () => {
      const team = makeTeam({ actionItems: [item({ id: 'a', notes: 'x' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const toggle = () => container.querySelector<HTMLButtonElement>('.tt-action-expand-btn')!
      toggle().click()
      expect(container.querySelector('.editor')).not.toBeNull()
      toggle().click()
      expect(container.querySelector('.editor')).toBeNull()
    })
  })

  test('a defensive no-op when loc.ref.kind is not "actions"', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm } = setup(team)
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'members' } }
    render(container, wrongLoc, store, pm)
    expect(container.children).toHaveLength(0)
  })

  test('expand button uses the same ▸/▾ arrow glyph as risks (not a 📝 icon)', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const btn = container.querySelector('.tt-action-expand-btn') as HTMLButtonElement
    expect(btn.textContent).toBe('▸')
    btn.click()
    expect(container.querySelector('.tt-action-expand-btn')!.textContent).toBe('▾')
  })

  test('Enter in the text field blurs it, committing via onchange', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', text: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const textInput = container.querySelector('.tt-action-text') as HTMLInputElement
    textInput.focus()
    expect(document.activeElement).toBe(textInput)
    textInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.activeElement).not.toBe(textInput)
  })

  test('Tab navigation skips the row\'s icon buttons, moving cleanly between data fields', () => {
    const team = makeTeam({ actionItems: [item({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const row = container.querySelector('.tt-action-row')!
    expect(row.querySelector('.tt-action-done')!.getAttribute('tabindex')).toBeNull()
    expect(row.querySelector('.tt-action-text')!.getAttribute('tabindex')).toBeNull()
    expect(row.querySelector('.tt-action-due')!.getAttribute('tabindex')).toBeNull()
    expect(row.querySelector('.tt-action-assignee')!.getAttribute('tabindex')).toBeNull()
    expect((row.querySelector('.tt-action-expand-btn') as HTMLElement).tabIndex).toBe(-1)
    expect((row.querySelector('.tt-action-delete-btn') as HTMLElement).tabIndex).toBe(-1)
  })
})
