import { setReadOnlyLock, READONLY_TOAST_KEY } from '../src/ui/readonly-lock'
import { t } from '../src/core/i18n'
import { createDatePicker } from '../src/ui/date-picker'

const lc = (): 'en-US' => 'en-US'
const toasts = (): Element[] => Array.from(document.querySelectorAll(`.tt-toast[data-toast-key="${READONLY_TOAST_KEY}"]`))

function mountControls() {
  const pane = document.body.appendChild(document.createElement('div'))
  pane.innerHTML = `
    <input class="title" type="text">
    <textarea class="area"></textarea>
    <select class="sel"><option value="1">1</option><option value="2">2</option></select>
    <input class="box" type="checkbox">
    <div class="tt-date-picker"><input class="tt-date-picker-input" type="text"></div>
    <div class="tt-kanban-color-row"><button class="tt-kanban-color-chip" type="button"></button></div>
    <div class="card" draggable="true"></div>
    <button class="nav" type="button">nav</button>
    <input class="num" type="number" value="5">
    <p class="plain">some text</p>
    <div data-readonly-exempt><input class="search" type="text"></div>`
  return (sel: string) => pane.querySelector<HTMLElement>(sel)!
}
function fire(target: HTMLElement, ev: Event): Event { target.dispatchEvent(ev); return ev }
const beforeInput = (): InputEvent => new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'x' })

afterEach(() => {
  setReadOnlyLock(false, lc)
  document.body.innerHTML = ''
})

test('read-only: typing into a text field or textarea is refused', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.title'), beforeInput()).defaultPrevented).toBe(true)
  expect(fire($('.area'), beforeInput()).defaultPrevented).toBe(true)
})

test('read-only: a select can be neither opened nor changed from the keyboard; Tab still moves on', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.sel'), new MouseEvent('mousedown', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  expect(fire($('.sel'), new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  expect(fire($('.sel'), new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })).defaultPrevented).toBe(false)
})

test('read-only: a checkbox does not toggle', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  ;($('.box') as HTMLInputElement).click()
  expect(($('.box') as HTMLInputElement).checked).toBe(false)
})

test('read-only: a date picker does not open and a card colour chip does not fire', () => {
  const $ = mountControls()
  const opened = vi.fn()
  const chip = vi.fn()
  $('.tt-date-picker-input').addEventListener('click', opened)
  $('.tt-kanban-color-chip').addEventListener('click', chip)
  setReadOnlyLock(true, lc)
  $('.tt-date-picker-input').click()
  $('.tt-kanban-color-chip').click()
  expect(opened).not.toHaveBeenCalled()
  expect(chip).not.toHaveBeenCalled()
})

test('read-only: nothing can be dragged', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.card'), new Event('dragstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
})

test('read-only: a select refuses keys that open or change it, but not hotkeys or bare modifiers', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  const key = (k: string, init: KeyboardEventInit = {}) =>
    fire($('.sel'), new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })).defaultPrevented
  expect(key('ArrowDown')).toBe(true)
  expect(key('a')).toBe(true)
  expect(key(' ')).toBe(true)
  expect(key('Enter')).toBe(true)
  expect(key('k', { ctrlKey: true })).toBe(false)
  expect(key('1', { altKey: true })).toBe(false)
  expect(key('ArrowLeft', { altKey: true, shiftKey: true })).toBe(false)
  expect(key('Shift', { shiftKey: true })).toBe(false)
  expect(key('Control', { ctrlKey: true })).toBe(false)
  expect(toasts()).toHaveLength(1) // only the refused keys raised the notice
})

test('read-only: a hotkey on a focused select reaches the document handler', () => {
  const $ = mountControls()
  const hotkey = vi.fn()
  document.addEventListener('keydown', hotkey)
  try {
    setReadOnlyLock(true, lc)
    fire($('.sel'), new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(hotkey).toHaveBeenCalledTimes(1)
  } finally {
    document.removeEventListener('keydown', hotkey)
  }
})

test('read-only: only draggable elements are refused on dragstart', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  expect(fire($('.plain'), new Event('dragstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(false)
  const inner = $('.card').appendChild(document.createElement('span'))
  expect(fire(inner, new Event('dragstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
})

test('read-only: a number input refuses ArrowUp/ArrowDown and the mouse wheel', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  const num = $('.num') as HTMLInputElement
  expect(fire(num, new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  expect(fire(num, new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  expect(fire(num, new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })).defaultPrevented).toBe(false)
  num.focus()
  expect(fire(num, new WheelEvent('wheel', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true)
  setReadOnlyLock(false, lc)
  expect(fire(num, new WheelEvent('wheel', { bubbles: true, cancelable: true })).defaultPrevented).toBe(false)
})

test('read-only: focusing a date picker input opens no popover, and an already-open popover refuses its day buttons', () => {
  const picker = createDatePicker({ value: '2026-03-10', locale: 'en-US', onChange: vi.fn() })
  document.body.appendChild(picker.root)
  const input = picker.root.querySelector<HTMLInputElement>('.tt-date-picker-input')!
  setReadOnlyLock(true, lc)
  input.focus()
  input.dispatchEvent(new FocusEvent('focus'))
  expect(document.querySelector('.tt-date-picker-popover')).toBeNull()

  // A popover that was already open when the lock armed.
  setReadOnlyLock(false, lc)
  input.dispatchEvent(new FocusEvent('focus'))
  const day = document.querySelector<HTMLButtonElement>('.tt-date-picker-popover .tt-calendar-day:not(.tt-calendar-day-blank)')!
  const clicked = vi.fn()
  day.addEventListener('click', clicked)
  setReadOnlyLock(true, lc)
  day.click()
  expect(clicked).not.toHaveBeenCalled()
  picker.destroy()
})

test('read-only: navigation buttons and exempt fields keep working', () => {
  const $ = mountControls()
  const nav = vi.fn()
  $('.nav').addEventListener('click', nav)
  setReadOnlyLock(true, lc)
  $('.nav').click()
  expect(nav).toHaveBeenCalledTimes(1)
  expect(fire($('.search'), beforeInput()).defaultPrevented).toBe(false)
})

test('every refused attempt says why, as one toast that does not stack', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  fire($('.title'), beforeInput())
  fire($('.title'), beforeInput())
  ;($('.box') as HTMLInputElement).click()
  expect(toasts()).toHaveLength(1)
  expect(toasts()[0]!.textContent).toBe(t('en-US', 'readonly_blocked_toast'))
})

test('the root carries data-readonly while locked, for the not-allowed cursor', () => {
  setReadOnlyLock(true, lc)
  expect(document.documentElement.hasAttribute('data-readonly')).toBe(true)
  setReadOnlyLock(false, lc)
  expect(document.documentElement.hasAttribute('data-readonly')).toBe(false)
})

test('unlocking restores every gesture; arming twice then unlocking once leaves nothing behind', () => {
  const $ = mountControls()
  setReadOnlyLock(true, lc)
  setReadOnlyLock(true, lc)
  setReadOnlyLock(false, lc)
  expect(fire($('.title'), beforeInput()).defaultPrevented).toBe(false)
  ;($('.box') as HTMLInputElement).click()
  expect(($('.box') as HTMLInputElement).checked).toBe(true)
})
