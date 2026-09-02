import { hotkeyAllowed, comboHotkeyAllowed, navHotkeyAllowed, blockedByModal, blockedByBlockingModal, matchKey, matchDigit } from '../src/ui/hotkeys'

afterEach(() => {
  document.body.innerHTML = ''
})

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('matchKey — layout-independent letter shortcut matching', () => {
  test('matches on the produced character (QWERTY / the mnemonic)', () => {
    expect(matchKey(key({ key: 'x', code: 'KeyX' }), 'x')).toBe(true)
    expect(matchKey(key({ key: 'X', code: 'KeyX' }), 'x')).toBe(true) // Shift held
  })

  test('matches on the physical key when the layout produces a different character', () => {
    // Dvorak: the physical "KeyX" position types 'b'. A dead-key / AltGr
    // layout under Ctrl can also report an unrelated e.key. The digit-row
    // shortcuts already key off e.code; letters must too.
    expect(matchKey(key({ key: 'b', code: 'KeyX' }), 'x')).toBe(true)
  })

  test('does not match an unrelated key', () => {
    expect(matchKey(key({ key: 'y', code: 'KeyY' }), 'x')).toBe(false)
  })
})

describe('matchDigit — layout-independent number shortcut matching', () => {
  test('matches on the produced digit', () => {
    expect(matchDigit(key({ key: '1', code: 'Digit1' }), 1)).toBe(true)
  })

  test('matches on the physical digit key when the row needs Shift for digits (AZERTY)', () => {
    expect(matchDigit(key({ key: '&', code: 'Digit1' }), 1)).toBe(true)
  })

  test('does not match an unrelated digit', () => {
    expect(matchDigit(key({ key: '2', code: 'Digit2' }), 1)).toBe(false)
  })
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

test('a modeless modal overlay does not block the combo / nav hotkeys, but a plain one does', () => {
  const modeless = document.createElement('div')
  modeless.className = 'tt-modal-overlay tt-modal-modeless'
  document.body.appendChild(modeless)
  const e = key({ ctrlKey: false, altKey: true, key: '2' })

  // blockedByModal still counts it (competing popovers, update notice);
  // blockedByBlockingModal — what gates the hotkeys — does not.
  expect(blockedByModal()).toBe(true)
  expect(blockedByBlockingModal()).toBe(false)
  expect(comboHotkeyAllowed(e)).toBe(true)
  expect(navHotkeyAllowed(e)).toBe(true)

  const plain = document.createElement('div')
  plain.className = 'tt-modal-overlay'
  document.body.appendChild(plain)
  expect(blockedByBlockingModal()).toBe(true)
  expect(comboHotkeyAllowed(e)).toBe(false)
  expect(navHotkeyAllowed(e)).toBe(false)
})

test('navHotkeyAllowed allows the hotkey on a plain document target', () => {
  document.body.appendChild(document.createElement('div'))
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body)
  expect(navHotkeyAllowed(captured!)).toBe(true)
})

test('navHotkeyAllowed allows the hotkey while typing in a text input — Alt doesn\'t insert a character, so there is nothing to protect', () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(input)
  expect(navHotkeyAllowed(captured!)).toBe(true)
})

test('navHotkeyAllowed allows the hotkey inside a contenteditable element (a daily note, a risk title, a milestone follow-up)', () => {
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  const child = document.createElement('span')
  editable.appendChild(child)
  document.body.appendChild(editable)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(child)
  expect(navHotkeyAllowed(captured!)).toBe(true)
})

test('navHotkeyAllowed blocks the hotkey when ctrlKey is set (AltGr on Windows)', () => {
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body, { ctrlKey: true })
  expect(navHotkeyAllowed(captured!)).toBe(false)
})

test('navHotkeyAllowed blocks the hotkey when metaKey is set', () => {
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body, { metaKey: true })
  expect(navHotkeyAllowed(captured!)).toBe(false)
})

test('navHotkeyAllowed blocks the hotkey while a modal overlay is open', () => {
  const overlay = document.createElement('div')
  overlay.className = 'tt-modal-overlay'
  document.body.appendChild(overlay)
  let captured: KeyboardEvent | null = null
  document.addEventListener('keydown', (e) => { captured = e })
  keydownOn(document.body)
  expect(navHotkeyAllowed(captured!)).toBe(false)
})
