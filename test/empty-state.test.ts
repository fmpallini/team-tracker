import { emptyState } from '../src/ui/empty-state'

test('renders the icon and the sentence', () => {
  const node = emptyState({ icon: 'flag', text: 'No milestones' })
  expect(node.querySelector('.tt-empty-state-icon .tt-icon-flag')).not.toBeNull()
  expect(node.querySelector('.tt-empty-state-text')?.textContent).toBe('No milestones')
})

test('className adds the module hook next to the shared class', () => {
  const node = emptyState({ icon: 'alert', text: 'x', className: 'tt-risk-empty' })
  expect(node.classList.contains('tt-empty-state')).toBe(true)
  expect(node.classList.contains('tt-risk-empty')).toBe(true)
})
