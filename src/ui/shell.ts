// src/ui/shell.ts
import type { Prefs } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

export interface Shell {
  root: HTMLElement
  headerLeft: HTMLElement
  headerRight: HTMLElement
  sidebar: HTMLElement
  panesRoot: HTMLElement
  setSaveState(state: SaveState): void
  /**
   * Task 25 re-review item #4b: fallback mode (no FS handle — the browser
   * doesn't support the File System Access API) has no silent auto-save;
   * every save is a download the user must explicitly trigger with Ctrl+S.
   * When `active` is true, the save indicator's tooltip in the `dirty` state
   * spells that out instead of just saying "Unsaved" with no next step.
   * main.ts sets this once, at document-open time, from `!session.handle`.
   */
  setFallbackHint(active: boolean): void
  applyPrefs(prefs: Prefs): void
  setTitle(fileName: string | null, dirty: boolean): void
  /** Registers the click handler for the header ⚙ button (Task 24: opens the preferences modal). */
  onSettings(cb: () => void): void
  /** Registers the click handler for the header ❓ button (opens the global help modal). */
  onHelp(cb: () => void): void
  /** Registers the click handler for the "Team Tracker" title button (opens the command palette — same action as Ctrl+K). */
  onAppNameClick(cb: () => void): void
  /** Registers the click handler for the header 🔒 button (saves and closes the current file, returning to the start screen — same action as Ctrl+Shift+L). */
  onCloseFile(cb: () => void): void
}

const SAVE_STATE_INFO: Record<SaveState, { icon: string; key: MsgKey }> = {
  saved: { icon: '✓', key: 'save_saved' },
  dirty: { icon: '●', key: 'save_dirty' },
  saving: { icon: '…', key: 'save_saving' },
  error: { icon: '⚠', key: 'save_error' },
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
  } else {
    document.documentElement.requestFullscreen().catch(() => {})
  }
}

/**
 * Design note: createShell() takes an initial `Locale` for the very first
 * render (before any `Doc`/`Prefs` exists), rather than exposing a separate
 * `setLocale()` method. Since `Prefs` already carries `locale`, `applyPrefs()`
 * re-syncs the shell's closed-over locale on every call — so when Task 24's
 * settings panel changes the locale and calls `applyPrefs()` again, the
 * save-indicator tooltip (the shell's only i18n string) picks up the new
 * locale the next time `setSaveState()` runs. This avoids a redundant API
 * while keeping locale-consuming logic in one place (`applyPrefs`).
 */
export function createShell(locale: Locale): Shell {
  let currentLocale = locale
  let currentTheme: Prefs['theme'] = 'system'
  const mq = window.matchMedia('(prefers-color-scheme: dark)')

  const headerLeft = el('div', { class: 'tt-header-left' })
  const headerRight = el('div', { class: 'tt-header-right' })

  // Appended first so it renders to the left of the search bar, which
  // mountSearch() (src/ui/search-ui.ts) appends into headerLeft afterwards.
  let appNameHandler: (() => void) | null = null
  const appNameBtn = el(
    'button',
    { class: 'tt-app-name', type: 'button', title: t(locale, 'app_name_button_title'), onclick: () => appNameHandler?.() },
    t(locale, 'app_name')
  )
  headerLeft.appendChild(appNameBtn)

  const saveIndicator = el('span', { class: 'tt-save-indicator' })

  const fullscreenBtn = el(
    'button',
    { class: 'tt-btn tt-btn-fullscreen', type: 'button', title: t(locale, 'fullscreen'), onclick: () => toggleFullscreen() },
    '⛶'
  )
  let closeFileHandler: (() => void) | null = null
  const closeFileBtn = el(
    'button',
    { class: 'tt-btn tt-btn-close-file', type: 'button', title: t(locale, 'close_file_title'), onclick: () => closeFileHandler?.() },
    '🔒'
  )
  let settingsHandler: (() => void) | null = null
  const settingsBtn = el(
    'button',
    { class: 'tt-btn tt-btn-settings', type: 'button', title: t(locale, 'settings'), onclick: () => settingsHandler?.() },
    '⚙'
  )
  let helpHandler: (() => void) | null = null
  const helpBtn = el(
    'button',
    { class: 'tt-btn tt-btn-help', type: 'button', title: t(locale, 'help_global_title'), onclick: () => helpHandler?.() },
    '❓'
  )

  headerRight.append(saveIndicator, fullscreenBtn, helpBtn, closeFileBtn, settingsBtn)

  const header = el('header', { class: 'tt-header' }, headerLeft, headerRight)
  const sidebar = el('aside', { class: 'tt-sidebar' })
  const panesRoot = el('div', { class: 'tt-panes' })
  const body = el('div', { class: 'tt-body' }, sidebar, panesRoot)
  const root = el('div', { class: 'tt-shell' }, header, body)

  function resolveTheme(theme: Prefs['theme']): 'light' | 'dark' {
    if (theme === 'system') return mq.matches ? 'dark' : 'light'
    return theme
  }

  function applyTheme(theme: Prefs['theme']): void {
    document.documentElement.dataset.theme = resolveTheme(theme)
  }

  mq.addEventListener('change', () => {
    if (currentTheme === 'system') applyTheme('system')
  })

  let currentState: SaveState = 'saved'
  let fallbackHint = false

  function setSaveState(state: SaveState): void {
    currentState = state
    const { icon, key } = SAVE_STATE_INFO[state]
    saveIndicator.textContent = icon
    let title = t(currentLocale, key)
    if (state === 'dirty' && fallbackHint) {
      title += ` — ${t(currentLocale, 'save_fallback_hint')}`
    }
    saveIndicator.title = title
    saveIndicator.dataset.state = state
  }

  function setFallbackHint(active: boolean): void {
    fallbackHint = active
    setSaveState(currentState)
  }

  function applyPrefs(prefs: Prefs): void {
    currentLocale = prefs.locale
    currentTheme = prefs.theme
    applyTheme(prefs.theme)
    document.documentElement.dataset.font = prefs.font
    document.documentElement.dataset.size = prefs.fontSize
  }

  function setTitle(fileName: string | null, dirty: boolean): void {
    document.title =
      `Team Tracker v${__APP_VERSION__}` + (fileName ? ` — ${fileName}` : '') + (dirty ? ' ●' : '')
  }

  function onSettings(cb: () => void): void {
    settingsHandler = cb
  }

  function onHelp(cb: () => void): void {
    helpHandler = cb
  }

  function onAppNameClick(cb: () => void): void {
    appNameHandler = cb
  }

  function onCloseFile(cb: () => void): void {
    closeFileHandler = cb
  }

  setSaveState('saved')

  return { root, headerLeft, headerRight, sidebar, panesRoot, setSaveState, setFallbackHint, applyPrefs, setTitle, onSettings, onHelp, onAppNameClick, onCloseFile }
}
