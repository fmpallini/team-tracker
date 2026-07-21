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

describe('header title', () => {
  test('setTitle sets the document title, not any header element', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv', false)
    expect(document.title).toContain('team-tracker.tmv')
    // filename now shows only in the tab title and Settings > About — never
    // duplicated in the header itself
    expect(shell.root.querySelector('.tt-header-filename')).toBeNull()
  })

  test('setTitle(null, ...) drops the filename from the document title', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv', false)
    shell.setTitle(null, false)
    expect(document.title).not.toContain('team-tracker.tmv')
  })
})

describe('save indicator pill', () => {
  function pillText(shell: Shell): string {
    return shell.root.querySelector('.tt-save-pill-text')!.textContent!
  }

  test('setSaveState("saved") shows the label plus the locale-formatted time, always visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup() // 'en-US' — 12h clock
    shell.setSaveState('saved')
    expect(pillText(shell)).toBe('Saved · 2:32 PM')
    expect(shell.root.querySelector('.tt-save-pill')!.getAttribute('data-state')).toBe('saved')
  })

  test('dirty/error states keep showing the last-saved time alongside their label', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    shell.setSaveState('saved')
    shell.setSaveState('dirty')
    expect(pillText(shell)).toBe('Unsaved · 2:32 PM')
    shell.setSaveState('error')
    expect(pillText(shell)).toBe('Save error · 2:32 PM')
  })

  test('saving state shows its label without a stale timestamp, and spins the icon', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    shell.setSaveState('saved')
    shell.setSaveState('saving')
    expect(pillText(shell)).toBe('Saving…')
    expect(shell.root.querySelector('.tt-save-pill-icon')!.classList.contains('tt-save-pill-spin')).toBe(true)
    shell.setSaveState('saved')
    expect(shell.root.querySelector('.tt-save-pill-icon')!.classList.contains('tt-save-pill-spin')).toBe(false)
  })

  test('createShell stamps an initial timestamp, so dirty shows it immediately', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 9, 5))
    const shell = setup()
    shell.setSaveState('dirty')
    expect(pillText(shell)).toBe('Unsaved · 9:05 AM')
  })

  test('applyPrefs/setFallbackHint re-renders do not re-stamp the timestamp, but do reformat it for the new locale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup() // 'en-US'
    shell.setSaveState('saved')
    vi.setSystemTime(new Date(2026, 6, 20, 15, 0))
    shell.setFallbackHint(true)
    // still the original 14:32 save, not re-stamped to 15:00, still 12h (locale unchanged)
    expect(pillText(shell)).toBe('Saved · 2:32 PM')
    shell.applyPrefs({
      locale: 'pt-BR', theme: 'system', palette: 'ledger', font: 'system', fontSize: 'M', autoSaveMin: 5, dueSoonDays: 7,
    })
    // same underlying 14:32 save, now shown in pt-BR's 24h convention
    expect(pillText(shell)).toBe('Salvo · 14:32')
  })
})
