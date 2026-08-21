import { openTeamPickerModal, openTeamColumnPickerModal } from '../src/ui/team-picker-modal'
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

describe('openTeamColumnPickerModal', () => {
  function columns(t: Team): { id: string; label: string }[] {
    return t.id === 'a' ? [{ id: 'todo', label: 'To Do' }, { id: 'wip', label: 'WIP' }] : [{ id: 'todo', label: 'To Do' }, { id: 'review', label: 'Review' }]
  }

  test('renders a team select and a column select, columns matching the first team by default', () => {
    openTeamColumnPickerModal({
      title: 'Move to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', columnLabel: 'Column',
      teams: [team('a', 'Alpha'), team('b', 'Beta')],
      getColumns: columns,
      onConfirm: () => {},
    })
    const selects = document.querySelectorAll<HTMLSelectElement>('select')
    expect(selects).toHaveLength(2)
    const columnOptions = Array.from(selects[1]!.querySelectorAll('option')).map((o) => o.value)
    expect(columnOptions).toEqual(['todo', 'wip'])
  })

  test('changing the team select repopulates the column select', () => {
    openTeamColumnPickerModal({
      title: 'Move to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', columnLabel: 'Column',
      teams: [team('a', 'Alpha'), team('b', 'Beta')],
      getColumns: columns,
      onConfirm: () => {},
    })
    const [teamSelect, columnSelect] = document.querySelectorAll<HTMLSelectElement>('select')
    teamSelect!.value = 'b'
    teamSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(Array.from(columnSelect!.querySelectorAll('option')).map((o) => o.value)).toEqual(['todo', 'review'])
  })

  test('confirm calls onConfirm with the selected team id and column id, then closes', () => {
    const onConfirm = vi.fn()
    openTeamColumnPickerModal({
      title: 'Move to which team?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', columnLabel: 'Column',
      teams: [team('a', 'Alpha'), team('b', 'Beta')],
      getColumns: columns,
      onConfirm,
    })
    const [teamSelect, columnSelect] = document.querySelectorAll<HTMLSelectElement>('select')
    teamSelect!.value = 'b'
    teamSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    columnSelect!.value = 'review'
    modalButton('Confirm').click()
    expect(onConfirm).toHaveBeenCalledWith('b', 'review')
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })
})
