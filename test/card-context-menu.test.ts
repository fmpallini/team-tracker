import { showCardContextMenu } from '../src/ui/card-context-menu'
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

test('only "Duplicate" is offered when there is no other team', () => {
  const duplicate = vi.fn()
  showCardContextMenu(LOCALE, 'T1', [team('T1', 'Alpha')], 'item-1', 0, 0, { duplicate, transfer: vi.fn() })
  expect(menuItems().map((b) => b.textContent)).toEqual(['Duplicate'])
})

test('"Duplicate" calls duplicate(itemId) and closes the menu', () => {
  const duplicate = vi.fn()
  showCardContextMenu(LOCALE, 'T1', [team('T1', 'Alpha')], 'item-1', 0, 0, { duplicate, transfer: vi.fn() })
  menuItems()[0]!.click()
  expect(duplicate).toHaveBeenCalledWith('item-1')
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('copy/move are offered, excluding the current team, when other teams exist', () => {
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta'), team('T3', 'Gamma')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer: vi.fn() })
  expect(menuItems().map((b) => b.textContent)).toEqual(['Duplicate', 'Copy to team…', 'Move to team…'])
  menuItems()[1]!.click() // "Copy to team…" opens the team picker
  const options = Array.from(document.querySelectorAll<HTMLOptionElement>('select option'))
  expect(options.map((o) => o.value)).toEqual(['T2', 'T3']) // T1 (current team) excluded
})

test('"Copy to team…" calls transfer with mode "copy" and the picked team', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer })
  menuItems()[1]!.click()
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 'T2'
  modalButton('Confirm').click()
  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'copy')
})

test('"Move to team…" calls transfer with mode "move" and the picked team', () => {
  const transfer = vi.fn()
  const teams = [team('T1', 'Alpha'), team('T2', 'Beta')]
  showCardContextMenu(LOCALE, 'T1', teams, 'item-1', 0, 0, { duplicate: vi.fn(), transfer })
  menuItems()[2]!.click()
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 'T2'
  modalButton('Confirm').click()
  expect(transfer).toHaveBeenCalledWith('item-1', 'T2', 'move')
})
