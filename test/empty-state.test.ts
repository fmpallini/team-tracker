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

test('an action renders as a button that fires its handler; without one there is no button', () => {
  const onClick = vi.fn()
  const node = emptyState({ icon: 'flag', text: 'x', action: { label: '+ Milestone', onClick } })
  const btn = node.querySelector<HTMLButtonElement>('button.tt-empty-state-action')!
  expect(btn.textContent).toBe('+ Milestone')
  btn.click()
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(emptyState({ icon: 'flag', text: 'x' }).querySelector('button')).toBeNull()
})
