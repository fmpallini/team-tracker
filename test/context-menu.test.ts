import { showContextMenu } from '../src/ui/context-menu'

afterEach(() => {
  document.body.innerHTML = ''
})

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item'))
}

test('renders one button per item, positioned at (x, y)', () => {
  showContextMenu(50, 80, [{ label: 'Duplicate', onClick: () => {} }, { label: 'Delete', onClick: () => {}, danger: true }])
  const menu = document.querySelector<HTMLElement>('.tt-context-menu')!
  expect(menu.style.left).toBe('50px')
  expect(menu.style.top).toBe('80px')
  expect(items().map((b) => b.textContent)).toEqual(['Duplicate', 'Delete'])
  expect(items()[1]!.classList.contains('danger')).toBe(true)
})

test('clicking an item calls onClick and closes the menu', () => {
  const onClick = vi.fn()
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick }])
  items()[0]!.click()
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('clicking outside the menu closes it without calling onClick', () => {
  const onClick = vi.fn()
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick }])
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(onClick).not.toHaveBeenCalled()
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('Escape closes the menu', () => {
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick: () => {} }])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('opening a second menu closes the first', () => {
  showContextMenu(0, 0, [{ label: 'First', onClick: () => {} }])
  showContextMenu(10, 10, [{ label: 'Second', onClick: () => {} }])
  expect(document.querySelectorAll('.tt-context-menu')).toHaveLength(1)
  expect(items().map((b) => b.textContent)).toEqual(['Second'])
})
