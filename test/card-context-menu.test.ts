import { showCardContextMenu, openItemContextMenu } from '../src/ui/card-context-menu'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Team } from '../src/core/types'

const LOCALE = 'en-US' as const

afterEach(() => {
  document.body.innerHTML = ''
})

function team(id: string, name: string): Team {
  return { id, name, emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} }
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item'))
}

function modalButton(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === label)!
}

test('"Duplicate" and "Delete" are offered when there is no other team', () => {
  const duplicate = vi.fn()
  showCardContextMenu(LOCALE, 'T1', [team('T1', 'Alpha')], 'item-1', 0, 0, { duplicate, transfer: vi.fn(), delete: vi.fn() })
  expect(menuItems().map((b) => b.textContent)).toEqual(['Duplicate', 'Delete'])
})

test('"Duplicate" calls duplicate(itemId) and closes the menu', () => {
  const duplicate = vi.fn()
  showCardContextMenu(LOCALE, 'T1', [team('T1', 'Alpha')], 'item-1', 0, 0, { duplicate, transfer: vi.fn(), delete: vi.fn() })
  menuItems()[0]!.click()
  expect(duplicate).toHaveBeenCalledWith('item-1')
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('"Delete" calls delete(itemId), renders danger-styled, and closes the menu', () => {
  const del = vi.fn()
  showCardContextMenu(LOCALE, 'T1', [team('T1', 'Alpha')], 'item-1', 0, 0, { duplicate: vi.fn(), transfer: vi.fn(), delete: del })
  const deleteBtn = menuItems()[1]!
  expect(deleteBtn.classList.contains('danger')).toBe(true)
  deleteBtn.click()
  expect(del).toHaveBeenCalledWith('item-1')
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('copy/move are offered, excluding the current team, when other teams exist — "Delete" stays last', () => {
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta'), team('T3', 'Gamma')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer: vi.fn(), delete: vi.fn() })
  expect(menuItems().map((b) => b.textContent)).toEqual(['Duplicate', 'Copy to team…', 'Move to team…', 'Delete'])
  menuItems()[1]!.click() // "Copy to team…" opens the team picker
  const options = Array.from(document.querySelectorAll<HTMLOptionElement>('select option'))
  expect(options.map((o) => o.value)).toEqual(['T2', 'T3']) // T1 (current team) excluded
})

test('"Copy to team…" calls transfer with mode "copy" and the picked team', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer, delete: vi.fn() })
  menuItems()[1]!.click()
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 'T2'
  modalButton('Confirm').click()
  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'copy')
})

test('"Move to team…" calls transfer with mode "move" and the picked team', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer, delete: vi.fn() })
  menuItems()[2]!.click()
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 'T2'
  modalButton('Confirm').click()
  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'move')
})

test('openItemContextMenu dispatches duplicate to the right kind', () => {
  const doc = createEmptyDocument('en-US')
  const team2 = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team2.actionItems.push({ id: 'a1', summary: 'X', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 })
  doc.teams.push(team2)
  const store = createStore(doc)
  const ctx = { store, locale: 'en-US' } as any // extend with pm/paneIdx if ModuleCtx requires them for this path

  openItemContextMenu(ctx, 'action', 't1', 'a1', 10, 10, vi.fn())
  menuItems()[0]!.click() // "Duplicate"
  expect(store.doc.teams[0]!.actionItems.length).toBe(2)
})

test('openItemContextMenu dispatches duplicate for milestones to team.milestones only', () => {
  const doc = createEmptyDocument('en-US')
  const team2 = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team2.milestones.push({ id: 'm1', date: '2026-01-01', title: 'X', done: false, followup: '' })
  doc.teams.push(team2)
  const store = createStore(doc)
  const ctx = { store, locale: 'en-US' } as any

  openItemContextMenu(ctx, 'milestone', 't1', 'm1', 10, 10, vi.fn())
  menuItems()[0]!.click() // "Duplicate"
  expect(store.doc.teams[0]!.milestones.length).toBe(2)
  expect(store.doc.teams[0]!.actionItems.length).toBe(0)
  expect(store.doc.teams[0]!.risks.length).toBe(0)
})

test('openItemContextMenu dispatches duplicate for risks to team.risks only', () => {
  const doc = createEmptyDocument('en-US')
  const team2 = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team2.risks.push({ id: 'r1', title: 'X', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false })
  doc.teams.push(team2)
  const store = createStore(doc)
  const ctx = { store, locale: 'en-US' } as any

  openItemContextMenu(ctx, 'risk', 't1', 'r1', 10, 10, vi.fn())
  menuItems()[0]!.click() // "Duplicate"
  expect(store.doc.teams[0]!.risks.length).toBe(2)
  expect(store.doc.teams[0]!.actionItems.length).toBe(0)
  expect(store.doc.teams[0]!.milestones.length).toBe(0)
})

test('openItemContextMenu dispatches transfer (copy) to the right kind and target team', () => {
  const doc = createEmptyDocument('en-US')
  const teamA = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  teamA.actionItems.push({ id: 'a1', summary: 'X', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 })
  const teamB = createEmptyTeam('t2', 'Beta', '🚀', 'en-US')
  doc.teams.push(teamA, teamB)
  const store = createStore(doc)
  const ctx = { store, locale: 'en-US' } as any

  openItemContextMenu(ctx, 'action', 't1', 'a1', 10, 10, vi.fn())
  expect(menuItems().map((b) => b.textContent)).toEqual(['Duplicate', 'Copy to team…', 'Move to team…', 'Delete'])
  menuItems()[1]!.click() // "Copy to team…"
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 't2'
  modalButton('Confirm').click()

  expect(store.doc.teams[0]!.actionItems.length).toBe(1) // copy mode: source untouched
  expect(store.doc.teams[1]!.actionItems.length).toBe(1) // landed in the target team's actionItems
  expect(store.doc.teams[1]!.milestones.length).toBe(0)
  expect(store.doc.teams[1]!.risks.length).toBe(0)
})

test('when getColumnsForTeam is supplied, "Copy to team…" opens the combined team+column picker and transfer receives the chosen column', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  const getColumnsForTeam = () => [{ id: 'todo', label: 'To Do' }, { id: 'review', label: 'Review' }]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer, delete: vi.fn() }, getColumnsForTeam)
  menuItems()[1]!.click() // "Copy to team…"

  const selects = document.querySelectorAll<HTMLSelectElement>('select')
  expect(selects).toHaveLength(2) // team + column, not just team
  selects[0]!.value = 'T2'
  selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
  selects[1]!.value = 'review'
  modalButton('Confirm').click()

  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'copy', 'review')
})

test('without getColumnsForTeam, the plain team-only picker is used (milestones/risks unaffected)', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer, delete: vi.fn() })
  menuItems()[1]!.click()
  expect(document.querySelectorAll('select')).toHaveLength(1)
  modalButton('Confirm').click()
  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'copy')
})

test('openItemContextMenu wires "Delete" to the onDelete callback, not a store mutation', () => {
  const doc = createEmptyDocument('en-US')
  const team2 = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team2.actionItems.push({ id: 'a1', summary: 'X', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 })
  doc.teams.push(team2)
  const store = createStore(doc)
  const ctx = { store, locale: 'en-US' } as any
  const onDelete = vi.fn()

  openItemContextMenu(ctx, 'action', 't1', 'a1', 10, 10, onDelete)
  menuItems().find((b) => b.textContent === 'Delete')!.click()

  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(store.doc.teams[0]!.actionItems.length).toBe(1) // untouched — deletion is the caller's job (confirm dialog etc.)
})
