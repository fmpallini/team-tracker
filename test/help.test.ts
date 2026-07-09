import { showGlobalHelp, showEditorHelp } from '../src/ui/help'
import { createShell } from '../src/ui/shell'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('shell header has a ❓ help button that fires the registered onHelp callback', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const cb = vi.fn()
  shell.onHelp(cb)

  const btn = Array.from(shell.root.querySelectorAll('button')).find((b) => b.textContent === '❓')!
  expect(btn).not.toBeUndefined()
  btn.click()

  expect(cb).toHaveBeenCalledOnce()
})

test('global help lists app-level shortcuts and the app-window recipe', () => {
  showGlobalHelp('en-US')
  const text = document.body.textContent!
  expect(text).toContain('Alt+1')
  expect(text).toContain('Ctrl+K')
  expect(text).toContain('chrome --app')
})

test('editor help no longer carries the app-window recipe', () => {
  showEditorHelp('en-US')
  expect(document.body.textContent!).not.toContain('chrome --app')
})
