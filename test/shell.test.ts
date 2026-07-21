import { createShell, type Shell } from '../src/ui/shell'

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

function setup(): Shell {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  return shell
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('header filename', () => {
  test('setTitle shows the filename in the header', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv', false)
    expect(shell.root.querySelector('.tt-header-filename')!.textContent).toBe('team-tracker.tmv')
  })

  test('setTitle(null, ...) clears the header filename', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv', false)
    shell.setTitle(null, false)
    expect(shell.root.querySelector('.tt-header-filename')!.textContent).toBe('')
  })
})

describe('save indicator timestamp', () => {
  test('setSaveState("saved") shows the icon plus HH:MM', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    shell.setSaveState('saved')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('✓ 14:32')
  })

  test('other states show the icon only, no timestamp', () => {
    const shell = setup()
    shell.setSaveState('dirty')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('●')
    shell.setSaveState('saving')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('…')
    shell.setSaveState('error')
    expect(shell.root.querySelector('.tt-save-indicator')!.textContent).toBe('⚠')
  })
})
