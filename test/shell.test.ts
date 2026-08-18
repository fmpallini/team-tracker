import { createShell, type Shell } from '../src/ui/shell'
import { t } from '../src/core/i18n'

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

describe('header compact mode', () => {
  function header(shell: Shell): HTMLElement {
    return shell.root.querySelector('.tt-header') as HTMLElement
  }

  test('setHeaderCompactSpaceHidden toggles a single class on the header, independent of any content already inside', () => {
    const shell = setup()
    const indicator = document.createElement('span')
    indicator.className = 'visible'
    shell.headerCenter.appendChild(indicator)

    expect(header(shell).classList.contains('tt-header-compact')).toBe(false)
    shell.setHeaderCompactSpaceHidden(true)
    expect(header(shell).classList.contains('tt-header-compact')).toBe(true)
    // content already inside headerCenter is untouched — hiding is a pure CSS override
    expect(indicator.classList.contains('visible')).toBe(true)

    shell.setHeaderCompactSpaceHidden(false)
    expect(header(shell).classList.contains('tt-header-compact')).toBe(false)
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

  test('dirty/error states keep showing the last-saved time, and dirty names what the time means', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    shell.setSaveState('saved')
    // Not "Unsaved · 2:32 PM": the middot reads as "unsaved *since* 2:32",
    // when 2:32 is in fact the last successful save.
    shell.setSaveState('dirty')
    expect(pillText(shell)).toBe('Unsaved — last saved 2:32 PM')
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

  test('clicking the pill fires onSaveRequest only in dirty/error states, not saved/saving', () => {
    const shell = setup()
    const cb = vi.fn()
    shell.onSaveRequest(cb)
    const pill = shell.root.querySelector('.tt-save-pill') as HTMLElement

    shell.setSaveState('saved')
    pill.click()
    shell.setSaveState('saving')
    pill.click()
    expect(cb).not.toHaveBeenCalled()

    shell.setSaveState('dirty')
    pill.click()
    expect(cb).toHaveBeenCalledOnce()

    shell.setSaveState('error')
    pill.click()
    expect(cb).toHaveBeenCalledTimes(2)
  })

  test('the pill is only styled clickable (cursor) in dirty/error states', () => {
    const shell = setup()
    const pill = shell.root.querySelector('.tt-save-pill') as HTMLElement

    shell.setSaveState('saved')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(false)
    shell.setSaveState('dirty')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)
    shell.setSaveState('saving')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(false)
    shell.setSaveState('error')
    expect(pill.classList.contains('tt-save-pill-clickable')).toBe(true)
  })

  test('createShell stamps an initial timestamp, so dirty shows it immediately', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 9, 5))
    const shell = setup()
    shell.setSaveState('dirty')
    expect(pillText(shell)).toBe('Unsaved — last saved 9:05 AM')
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
      locale: 'pt-BR', theme: 'system', palette: 'ledger', font: 'system', fontSize: 'M', autoSaveMin: 5, dueSoonDays: 7, openRefsInSecondaryPane: false, dailyBackupEnabled: false, backupHandleId: null, backupFrequency: 'daily',
    })
    // same underlying 14:32 save, now shown in pt-BR's 24h convention
    expect(pillText(shell)).toBe('Salvo · 14:32')
  })

  // Design note (src/ui/shell.ts): createShell(locale) has no companion
  // setLocale() — the constructor param is the only way to seed locale before
  // any Prefs/Doc exists, so the very first render must already reflect it.
  test('createShell(locale) drives the very first render — no applyPrefs call needed to get the right locale', () => {
    stubMatchMedia()
    const shell = createShell('pt-BR')
    document.body.appendChild(shell.root)
    shell.setSaveState('saved')
    expect(pillText(shell)).toContain(t('pt-BR', 'save_saved'))
    expect(shell.root.querySelector('.tt-app-name')!.textContent).toBe(t('pt-BR', 'app_name'))
  })
})

// Task: action-items.ts's expanded-modal header mirrors the real pill via
// this narrow subscribe/trigger surface (src/ui/panes.ts's SaveStatusApi) —
// these tests cover the shell-side half of that contract in isolation.
describe('subscribeSaveState / requestSaveNow', () => {
  test('fires immediately on subscribe with the current, already-formatted snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    shell.setSaveState('saved')

    const seen: { state: string; label: string }[] = []
    shell.subscribeSaveState((info) => seen.push({ state: info.state, label: info.label }))

    expect(seen).toEqual([{ state: 'saved', label: 'Saved · 2:32 PM' }])
  })

  test('fires again on every subsequent setSaveState, with the same label the real pill shows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
    const shell = setup()
    const pillText = (): string => shell.root.querySelector('.tt-save-pill-text')!.textContent!

    const seen: string[] = []
    shell.subscribeSaveState((info) => seen.push(info.label))

    shell.setSaveState('dirty')
    expect(seen.at(-1)).toBe(pillText())
    shell.setSaveState('saving')
    expect(seen.at(-1)).toBe(pillText())
    shell.setSaveState('saved')
    expect(seen.at(-1)).toBe(pillText())
  })

  test('every subscriber is notified, independently', () => {
    const shell = setup()
    const a = vi.fn()
    const b = vi.fn()
    shell.subscribeSaveState(a)
    shell.subscribeSaveState(b)
    a.mockClear()
    b.mockClear() // drop the immediate on-subscribe call each got

    shell.setSaveState('dirty')
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
  })

  test('the unsubscribe function stops further notifications without affecting other subscribers', () => {
    const shell = setup()
    const a = vi.fn()
    const b = vi.fn()
    const unsubscribeA = shell.subscribeSaveState(a)
    shell.subscribeSaveState(b)
    a.mockClear()
    b.mockClear()

    unsubscribeA()
    shell.setSaveState('dirty')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  test('requestSaveNow() has the same dirty/error-only gating as clicking the real pill', () => {
    const shell = setup()
    const cb = vi.fn()
    shell.onSaveRequest(cb)

    shell.setSaveState('saved')
    shell.requestSaveNow()
    shell.setSaveState('saving')
    shell.requestSaveNow()
    expect(cb).not.toHaveBeenCalled()

    shell.setSaveState('dirty')
    shell.requestSaveNow()
    expect(cb).toHaveBeenCalledOnce()

    shell.setSaveState('error')
    shell.requestSaveNow()
    expect(cb).toHaveBeenCalledTimes(2)
  })
})

// The shell's OS-theme listener lives on a matchMedia MediaQueryList, which
// outlives any one document. Left attached, it kept the whole shell — and via
// createShell's shared closure scope, its entire DOM tree — reachable for the
// life of the tab, so every close-file → open-file cycle retained a previous
// UI. Measured at ~340 nodes / ~140 listeners per cycle before the fix; see
// e2e/leak.spec.ts, which guards the end-to-end behavior.
describe('dispose', () => {
  function trackedMatchMedia(): { added: number; removed: number } {
    const counts = { added: 0, removed: 0 }
    window.matchMedia = ((query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => { counts.added++ },
      removeEventListener: () => { counts.removed++ },
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    return counts
  }

  test('removes the matchMedia listener it registered', () => {
    const counts = trackedMatchMedia()
    const shell = createShell('en-US')
    expect(counts.added).toBe(1)
    expect(counts.removed).toBe(0)

    shell.dispose()
    expect(counts.removed).toBe(1)
  })

  test('repeated create/dispose cycles leave no listener attached', () => {
    const counts = trackedMatchMedia()
    for (let i = 0; i < 5; i++) createShell('en-US').dispose()
    expect(counts.added).toBe(5)
    expect(counts.removed).toBe(5)
  })
})
