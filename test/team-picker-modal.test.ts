import { openTeamPickerModal } from '../src/ui/team-picker-modal'
import type { Team } from '../src/core/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function team(id: string, name: string, emoji = '🚀'): Team {
  return { id, name, emoji, stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} }
}

function modalButton(label: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === label)!
}

test('renders one option per team with emoji + name', () => {
  openTeamPickerModal({
    title: 'Copy to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
    teams: [team('a', 'Alpha', '🚀'), team('b', 'Beta', '🔥')],
    onConfirm: () => {},
  })
  const options = Array.from(document.querySelectorAll<HTMLOptionElement>('select option'))
  expect(options.map((o) => o.textContent)).toEqual(['🚀 Alpha', '🔥 Beta'])
  expect(options.map((o) => o.value)).toEqual(['a', 'b'])
})

test('confirm calls onConfirm with the selected team id, then closes', () => {
  const onConfirm = vi.fn()
  openTeamPickerModal({
    title: 'Copy to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
    teams: [team('a', 'Alpha'), team('b', 'Beta')],
    onConfirm,
  })
  const select = document.querySelector('select') as HTMLSelectElement
  select.value = 'b'
  modalButton('Confirm').click()
  expect(onConfirm).toHaveBeenCalledWith('b')
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})

test('cancel does not call onConfirm', () => {
  const onConfirm = vi.fn()
  openTeamPickerModal({
    title: 'Copy to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
    teams: [team('a', 'Alpha')],
    onConfirm,
  })
  modalButton('Cancel').click()
  expect(onConfirm).not.toHaveBeenCalled()
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})
