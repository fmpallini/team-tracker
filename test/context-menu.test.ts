import { showContextMenu, closeAnyContextMenu } from '../src/ui/context-menu'

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

// Regression: the menu used to render with no keyboard handling at all
// ("every current use is mouse-driven"), so once a caller opened it via a
// keyboard action (Space on a risk/milestone/action-item row), arrow keys
// fell straight through to whatever the row's OWN arrow handler does
// instead of moving the menu's own selection.
describe('keyboard navigation', () => {
  test('opening the menu moves focus into its first item', () => {
    showContextMenu(0, 0, [{ label: 'Duplicate', onClick: () => {} }])
    expect(document.activeElement).toBe(items()[0])
  })

  test('ArrowDown/ArrowUp move the highlighted item, wrapping at neither end (clamped)', () => {
    showContextMenu(0, 0, [
      { label: 'A', onClick: () => {} },
      { label: 'B', onClick: () => {} },
      { label: 'C', onClick: () => {} },
    ])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(items()[1]!.classList.contains('selected')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(items()[2]!.classList.contains('selected')).toBe(true) // clamped at last item

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(items()[1]!.classList.contains('selected')).toBe(true)
  })

  test('Enter activates the currently-highlighted item and closes the menu', () => {
    const onClickA = vi.fn()
    const onClickB = vi.fn()
    showContextMenu(0, 0, [{ label: 'A', onClick: onClickA }, { label: 'B', onClick: onClickB }])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(onClickB).toHaveBeenCalledTimes(1)
    expect(onClickA).not.toHaveBeenCalled()
    expect(document.querySelector('.tt-context-menu')).toBeNull()
  })

  test('closing the menu (Escape, outside click, or picking an item) restores focus to whatever opened it', () => {
    const origin = document.createElement('button')
    document.body.appendChild(origin)
    origin.focus()

    showContextMenu(0, 0, [{ label: 'Duplicate', onClick: () => {} }])
    expect(document.activeElement).not.toBe(origin)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(origin)

    origin.focus()
    showContextMenu(0, 0, [{ label: 'Duplicate', onClick: () => {} }])
    items()[0]!.click()
    expect(document.activeElement).toBe(origin)
  })
})

test('closeAnyContextMenu closes an open menu and removes its document listeners (the file-close leak main.ts guards against)', () => {
  showContextMenu(0, 0, [{ label: 'Duplicate', onClick: () => {} }])
  expect(document.querySelector('.tt-context-menu')).not.toBeNull()
  const addSpy = vi.spyOn(document, 'addEventListener')
  const removeSpy = vi.spyOn(document, 'removeEventListener')

  closeAnyContextMenu()

  expect(document.querySelector('.tt-context-menu')).toBeNull()
  expect(removeSpy.mock.calls.length).toBeGreaterThanOrEqual(2) // bindOutsideDismiss's mousedown + keydown
  expect(addSpy).not.toHaveBeenCalled()
  addSpy.mockRestore()
  removeSpy.mockRestore()
})

test('closeAnyContextMenu is a no-op when nothing is open', () => {
  expect(() => closeAnyContextMenu()).not.toThrow()
  expect(document.querySelector('.tt-context-menu')).toBeNull()
})

test('opening a second menu closes the first', () => {
  showContextMenu(0, 0, [{ label: 'First', onClick: () => {} }])
  showContextMenu(10, 10, [{ label: 'Second', onClick: () => {} }])
  expect(document.querySelectorAll('.tt-context-menu')).toHaveLength(1)
  expect(items().map((b) => b.textContent)).toEqual(['Second'])
})

test('clamps to the viewport when opened near the right/bottom edge', () => {
  const originalGetRect = Element.prototype.getBoundingClientRect
  const originalInnerWidth = window.innerWidth
  const originalInnerHeight = window.innerHeight
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
  Element.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const base = { x: 0, y: 0, toJSON: () => ({}) }
    if (this.classList.contains('tt-context-menu')) {
      return { ...base, left: 780, right: 980, top: 580, bottom: 780, width: 200, height: 200 } as DOMRect
    }
    return originalGetRect.call(this)
  }

  try {
    showContextMenu(780, 580, [{ label: 'Duplicate', onClick: () => {} }])
    const menu = document.querySelector<HTMLElement>('.tt-context-menu')!
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(800 - 8 - 200)
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(600 - 8 - 200)
  } finally {
    Element.prototype.getBoundingClientRect = originalGetRect
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
  }
})
