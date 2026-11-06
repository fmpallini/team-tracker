import { createTabRail } from '../src/ui/tab-rail'

type Id = 'a' | 'b' | 'c'

function mount(initial: Id = 'a') {
  const onSelect = vi.fn()
  const rail = createTabRail<Id>({
    idPrefix: 'x',
    tabs: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', extra: document.createTextNode('!') }, { id: 'c', label: 'Gamma' }],
    initial,
    onSelect,
  })
  document.body.append(rail.tabs, rail.panel)
  const buttons = Array.from(rail.tabs.querySelectorAll<HTMLButtonElement>('button'))
  const key = (k: string): void => { rail.tabs.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }
  return { rail, onSelect, buttons, key }
}

afterEach(() => { document.body.innerHTML = '' })

test('wires tablist, tabs and panel with matching ids and one tab stop', () => {
  const { rail, buttons } = mount('b')
  expect(rail.tabs.getAttribute('role')).toBe('tablist')
  expect(buttons.map((b) => b.id)).toEqual(['x-tab-a', 'x-tab-b', 'x-tab-c'])
  expect(buttons.map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1])
  expect(rail.panel.id).toBe('x-panel')
  expect(rail.panel.getAttribute('aria-labelledby')).toBe('x-tab-b')
  expect(buttons[1]!.textContent).toBe('Beta!')
})

test('a click makes the tab current and reports whether it changed', () => {
  const { rail, onSelect, buttons } = mount()
  buttons[2]!.click()
  expect(rail.active).toBe('c')
  expect(buttons[2]!.classList.contains('active')).toBe(true)
  expect(onSelect).toHaveBeenLastCalledWith('c', true)
  buttons[2]!.click()
  expect(onSelect).toHaveBeenLastCalledWith('c', false)
})

test('arrows wrap around and only move focus; Home and End jump to the ends', () => {
  const { rail, onSelect, buttons, key } = mount()
  buttons[0]!.focus()
  key('ArrowUp')
  expect(document.activeElement).toBe(buttons[2])
  key('ArrowDown')
  expect(document.activeElement).toBe(buttons[0])
  key('End')
  expect(document.activeElement).toBe(buttons[2])
  key('Home')
  expect(document.activeElement).toBe(buttons[0])
  expect(rail.active).toBe('a')
  expect(onSelect).not.toHaveBeenCalled()
  expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1])
})

test('select() changes the current tab without calling onSelect', () => {
  const { rail, onSelect, buttons } = mount()
  rail.select('c')
  expect(rail.active).toBe('c')
  expect(buttons[2]!.getAttribute('aria-selected')).toBe('true')
  expect(rail.panel.getAttribute('aria-labelledby')).toBe('x-tab-c')
  expect(onSelect).not.toHaveBeenCalled()
  rail.focusActive()
  expect(document.activeElement).toBe(buttons[2])
})
