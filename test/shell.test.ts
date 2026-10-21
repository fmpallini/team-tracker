import { createShell, type Shell, type PillContext, type SaveStatusInfo } from '../src/ui/shell'
import type { FileHealth } from '../src/core/file-snapshot'

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
    shell.setTitle('team-tracker.tmv')
    expect(document.title).toContain('team-tracker.tmv')
    // filename now shows only in the tab title and Settings > About — never
    // duplicated in the header itself
    expect(shell.root.querySelector('.tt-header-filename')).toBeNull()
  })

  test('setTitle(null) drops the filename from the document title', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv')
    shell.setTitle(null)
    expect(document.title).not.toContain('team-tracker.tmv')
  })

  test('the title carries no unsaved marker: the file is nearly always behind the browser copy, so the pill says what matters', () => {
    const shell = setup()
    shell.setTitle('team-tracker.tmv')
    expect(document.title).toBe(`Team Tracker v${__APP_VERSION__} — team-tracker.tmv`)
    expect(document.title).not.toContain('●')
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

  test('setHeaderTeamSpaceHidden toggles its own class, independent of compact', () => {
    const shell = setup()
    shell.setHeaderCompactSpaceHidden(true)
    shell.setHeaderTeamSpaceHidden(true)
    expect(header(shell).classList.contains('tt-header-team-hidden')).toBe(true)
    shell.setHeaderCompactSpaceHidden(false)
    expect(header(shell).classList.contains('tt-header-team-hidden')).toBe(true)
    shell.setHeaderTeamSpaceHidden(false)
    expect(header(shell).classList.contains('tt-header-team-hidden')).toBe(false)
  })
})

function prefsWith(locale: 'en-US' | 'pt-BR' = 'en-US'): Parameters<Shell['applyPrefs']>[0] {
  return {
    locale, theme: 'system', palette: 'ledger', font: 'system', fontSize: 'M', autoSaveMin: 5, dueSoonDays: 7,
    openRefsInSecondaryPane: false, ctrlWheelFontSize: true, dailyEdgeScroll: true,
  }
}

describe('PWA theme-color meta', () => {
  test('applyPrefs re-syncs the tag from the active --bg/--border blend', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = '#3b5a6b'
    document.head.appendChild(meta)
    document.documentElement.style.setProperty('--bg', '#1c1a14')
    document.documentElement.style.setProperty('--border', '#4a4530')
    try {
      const shell = setup()
      shell.applyPrefs(prefsWith())
      expect(meta.content).toBe('#312d21')
    } finally {
      meta.remove()
      document.documentElement.style.removeProperty('--bg')
      document.documentElement.style.removeProperty('--border')
    }
  })
})

describe('save pill', () => {
  const ctx = (over: Partial<PillContext> = {}): PillContext => ({ nextWriteAt: null, persistent: null, storeError: false, readOnly: false, ...over })
  const at = (h: number, m: number): number => new Date(2026, 6, 20, h, m).getTime()
  const pillEl = (shell: Shell): HTMLElement => shell.root.querySelector('.tt-save-pill') as HTMLElement
  const text = (shell: Shell): string => shell.root.querySelector('.tt-save-pill-text')!.textContent!

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 20, 14, 32))
  })

  const cases: { name: string; health: FileHealth; ctx?: Partial<PillContext>; state: string; clickable: boolean; en: string; pt: string }[] = [
    { name: 'ok', health: { kind: 'ok', lastWrittenAt: null }, state: 'ok', clickable: false, en: 'Saved', pt: 'Salvo' },
    { name: 'writing', health: { kind: 'writing' }, state: 'writing', clickable: false, en: 'Writing file…', pt: 'Gravando arquivo…' },
    { name: 'permission', health: { kind: 'permission' }, state: 'permission', clickable: true, en: 'Grant access', pt: 'Conceder acesso' },
    { name: 'error', health: { kind: 'error' }, state: 'error', clickable: true, en: 'File not written', pt: 'Arquivo não gravado' },
    { name: 'store-error', health: { kind: 'ok', lastWrittenAt: null }, ctx: { storeError: true }, state: 'store-error', clickable: false, en: 'Browser storage failed', pt: 'Navegador sem armazenamento' },
    { name: 'readonly', health: { kind: 'ok', lastWrittenAt: null }, ctx: { readOnly: true }, state: 'readonly', clickable: false, en: 'Read-only', pt: 'Somente leitura' },
    { name: 'export', health: { kind: 'export', lastExportedAt: at(11, 32) }, state: 'export', clickable: true, en: 'Export file · 3 h ago', pt: 'Exportar arquivo · há 3 h' },
  ]

  test.each(cases)('$name: static label, state, and whether it responds to a click — in both locales', ({ health, ctx: over, state, clickable, en, pt }) => {
    const shell = setup()
    shell.setFileHealth(health, ctx(over))
    expect(text(shell)).toBe(en)
    expect(pillEl(shell).dataset.state).toBe(state)
    expect(pillEl(shell).classList.contains('tt-save-pill-clickable')).toBe(clickable)
    shell.applyPrefs(prefsWith('pt-BR'))
    expect(text(shell)).toBe(pt)
  })

  test('a read-only tab outranks everything, and a failed browser store outranks a file problem', () => {
    const shell = setup()
    shell.setFileHealth({ kind: 'permission' }, ctx({ storeError: true, readOnly: true }))
    expect(pillEl(shell).dataset.state).toBe('readonly')
    shell.setFileHealth({ kind: 'permission' }, ctx({ storeError: true }))
    expect(pillEl(shell).dataset.state).toBe('store-error')
  })

  test('the label is static: a time never appears in it, only in the hover', () => {
    const shell = setup()
    shell.setFileHealth({ kind: 'ok', lastWrittenAt: at(14, 0) }, ctx({ nextWriteAt: at(15, 0) }))
    expect(text(shell)).toBe('Saved')
  })

  describe('hover', () => {
    test('ok: the browser copy is current; when the file was written and when the next write is due', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: at(14, 0) }, ctx({ nextWriteAt: at(15, 0) }))
      expect(pillEl(shell).title).toBe('Browser copy is up to date. File written 2:00 PM · next write by 3:00 PM.')
      shell.applyPrefs(prefsWith('pt-BR'))
      expect(pillEl(shell).title).toBe('A cópia do navegador está em dia. Arquivo gravado às 14:00 · próxima gravação até 15:00.')
    })

    test('ok before the first write of the session says only when the next one is due', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: null }, ctx({ nextWriteAt: at(15, 32) }))
      expect(pillEl(shell).title).toBe('Browser copy is up to date. Next file write by 3:32 PM.')
    })

    test('storage that may be cleared adds a warning line but keeps the pill green', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: at(14, 0) }, ctx({ nextWriteAt: at(15, 0), persistent: false }))
      expect(pillEl(shell).title).toContain('Clearing site data would lose work not yet written to the file.')
      expect(pillEl(shell).dataset.state).toBe('ok')
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: at(14, 0) }, ctx({ nextWriteAt: at(15, 0), persistent: true }))
      expect(pillEl(shell).title).not.toContain('Clearing site data')
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: at(14, 0) }, ctx({ nextWriteAt: at(15, 0), persistent: null }))
      expect(pillEl(shell).title).not.toContain('Clearing site data')
    })

    test('each other state explains itself and says the work is safe', () => {
      const shell = setup()
      const title = (h: FileHealth, over?: Partial<PillContext>): string => { shell.setFileHealth(h, ctx(over)); return pillEl(shell).title }
      expect(title({ kind: 'writing' })).toBe('Writing the file…')
      expect(title({ kind: 'permission' })).toBe('The browser lost permission to write the file. Click to grant it. Your changes are still safe in the browser.')
      expect(title({ kind: 'error' })).toBe('The file could not be written. Your changes are still safe in the browser.')
      expect(title({ kind: 'ok', lastWrittenAt: null }, { storeError: true })).toBe('Edits are only in memory. Free up space or close the file to write it now.')
      expect(title({ kind: 'ok', lastWrittenAt: null }, { readOnly: true })).toBe('Another tab is editing this file.')
      expect(title({ kind: 'export', lastExportedAt: at(14, 0) })).toBe('This browser can\'t write the file by itself. Click to export a copy.')
    })
  })

  describe('export (a browser that cannot write the file silently)', () => {
    test('shows how long ago the last export was, and keeps it current as time passes', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'export', lastExportedAt: at(14, 32) }, ctx())
      expect(text(shell)).toBe('Export file · just now')
      vi.advanceTimersByTime(5 * 60_000)
      expect(text(shell)).toBe('Export file · 5 min ago')
      vi.advanceTimersByTime(60 * 60_000)
      expect(text(shell)).toBe('Export file · 1 h ago')
    })

    test('turns amber (stale) once the export is older than the write interval, not before', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'export', lastExportedAt: at(14, 0) }, ctx({ nextWriteAt: at(15, 0) }))
      expect(pillEl(shell).classList.contains('tt-save-pill-stale')).toBe(false)
      vi.advanceTimersByTime(28 * 60_000) // 3:00 PM exactly: due, not yet overdue
      expect(pillEl(shell).classList.contains('tt-save-pill-stale')).toBe(false)
      vi.advanceTimersByTime(60_000)
      expect(pillEl(shell).classList.contains('tt-save-pill-stale')).toBe(true)
    })

    test('stops refreshing once the pill leaves export mode, and on dispose', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'export', lastExportedAt: at(14, 32) }, ctx())
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: null }, ctx())
      expect(vi.getTimerCount()).toBe(0)
      shell.setFileHealth({ kind: 'export', lastExportedAt: at(14, 32) }, ctx())
      expect(vi.getTimerCount()).toBe(1)
      shell.dispose()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('clicks', () => {
    function clickWith(shell: Shell): ReturnType<typeof vi.fn> {
      const cb = vi.fn()
      shell.onPillAction(cb)
      pillEl(shell).click()
      return cb
    }

    test.each([
      ['permission', { kind: 'permission' } as FileHealth, 'regrant'],
      ['error', { kind: 'error' } as FileHealth, 'failure'],
      ['export', { kind: 'export', lastExportedAt: null } as FileHealth, 'export'],
    ])('%s: one click, one action', (_name, health, action) => {
      const shell = setup()
      shell.setFileHealth(health, ctx())
      const cb = clickWith(shell)
      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith(action)
    })

    test('ok, writing, store-error and read-only respond to nothing', () => {
      const shell = setup()
      for (const [h, over] of [
        [{ kind: 'ok', lastWrittenAt: at(14, 0) }, {}],
        [{ kind: 'writing' }, {}],
        [{ kind: 'ok', lastWrittenAt: null }, { storeError: true }],
        [{ kind: 'ok', lastWrittenAt: null }, { readOnly: true }],
      ] as [FileHealth, Partial<PillContext>][]) {
        shell.setFileHealth(h, ctx(over))
        expect(clickWith(shell)).not.toHaveBeenCalled()
      }
    })

    test('requestPillAction() is the same as clicking, for a control that mirrors the pill', () => {
      const shell = setup()
      const cb = vi.fn()
      shell.onPillAction(cb)
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: null }, ctx())
      shell.requestPillAction()
      expect(cb).not.toHaveBeenCalled()
      shell.setFileHealth({ kind: 'permission' }, ctx())
      shell.requestPillAction()
      expect(cb).toHaveBeenCalledWith('regrant')
    })
  })

  describe('subscribeSaveState', () => {
    test('fires at once with the formatted snapshot, then on every change, until unsubscribed', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: null }, ctx())
      const seen: SaveStatusInfo[] = []
      const off = shell.subscribeSaveState((i) => seen.push(i))
      expect(seen).toEqual([{ health: 'ok', label: 'Saved', title: expect.any(String), clickable: false, stale: false }])
      shell.setFileHealth({ kind: 'permission' }, ctx())
      expect(seen.at(-1)).toMatchObject({ health: 'permission', label: 'Grant access', clickable: true })
      off()
      shell.setFileHealth({ kind: 'error' }, ctx())
      expect(seen).toHaveLength(2)
    })

    test('read-only and storage-error snapshots carry their own health', () => {
      const shell = setup()
      const seen: SaveStatusInfo[] = []
      shell.subscribeSaveState((i) => seen.push(i))
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: null }, ctx({ readOnly: true }))
      shell.setFileHealth({ kind: 'ok', lastWrittenAt: null }, ctx({ storeError: true }))
      expect(seen.map((i) => i.health)).toEqual(['ok', 'readonly', 'store-error'])
    })

    test('a locale change re-sends the snapshot in the new language', () => {
      const shell = setup()
      shell.setFileHealth({ kind: 'permission' }, ctx())
      const seen: SaveStatusInfo[] = []
      shell.subscribeSaveState((i) => seen.push(i))
      shell.applyPrefs(prefsWith('pt-BR'))
      expect(seen.at(-1)!.label).toBe('Conceder acesso')
    })
  })

  test('the pill is the pill alone: no dirty marker, no fallback mark, no backup tab', () => {
    const shell = setup()
    expect(shell.root.querySelector('.tt-save-pill-fallback-mark')).toBeNull()
    expect(shell.root.querySelector('.tt-save-pill-backup-tab')).toBeNull()
    expect(shell.root.querySelector('.tt-save-pill-wrap')!.children).toHaveLength(1)
    expect(Object.keys(shell)).not.toContain('setSaveState')
    expect(Object.keys(shell)).not.toContain('setFallbackHint')
    expect(Object.keys(shell)).not.toContain('requestSaveNow')
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

describe('header right cluster', () => {
  test('order: save pill, view/help group, settings then close-file', () => {
    const shell = setup()
    const order = Array.from(shell.headerRight.querySelectorAll('.tt-save-pill-wrap, .tt-btn')).map(
      (e) => ['tt-save-pill-wrap', 'tt-btn-fullscreen', 'tt-btn-help', 'tt-btn-settings', 'tt-btn-close-file'].find((c) => e.classList.contains(c))
    )
    expect(order).toEqual(['tt-save-pill-wrap', 'tt-btn-fullscreen', 'tt-btn-help', 'tt-btn-settings', 'tt-btn-close-file'])
  })

  test('there is no favorites ★ button any more', () => {
    expect(setup().root.querySelector('.tt-btn-favorites')).toBeNull()
  })
})
