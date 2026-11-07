import { showHelp, closeHelp, helpTabFor, appWindowCommand, type HelpTab } from '../src/ui/help'
import { createShell } from '../src/ui/shell'
import { createEmptyDocument } from '../src/core/document'
import { dicts, type Locale } from '../src/core/i18n'

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
  closeHelp()
  document.body.innerHTML = ''
})

const tabButtons = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-tab-btn'))
const activeTab = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.tt-prefs-tab-btn.active')!
const panelText = (): string => document.querySelector('.tt-prefs-content')!.textContent!
const codes = (): (string | null | undefined)[] => Array.from(document.querySelectorAll('.tt-help-table tr')).map((r) => r.querySelector('.tt-help-code')?.textContent)
const headings = (): string[] => Array.from(document.querySelectorAll('.tt-help-heading')).map((h) => h.textContent!)

/** Clicks the tab whose label starts with `label`. */
function openTab(label: string): void {
  tabButtons().find((b) => b.textContent!.startsWith(label))!.click()
}

test('shell header has a ❓ help button that fires the registered onHelp callback', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const cb = vi.fn()
  shell.onHelp(cb)

  const btn = Array.from(shell.root.querySelectorAll('button')).find((b) => b.classList.contains('tt-btn-help'))!
  expect(btn).not.toBeUndefined()
  btn.click()

  expect(cb).toHaveBeenCalledOnce()
})

test('shell header shows the app name, before the search bar\'s mount point', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)

  const nameEl = shell.headerLeft.querySelector('.tt-app-name')
  expect(nameEl?.textContent).toBe('Team Tracker')
  // headerLeft is where mountSearch() appends the search bar afterwards —
  // the app name must already be there so it renders to the left of it.
  expect(shell.headerLeft.firstElementChild).toBe(nameEl)
})

test('the app name is a clickable button that fires the registered onAppNameClick callback', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const cb = vi.fn()
  shell.onAppNameClick(cb)

  const btn = shell.headerLeft.querySelector('.tt-app-name') as HTMLButtonElement
  expect(btn.tagName).toBe('BUTTON')
  btn.click()

  expect(cb).toHaveBeenCalledOnce()
})

test('setAppNameEnabled(false) disables the button so no click reaches the palette', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const cb = vi.fn()
  shell.onAppNameClick(cb)
  const btn = shell.headerLeft.querySelector('.tt-app-name') as HTMLButtonElement

  shell.setAppNameEnabled(false)
  btn.click()
  expect(cb).not.toHaveBeenCalled()

  shell.setAppNameEnabled(true)
  btn.click()
  expect(cb).toHaveBeenCalledOnce()
})

test('shell header has a 🔒 close-file button that fires the registered onCloseFile callback', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const cb = vi.fn()
  shell.onCloseFile(cb)

  const btn = Array.from(shell.root.querySelectorAll('button')).find((b) => b.classList.contains('tt-btn-close-file'))!
  expect(btn).not.toBeUndefined()
  btn.click()

  expect(cb).toHaveBeenCalledOnce()
})

test('the app name button keeps its chevron affordance across a locale switch', () => {
  stubMatchMedia()
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const btn = shell.headerLeft.querySelector('.tt-app-name') as HTMLButtonElement
  expect(btn.querySelector('.tt-app-name-chevron svg')).not.toBeNull()
  shell.applyPrefs({ ...createEmptyDocument('pt-BR').prefs })
  expect(btn.querySelector('.tt-app-name-chevron svg')).not.toBeNull()
  expect(btn.textContent).toBe('Team Tracker')
})

describe('tabs', () => {
  test('one tab per module family, Global first, in a vertical tablist', () => {
    showHelp('en-US')
    expect(tabButtons().map((b) => b.textContent)).toEqual(['Global', 'Editor', 'Daily notes', 'People', 'Tasks', 'Milestones', 'Risks'])
    expect(document.querySelector('[role="tablist"]')!.getAttribute('aria-orientation')).toBe('vertical')
    expect(document.querySelector('[role="tabpanel"]')).not.toBeNull()
  })

  test('opens on Global by default', () => {
    showHelp('en-US')
    expect(activeTab().textContent).toBe('Global')
  })

  test('opens on the tab of the focused pane\'s module, which keeps a "pane" mark when the reader browses away', () => {
    showHelp('en-US', { pane: 'risks' })
    expect(activeTab().textContent).toContain('Risks')
    openTab('Global')
    expect(activeTab().textContent).toBe('Global')
    const marked = tabButtons().filter((b) => b.querySelector('.tt-help-pane-mark'))
    expect(marked.map((b) => b.textContent)).toEqual(['Risks' + 'pane'])
  })

  test('an explicit tab wins over the pane, and no pane means no mark', () => {
    showHelp('en-US', { tab: 'editor' })
    expect(activeTab().textContent).toBe('Editor')
    expect(document.querySelector('.tt-help-pane-mark')).toBeNull()
  })

  test('every module kind maps to a tab, and an empty pane to Global', () => {
    const expected: Record<string, HelpTab> = {
      daily: 'notes', general: 'editor', person: 'editor', stakeholders: 'people', members: 'people',
      actions: 'tasks', milestones: 'milestones', risks: 'risks',
    }
    for (const [kind, tab] of Object.entries(expected)) {
      expect(helpTabFor(kind as Parameters<typeof helpTabFor>[0])).toBe(tab)
    }
    expect(helpTabFor(undefined)).toBe('global')
  })

  test('clicking a tab swaps the panel and resets its scroll', () => {
    showHelp('en-US')
    const panel = document.querySelector<HTMLElement>('.tt-prefs-content')!
    panel.scrollTop = 120
    openTab('Tasks')
    expect(activeTab().textContent).toBe('Tasks')
    expect(panel.scrollTop).toBe(0)
    expect(panel.getAttribute('aria-labelledby')).toBe(activeTab().id)
    expect(panelText()).not.toContain('Alt+1')
  })

  test('arrow keys move focus along the rail without activating, Enter activates', () => {
    showHelp('en-US')
    const rail = document.querySelector('[role="tablist"]')!
    activeTab().focus()
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(tabButtons()[1])
    expect(activeTab().textContent).toBe('Global')
    ;(document.activeElement as HTMLElement).click()
    expect(activeTab().textContent).toBe('Editor')
  })

  test('closeHelp closes an open Help and says false when none is open', () => {
    expect(closeHelp()).toBe(false)
    showHelp('en-US')
    expect(document.querySelector('.tt-modal-dialog')).not.toBeNull()
    expect(closeHelp()).toBe(true)
    expect(document.querySelector('.tt-modal-dialog')).toBeNull()
    expect(closeHelp()).toBe(false)
  })

  test('opening Help again replaces the open one instead of stacking a second', () => {
    showHelp('en-US')
    showHelp('en-US', { tab: 'editor' })
    expect(document.querySelectorAll('.tt-modal-dialog')).toHaveLength(1)
    expect(activeTab().textContent).toBe('Editor')
  })

  test('closing by the close mark frees the next closeHelp', () => {
    showHelp('en-US')
    document.querySelector<HTMLButtonElement>('.tt-modal-close')!.click()
    expect(closeHelp()).toBe(false)
  })

  test('the close mark closes the dialog, and there is no OK row', () => {
    showHelp('en-US')
    expect(document.querySelector('.tt-modal-buttons')!.children).toHaveLength(0)
    document.querySelector<HTMLButtonElement>('.tt-modal-close')!.click()
    expect(document.querySelector('.tt-modal-dialog')).toBeNull()
  })

  test('focus starts on the active tab, not on the close mark', () => {
    showHelp('en-US', { pane: 'actions' })
    expect(document.activeElement).toBe(activeTab())
  })

  test('every tab renders in both locales with no missing text', () => {
    for (const locale of ['en-US', 'pt-BR'] as Locale[]) {
      showHelp(locale)
      for (let i = 0; i < tabButtons().length; i++) {
        tabButtons()[i]!.click()
        const text = panelText()
        expect(text.length).toBeGreaterThan(40)
        expect(text).not.toMatch(/\b(help|module)_[a-z_]+\b/)
        expect(document.querySelectorAll('.tt-help-table tr').length + document.querySelectorAll('.tt-help-text').length).toBeGreaterThan(0)
      }
      document.body.innerHTML = ''
    }
  })

  test('every help key exists in both locales', () => {
    const keys = Object.keys(dicts['en-US']).filter((k) => k.startsWith('help_'))
    for (const k of keys) expect(dicts['pt-BR']).toHaveProperty(k)
  })
})

describe('Global tab', () => {
  test('lists app-level shortcuts and the app-window recipe', () => {
    showHelp('en-US')
    const text = panelText()
    expect(text).toContain('Alt+1')
    // Task 12 moved the command palette to Ctrl+Shift+K globally; the global
    // help table must name that, not the old Ctrl+K.
    expect(text).toContain('Ctrl+Shift+K')
    expect(text).toContain('--app="')
    // Filled with this page's own URL, not a placeholder path.
    expect(text).toContain(location.href.split('#')[0])
    expect(text).not.toContain('caminho/para')
  })

  test('documents Ctrl+Z as the app-wide undo of a delete or a move, and says text fields keep their own', () => {
    showHelp('en-US')
    const row = Array.from(document.querySelectorAll('.tt-help-table tr')).find((r) => r.querySelector('.tt-help-code')?.textContent === 'Ctrl+Z')!
    expect(row.textContent).toContain('Undo the last delete or move')
    expect(row.textContent).toContain('In a text field it undoes typing')
  })

  test('F1 opens Help and F2 … F8 switch module', () => {
    showHelp('en-US')
    const rows = Array.from(document.querySelectorAll('.tt-help-table tr'))
    const row = (code: string): Element => rows.find((r) => r.querySelector('.tt-help-code')?.textContent === code)!
    expect(row('F1').textContent).toContain('press again to close')
    expect(row('F2 … F8').textContent).toContain('Switch the focused pane')
    expect(codes()).not.toContain('F1 … F7')
  })

  test('keeps module-only keys off the page: rows, board, days and the editor live on their own tabs', () => {
    showHelp('en-US')
    const rows = codes()
    for (const gone of ['Alt+N', 'Delete', 'Home / End / PgUp / PgDn', 'Alt+[ / Alt+] / Alt+T', '↑ / ↓, t, Alt+↓', 'Esc']) expect(rows).not.toContain(gone)
    expect(rows).toContain('Ctrl+Enter')
  })

  test('omits the app-window recipe in the PWA build (opts.pwa: true) — moot once already installable/standalone', () => {
    showHelp('en-US', { pwa: true })
    const text = panelText()
    expect(text).toContain('Alt+1') // shortcuts stay
    expect(text).not.toContain('--app=')
  })

  test('draws button references as the same stroke icons the buttons use, not emoji glyphs', () => {
    showHelp('en-US')
    const cells = Array.from(document.querySelectorAll('.tt-help-code'))
    const cellFor = (needle: string): Element => cells.find((c) => c.textContent?.includes(needle))!

    expect(cellFor('Ctrl+Alt+L').querySelector('.tt-icon-lock')).not.toBeNull()
    expect(cellFor('F11').querySelector('.tt-icon-fullscreen')).not.toBeNull()
    const history = cells.find((c) => c.querySelector('.tt-icon-back') && c.querySelector('.tt-icon-next'))
    expect(history?.querySelector('.tt-icon-mouse')).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/[🔒⛶◀▶🖱]/u)
  })

  test('explains saving: the browser copy, when the file is written, and to close with the lock', () => {
    showHelp('en-US', { pwa: true })
    const text = panelText()
    expect(text).toContain('How saving works')
    expect(text).toContain('working copy kept in the browser')
    expect(text).toContain('Ctrl+Alt+L')
    expect(text).toContain('There is no Save command')
    expect(text).not.toMatch(/Ctrl\+S(?!hift)/)
    document.body.innerHTML = ''
    showHelp('pt-BR', { pwa: true })
    expect(panelText()).toContain('Como o salvamento funciona')
  })
})

describe('Editor tab', () => {
  test('lists the code-block / blockquote / link shortcuts and syntax', () => {
    showHelp('en-US', { tab: 'editor' })
    const text = panelText()
    expect(text).not.toContain('Ctrl+E') // inline code was removed
    expect(text).toContain('Ctrl+Shift+E') // code block shortcut
    expect(text).toContain('Ctrl+Shift+9') // blockquote shortcut
    expect(text).toContain('Ctrl+K') // link shortcut (Task 12: Ctrl+K inserts a link in the editor)
    expect(text).toContain('```') // markdown syntax row for code block
    expect(text).toContain('> text') // markdown syntax row for blockquote
    expect(text).toContain('[text](url)') // markdown syntax row for link
    expect(text).toContain('Ctrl+click / middle click') // open-link gesture row
    expect(text).toContain('Open link in a new tab')
    expect(text).not.toMatch(/texto|clique/)
  })

  test('groups the shortcuts by what they do and puts undo/redo last, not first', () => {
    showHelp('en-US', { tab: 'editor' })
    expect(headings()).toEqual(['Inline formatting', 'Blocks', 'Links', 'Markdown syntax', 'References (@)', 'Templates (/)', 'Pictures', 'Leaving the editor', 'History'])
    const shortcuts = codes()
    expect(shortcuts[0]).toBe('Ctrl+B')
    const text = panelText()
    expect(text).toContain('Ctrl+Z')
    expect(text).toContain('Ctrl+Shift+Z / Ctrl+Y')
    expect(text).toContain('Undo')
    expect(text).toContain('Redo')
    expect(text.indexOf('Ctrl+Z')).toBeGreaterThan(text.indexOf('Ctrl+K'))
  })

  test('(pt-BR) keeps markdown examples and key names in Portuguese', () => {
    showHelp('pt-BR', { tab: 'editor' })
    const text = panelText()
    expect(text).toContain('**texto**')
    expect(text).toContain('Ctrl+clique / clique do meio')
  })

  test('explains pictures: how to add them, the formats and the budget', () => {
    showHelp('en-US', { tab: 'editor' })
    const text = panelText()
    expect(text).toContain('Pictures')
    expect(text).toContain('PNG, JPEG, WebP, GIF, AVIF and BMP')
    expect(text).toContain('150 MB')
    document.body.innerHTML = ''
    showHelp('pt-BR', { tab: 'editor' })
    expect(panelText()).toContain('Imagens')
  })

  test('no longer carries the app-window recipe', () => {
    showHelp('en-US', { tab: 'editor' })
    expect(document.body.textContent!).not.toContain('--app=')
  })

  test('explains ctrl/middle-click for the secondary pane', () => {
    showHelp('en-US', { tab: 'editor' })
    const text = panelText()
    expect(text).toContain('Ctrl')
    expect(text.toLowerCase()).toContain('middle')
  })

  test('(pt-BR) also explains ctrl/middle-click for the secondary pane', () => {
    showHelp('pt-BR', { tab: 'editor' })
    const text = panelText()
    expect(text).toContain('Ctrl')
    expect(text.toLowerCase()).toContain('meio') // "botão do meio" = middle button
  })
})

describe('module tabs', () => {
  // Regression: Enter and Space are two different actions on a focused
  // risk/milestone row or kanban card (Enter expands/opens, Space opens the
  // context menu) — the help table used to document them as one merged
  // "Enter / Espaço" row sharing a single description, which was wrong once
  // they diverged.
  test('document Enter and Space as separate row/card shortcuts, not one merged row', () => {
    showHelp('en-US', { tab: 'tasks' })
    const rows = Array.from(document.querySelectorAll('.tt-help-table tr'))
    const all = codes()

    expect(all).not.toContain('Enter / Espaço')
    expect(all).not.toContain('Enter / Space')
    expect(all).toContain('Enter')
    expect(all).toContain('Space')

    const enterRow = rows.find((r) => r.querySelector('.tt-help-code')?.textContent === 'Enter')!
    const spaceRow = rows.find((r) => r.querySelector('.tt-help-code')?.textContent === 'Space')!
    expect(enterRow.textContent).not.toBe(spaceRow.textContent)
  })

  test('Tasks, Milestones and Risks share the Lists & cards and Date fields groups, written once', () => {
    const lists: string[] = []
    for (const label of ['Tasks', 'Milestones', 'Risks']) {
      showHelp('en-US', { tab: label.toLowerCase() as HelpTab })
      expect(headings()).toContain('Lists & cards')
      expect(headings()).toContain('Date fields')
      const sections = Array.from(document.querySelectorAll('.tt-help-section')).filter((s) => s.querySelector('.tt-help-heading')?.textContent === 'Lists & cards')
      expect(sections[0]!.querySelector('.tt-help-badge')).not.toBeNull()
      lists.push(sections[0]!.textContent!)
      document.body.innerHTML = ''
    }
    expect(new Set(lists).size).toBe(1)
  })

  test('Ctrl+Z is documented on the Global tab only, never as a list row', () => {
    for (const tab of ['notes', 'people', 'tasks', 'milestones', 'risks'] as HelpTab[]) {
      showHelp('en-US', { tab })
      expect(codes()).not.toContain('Ctrl+Z')
      document.body.innerHTML = ''
    }
  })

  test('People navigate by org chart: its section replaces the ↑/↓ row and the chord moves the person', () => {
    showHelp('en-US', { tab: 'people' })
    expect(headings()).toEqual(['Org chart', 'Lists & cards'])
    expect(codes()).not.toContain('↑ / ↓')
    expect(codes()).toContain('↑ / ↓ (← / →)')
    const move = Array.from(document.querySelectorAll('.tt-help-table tr')).find((r) => r.querySelector('.tt-help-code')?.textContent === 'Ctrl+← / → / ↑ / ↓')
    expect(move?.textContent).toContain('Move the person')
    expect(headings()).not.toContain('Date fields')
  })

  test('Tasks name the board move chord, Risks the risk move, Milestones neither', () => {
    showHelp('en-US', { tab: 'tasks' })
    expect(panelText()).toContain('Move the task across and within columns')
    document.body.innerHTML = ''
    showHelp('en-US', { tab: 'risks' })
    expect(panelText()).toContain('Move the risk')
    document.body.innerHTML = ''
    showHelp('en-US', { tab: 'milestones' })
    expect(codes()).not.toContain('Ctrl+← / → / ↑ / ↓')
  })

  test('Milestones and Risks say how to leave a follow-up', () => {
    for (const tab of ['milestones', 'risks'] as HelpTab[]) {
      showHelp('en-US', { tab })
      expect(panelText()).toContain('From a follow-up back to its row')
      document.body.innerHTML = ''
    }
  })

  test('Daily notes list the day navigation keys and send formatting questions to the Editor tab', () => {
    showHelp('en-US', { tab: 'notes' })
    expect(codes()).toContain('Alt+[ / Alt+] / Alt+T')
    expect(codes()).toContain('Alt+, / Alt+.')
    const link = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-prefs-content button')).find((b) => b.textContent!.includes('Editor tab'))!
    link.click()
    expect(activeTab().textContent).toBe('Editor')
    expect(document.activeElement).toBe(activeTab())
    expect(headings()[0]).toBe('Inline formatting')
  })
})

describe('appWindowCommand', () => {
  const url = 'file:///C:/Users/me/My%20Apps/app.html#frag'
  const chrome = { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }, { brand: 'Not A Brand' }] }
  const edge = { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] }

  test('Windows Chrome and Edge use their Run-box launchers, with the quoted URL minus the hash', () => {
    expect(appWindowCommand(url, { ...chrome, platform: 'Windows' })).toBe('chrome --app="file:///C:/Users/me/My%20Apps/app.html"')
    expect(appWindowCommand(url, { ...edge, platform: 'Windows' })).toBe('msedge --app="file:///C:/Users/me/My%20Apps/app.html"')
  })

  test('macOS goes through open -na with the app bundle name', () => {
    expect(appWindowCommand('file:///a/app.html', { ...chrome, platform: 'macOS' })).toBe('open -na "Google Chrome" --args --app="file:///a/app.html"')
    expect(appWindowCommand('file:///a/app.html', { ...edge, platform: 'macOS' })).toBe('open -na "Microsoft Edge" --args --app="file:///a/app.html"')
  })

  test('Linux uses the packaged binary names; unbranded Chromium is told apart from Chrome', () => {
    expect(appWindowCommand('file:///a/app.html', { ...chrome, platform: 'Linux' })).toBe('google-chrome --app="file:///a/app.html"')
    expect(appWindowCommand('file:///a/app.html', { brands: [{ brand: 'Chromium' }], platform: 'Linux' })).toBe('chromium --app="file:///a/app.html"')
  })

  test('without userAgentData it reads the UA string, and falls back to Chrome when nothing matches', () => {
    expect(appWindowCommand('file:///a/app.html', undefined, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120')).toBe('msedge --app="file:///a/app.html"')
    expect(appWindowCommand('file:///a/app.html', undefined, '')).toBe('google-chrome --app="file:///a/app.html"')
  })
})

describe('app-window command box', () => {
  test('has a copy button that puts the command on the clipboard and flashes a confirmation', () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      showHelp('en-US')
      const command = document.querySelector('.tt-help-code-block')!.textContent!
      const btn = document.querySelector<HTMLButtonElement>('.tt-help-cmd-copy')!
      expect(btn.title).toBe('Copy code')

      btn.click()

      expect(writeText).toHaveBeenCalledWith(command)
      expect(btn.title).toBe('Copied!')
      vi.advanceTimersByTime(1000)
      expect(btn.title).toBe('Copy code')
    } finally {
      vi.useRealTimers()
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  test('says the executable name is a guess to be adjusted', () => {
    showHelp('en-US')
    expect(document.querySelector('.tt-help-hint')!.textContent).toMatch(/guess/i)
  })

  test('the hint and copy button are absent in the PWA build with the rest of the recipe', () => {
    showHelp('en-US', { pwa: true })
    expect(document.querySelector('.tt-help-hint')).toBeNull()
    expect(document.querySelector('.tt-help-cmd-copy')).toBeNull()
  })
})
