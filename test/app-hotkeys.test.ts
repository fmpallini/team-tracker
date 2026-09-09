import { resolveAppHotkey, type AppHotkeyAction, type AppHotkeyContext } from '../src/ui/app-hotkeys'

const CTX: AppHotkeyContext = { teamCount: 3, focusedPaneShowsDailyNote: false }
const ctx = (over: Partial<AppHotkeyContext> = {}): AppHotkeyContext => ({ ...CTX, ...over })

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}
const resolve = (init: KeyboardEventInit, over?: Partial<AppHotkeyContext>): AppHotkeyAction | null =>
  resolveAppHotkey(key(init), ctx(over))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('global Ctrl chords', () => {
  test('Ctrl+S → save, always, even with a blocking modal open and focus in a field', () => {
    document.body.innerHTML = '<div class="tt-modal-overlay"></div>'
    expect(resolve({ key: 's', code: 'KeyS', ctrlKey: true })).toEqual({ type: 'save' })
    expect(resolve({ key: 's', code: 'KeyS', metaKey: true })).toEqual({ type: 'save' })
  })

  test('Ctrl+S matches by physical key on a layout where e.key is not "s"', () => {
    expect(resolve({ key: 'ß', code: 'KeyS', ctrlKey: true })).toEqual({ type: 'save' })
  })

  test('Ctrl+Shift+K → palette, unless a blocking modal is open', () => {
    expect(resolve({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })).toEqual({ type: 'palette' })

    document.body.innerHTML = '<div class="tt-modal-overlay"></div>'
    expect(resolve({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })).toBeNull()
  })

  test('a modeless card modal does NOT block Ctrl+Shift+K', () => {
    document.body.innerHTML = '<div class="tt-modal-overlay tt-modal-modeless"></div>'
    expect(resolve({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })).toEqual({ type: 'palette' })
  })

  test('Ctrl+Alt+L → closeFile; Ctrl+Shift+L and plain Ctrl+L do not', () => {
    expect(resolve({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true })).toEqual({ type: 'closeFile' })
    expect(resolve({ key: 'l', code: 'KeyL', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(resolve({ key: 'l', code: 'KeyL', ctrlKey: true })).toBeNull()
  })

  test('Ctrl+Alt+L is blocked by a blocking modal', () => {
    document.body.innerHTML = '<div class="tt-modal-overlay"></div>'
    expect(resolve({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true })).toBeNull()
  })
})

describe('F-keys → pane module jump', () => {
  test.each([
    ['F1', 0],
    ['F2', 1],
    ['F7', 6],
  ])('%s → paneModule %i', (k, index) => {
    expect(resolve({ key: k })).toEqual({ type: 'paneModule', index })
  })

  test('F8 and above are not claimed', () => {
    expect(resolve({ key: 'F8' })).toBeNull()
  })

  test('F-keys fire even with focus in an editor field (navHotkeyAllowed), but not behind a blocking modal', () => {
    // jsdom: navHotkeyAllowed only consults ctrl/meta + blocking modal, not
    // the focused element — the "still fires while editing" property.
    expect(resolve({ key: 'F3' })).toEqual({ type: 'paneModule', index: 2 })
    document.body.innerHTML = '<div class="tt-modal-overlay"></div>'
    expect(resolve({ key: 'F3' })).toBeNull()
  })
})

describe('Alt+Arrow — pane layout', () => {
  test('Alt+Left / Alt+Right select a pane', () => {
    expect(resolve({ key: 'ArrowLeft', altKey: true })).toEqual({ type: 'selectPane', index: 0 })
    expect(resolve({ key: 'ArrowRight', altKey: true })).toEqual({ type: 'selectPane', index: 1 })
  })

  test('Alt+Up toggles split, Alt+Down swaps sides', () => {
    expect(resolve({ key: 'ArrowUp', altKey: true })).toEqual({ type: 'toggleSplit' })
    expect(resolve({ key: 'ArrowDown', altKey: true })).toEqual({ type: 'swapPanes' })
  })

  test('without Alt, arrows are not claimed', () => {
    expect(resolve({ key: 'ArrowLeft' })).toBeNull()
    expect(resolve({ key: 'ArrowUp' })).toBeNull()
  })

  test('Ctrl+Alt+Arrow is not claimed (navHotkeyAllowed rejects ctrl)', () => {
    expect(resolve({ key: 'ArrowLeft', altKey: true, ctrlKey: true })).toBeNull()
  })
})

describe('Alt+Shift+Arrow — pane history', () => {
  test('Alt+Shift+Left / Right step history', () => {
    expect(resolve({ key: 'ArrowLeft', altKey: true, shiftKey: true })).toEqual({ type: 'historyStep', dir: -1 })
    expect(resolve({ key: 'ArrowRight', altKey: true, shiftKey: true })).toEqual({ type: 'historyStep', dir: 1 })
  })

  test('Alt+Shift+Up jumps history to latest', () => {
    expect(resolve({ key: 'ArrowUp', altKey: true, shiftKey: true })).toEqual({ type: 'historyLatest' })
  })

  test('Alt+Shift+Down is not a history action (falls through, unclaimed)', () => {
    expect(resolve({ key: 'ArrowDown', altKey: true, shiftKey: true })).toBeNull()
  })
})

describe('Alt+[ / Alt+] / Alt+T — daily-note day nav', () => {
  test('claimed only when the focused pane shows a daily note', () => {
    expect(resolve({ key: '[', code: 'BracketLeft', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'prev' })
    expect(resolve({ key: ']', code: 'BracketRight', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'next' })
    expect(resolve({ key: 't', code: 'KeyT', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'today' })
  })

  test('left alone when the focused pane is not a daily note', () => {
    expect(resolve({ key: '[', code: 'BracketLeft', altKey: true }, { focusedPaneShowsDailyNote: false })).toBeNull()
    expect(resolve({ key: 't', code: 'KeyT', altKey: true }, { focusedPaneShowsDailyNote: false })).toBeNull()
  })

  test('matches the physical key when e.key is a dead/AltGr char', () => {
    expect(resolve({ key: 'Dead', code: 'BracketRight', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'next' })
  })

  test('Alt+Shift+T is not day-nav (shift already handled/rejected above)', () => {
    expect(resolve({ key: 't', code: 'KeyT', altKey: true, shiftKey: true }, { focusedPaneShowsDailyNote: true })).toBeNull()
  })
})

describe('Alt+, / Alt+. — jump to prev/next day that has a note', () => {
  test('claimed only when the focused pane shows a daily note', () => {
    expect(resolve({ key: ',', code: 'Comma', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'prevWithContent' })
    expect(resolve({ key: '.', code: 'Period', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'nextWithContent' })
  })

  test('left alone when the focused pane is not a daily note', () => {
    expect(resolve({ key: ',', code: 'Comma', altKey: true }, { focusedPaneShowsDailyNote: false })).toBeNull()
    expect(resolve({ key: '.', code: 'Period', altKey: true }, { focusedPaneShowsDailyNote: false })).toBeNull()
  })

  test('matches the physical key when e.key is a shifted char (< / >)', () => {
    expect(resolve({ key: '<', code: 'Comma', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'prevWithContent' })
    expect(resolve({ key: '>', code: 'Period', altKey: true }, { focusedPaneShowsDailyNote: true }))
      .toEqual({ type: 'dayNav', to: 'nextWithContent' })
  })

  test('Alt+Shift+[ / Alt+Shift+] no longer route anywhere (the ABNT2 bug)', () => {
    // '}' from a shifted bracket, physical `]` reports code "Backslash" on ABNT2
    expect(resolve({ key: '}', code: 'Backslash', altKey: true, shiftKey: true }, { focusedPaneShowsDailyNote: true })).toBeNull()
    expect(resolve({ key: '{', code: 'BracketRight', altKey: true, shiftKey: true }, { focusedPaneShowsDailyNote: true })).toBeNull()
  })
})

describe('Alt+1..9 — team switch', () => {
  test('switches to the team at that index when it exists', () => {
    expect(resolve({ key: '1', code: 'Digit1', altKey: true })).toEqual({ type: 'selectTeam', index: 0 })
    expect(resolve({ key: '3', code: 'Digit3', altKey: true })).toEqual({ type: 'selectTeam', index: 2 })
  })

  test('digit past the last team is left to the browser (not claimed)', () => {
    expect(resolve({ key: '4', code: 'Digit4', altKey: true }, { teamCount: 3 })).toBeNull()
    expect(resolve({ key: '9', code: 'Digit9', altKey: true }, { teamCount: 3 })).toBeNull()
  })

  test('teamCount 0 → no Alt+digit is claimed', () => {
    expect(resolve({ key: '1', code: 'Digit1', altKey: true }, { teamCount: 0 })).toBeNull()
  })

  test('matches the physical Digit key when e.key is an AZERTY symbol', () => {
    expect(resolve({ key: '&', code: 'Digit1', altKey: true })).toEqual({ type: 'selectTeam', index: 0 })
  })

  test('Alt+0 is not claimed', () => {
    expect(resolve({ key: '0', code: 'Digit0', altKey: true })).toBeNull()
  })
})

describe('non-hotkey keys', () => {
  test.each(['a', 'Enter', 'Escape', 'ArrowLeft', ' ', 'Tab'])('%j alone → null', (k) => {
    expect(resolve({ key: k })).toBeNull()
  })

  test('a plain (Alt-less, Ctrl-less) letter with a code is null', () => {
    expect(resolve({ key: 'k', code: 'KeyK' })).toBeNull()
  })
})
