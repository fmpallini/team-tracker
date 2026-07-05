import { hotkeyAllowed, comboHotkeyAllowed } from '../src/ui/hotkeys'

afterEach(() => {
  document.body.innerHTML = ''
})

function keydownOn(target: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

test('allows the hotkey on a plain document target', () => {
  document.body.appendChild(document.createElement('div'))
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body)
  expect(hotkeyAllowed(captured!)).toBe(true)
})

test('blocks the hotkey when ctrlKey is set (AltGr on Windows)', () => {
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body, { ctrlKey: true })
  expect(hotkeyAllowed(captured!)).toBe(false)
})

test('blocks the hotkey when metaKey is set', () => {
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body, { metaKey: true })
  expect(hotkeyAllowed(captured!)).toBe(false)
})

test('blocks the hotkey while typing in a text input', () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(input)
  expect(hotkeyAllowed(captured!)).toBe(false)
})

test('blocks the hotkey inside a contenteditable element', () => {
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  const child = document.createElement('span')
  editable.appendChild(child)
  document.body.appendChild(editable)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(child)
  expect(hotkeyAllowed(captured!)).toBe(false)
})

test('blocks the hotkey while a modal overlay is open', () => {
  const overlay = document.createElement('div')
  overlay.className = 'tt-modal-overlay'
  document.body.appendChild(overlay)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body)
  expect(hotkeyAllowed(captured!)).toBe(false)
})

test('comboHotkeyAllowed allows the combo while typing in a text input', () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(input, { ctrlKey: true, key: 'k' })
  expect(comboHotkeyAllowed(captured!)).toBe(true)
})

test('comboHotkeyAllowed allows the combo inside a contenteditable element', () => {
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  const child = document.createElement('span')
  editable.appendChild(child)
  document.body.appendChild(editable)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(child, { ctrlKey: true, key: 'k' })
  expect(comboHotkeyAllowed(captured!)).toBe(true)
})

test('comboHotkeyAllowed blocks the combo while a modal overlay is open', () => {
  const overlay = document.createElement('div')
  overlay.className = 'tt-modal-overlay'
  document.body.appendChild(overlay)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body, { ctrlKey: true, key: 'k' })
  expect(comboHotkeyAllowed(captured!)).toBe(false)
})
