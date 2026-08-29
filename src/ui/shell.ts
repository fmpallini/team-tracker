// src/ui/shell.ts
import type { Prefs } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { formatHHMM } from '../core/date'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'permission'

/** Already-formatted (current-locale) snapshot of the save-state pill — what `subscribeSaveState` broadcasts, so a mirroring control (e.g. action-items.ts's expanded-modal header pill) never needs its own copy of SAVE_STATE_KEY/renderSaveIndicator's formatting rules. */
export interface SaveStatusInfo {
  state: SaveState
  label: string
  title: string
}

export interface Shell {
  root: HTMLElement
  headerLeft: HTMLElement
  /** Center header slot, between the search bar and the right-side buttons — empty/unused by the shell itself; sidebar.ts fills it with the active team's name when the team sidebar is collapsed. */
  headerCenter: HTMLElement
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
  /** Registers the click handler for the "Team Tracker" title button (opens the command palette — same action as Ctrl+Shift+K). */
  onAppNameClick(cb: () => void): void
  /**
   * Enables/disables the "Team Tracker" title button. Mirrors the search bar's
   * empty-document state (src/ui/search-ui.ts): with no team there is nothing
   * the palette can open, so the button shouldn't invite a click.
   */
  setAppNameEnabled(enabled: boolean): void
  /** Registers the click handler for the header 🔒 button (saves and closes the current file, returning to the start screen — same action as Ctrl+Alt+L). */
  onCloseFile(cb: () => void): void
  /** Registers the click handler for the save-state pill — clicking it while a save is pending ('dirty'/'error') triggers an explicit save, same as Ctrl+S. */
  onSaveRequest(cb: () => void): void
  /**
   * Registers the click handler for the save-state pill while it's in the
   * 'permission' state — a lapsed write grant on the primary file, the
   * backup file, or both. Separate from `onSaveRequest` because the recovery
   * action is different: re-requesting permission(s), not just retrying a
   * write that would fail the same way again.
   */
  onGrantRequest(cb: () => void): void
  /**
   * Same effect as clicking the real save-state pill — an explicit save while
   * a save is pending ('dirty'/'error'), the grant-recovery action while
   * 'permission', a no-op otherwise — for a caller that mirrors the pill in
   * its own UI (action-items.ts's expanded-modal header "force save") instead
   * of the header pill itself.
   */
  requestSaveNow(): void
  /**
   * Subscribes to every save-state pill update — state plus its
   * already-formatted (current-locale) label/tooltip, the same strings the
   * real pill renders. Fires once immediately with the current snapshot (a
   * fresh subscriber doesn't wait for the next change), then again on every
   * subsequent `setSaveState`/`setFallbackHint`/locale-changing `applyPrefs`
   * call. Returns an unsubscribe function.
   */
  subscribeSaveState(cb: (info: SaveStatusInfo) => void): () => void
  /**
   * Driven by the responsive-layout ResizeObserver (src/ui/responsive.ts):
   * below a width threshold, force-hides every non-mandatory header element
   * at once — sidebar collapse toggle, app name, search bar, the active-team
   * indicator (whatever sidebar.ts put in headerCenter), the save-state pill,
   * fullscreen, and help — leaving only the close-file (🔒) and settings (⚙)
   * buttons. A single threshold covering the whole optional set, rather than
   * one per element: hiding them one at a time just relocates the point
   * where the two fixed/floored clusters either side of them collide
   * instead of removing it, since close-file+settings is the only content
   * that actually needs guaranteed room.
   */
  setHeaderCompactSpaceHidden(hidden: boolean): void
  /**
   * Releases the OS-theme `matchMedia` listener this shell registered.
   *
   * Load-bearing, not hygiene: `matchMedia`'s MediaQueryList outlives any one
   * document, so a shell that never unregisters stays reachable from it
   * forever — and because that handler shares `createShell`'s closure scope
   * with `setSaveState`/`applyPrefs`/etc., which capture `root`, keeping it
   * alive pins the shell's *entire DOM tree*. Every close-file → open-file
   * cycle then retained a whole previous UI (~340 nodes, ~140 listeners
   * measured in e2e/leak.spec.ts). main.ts calls this from its per-document
   * `disposers`.
   */
  dispose(): void
}

const SAVE_STATE_KEY: Record<SaveState, MsgKey> = {
  saved: 'save_saved',
  dirty: 'save_dirty',
  saving: 'save_saving',
  error: 'save_error',
  permission: 'save_permission',
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
  const headerCenter = el('div', { class: 'tt-header-center' })
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

  // An inline SVG (currentColor stroke) rather than a clock emoji: emoji
  // glyph metrics vary by platform font and never sit flush with the pill's
  // text baseline, and a stroke icon can pick up the pill's per-state color
  // (green/red/etc.) for free instead of staying a fixed glyph color.
  const savePillIcon = el('span', { class: 'tt-save-pill-icon', 'aria-hidden': 'true' })
  savePillIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8.25L10.25 9.75"/></svg>'
  const savePillText = el('span', { class: 'tt-save-pill-text' })
  // Shown only in fallback mode (no File System Access API), where every save
  // is a download the user must trigger. Hidden by default; renderSaveIndicator
  // flips it from `fallbackHint`.
  const savePillFallbackMark = el('span', { class: 'tt-save-pill-fallback-mark', 'aria-hidden': 'true' }, '⤓')
  savePillFallbackMark.hidden = true
  let saveRequestHandler: (() => void) | null = null
  let grantRequestHandler: (() => void) | null = null
  const saveIndicator = el(
    'span',
    {
      class: 'tt-save-pill',
      onclick: () => requestSaveNow(),
    },
    savePillIcon,
    savePillText,
    savePillFallbackMark
  )

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

  const header = el('header', { class: 'tt-header' }, headerLeft, headerCenter, headerRight)
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

  const onSystemThemeChange = (): void => {
    if (currentTheme === 'system') applyTheme('system')
  }
  mq.addEventListener('change', onSystemThemeChange)

  let currentState: SaveState = 'saved'
  let fallbackHint = false
  // Raw hours/minutes, not a pre-formatted string — formatting happens in
  // computeSaveInfo() so a locale switch reformats the last-saved time
  // immediately (12h/24h), instead of leaving it stuck in whatever format
  // was current when the save actually happened.
  let lastSavedAt: { h: number; m: number } | null = null
  const saveStateSubscribers = new Set<(info: SaveStatusInfo) => void>()

  /** `label`/`title` computation shared by the real pill (renderSaveIndicator) and every subscribeSaveState() listener — one place text/tooltip rules live, so a mirroring control never drifts from the real pill's wording. */
  function computeSaveInfo(): SaveStatusInfo {
    const label = t(currentLocale, SAVE_STATE_KEY[currentState])
    const time = lastSavedAt ? formatHHMM(lastSavedAt.h, lastSavedAt.m, currentLocale) : null
    // `label · time` is right for 'saved' ("Saved · 5:11 PM") and 'error', but
    // reads wrong for 'dirty': the timestamp is the last *successful* save,
    // and joining it to "Unsaved" with a middot makes it look like the moment
    // things went wrong. The dirty state names what the time refers to.
    const text =
      currentState === 'saving' || !time ? label
      : currentState === 'dirty' ? t(currentLocale, 'save_dirty_since', { time })
      : `${label} · ${time}`
    let title = label
    if (currentState === 'dirty' && fallbackHint) {
      title += ` — ${t(currentLocale, 'save_fallback_hint')}`
    }
    return { state: currentState, label: text, title }
  }

  // Redraws the pill from `currentState`/`lastSavedAt`/`fallbackHint`/
  // `currentLocale` without touching `lastSavedAt` — callers that only need
  // to refresh the displayed text (locale switch, fallback-hint toggle) use
  // this instead of setSaveState() so a re-render never re-stamps the
  // timestamp as if a fresh save had just happened.
  function renderSaveIndicator(): void {
    const info = computeSaveInfo()
    savePillText.textContent = info.label
    savePillIcon.classList.toggle('tt-save-pill-spin', currentState === 'saving')
    saveIndicator.title = info.title
    // Fallback mode is permanent for the life of the file, so it belongs on
    // the pill rather than in a sticky toast — and it needs to be legible
    // without a hover, hence the mark rather than tooltip-only.
    savePillFallbackMark.hidden = !fallbackHint
    saveIndicator.classList.toggle('tt-save-pill-fallback', fallbackHint)
    saveIndicator.dataset.state = currentState
    saveIndicator.classList.toggle(
      'tt-save-pill-clickable',
      currentState === 'dirty' || currentState === 'error' || currentState === 'permission'
    )
    for (const sub of saveStateSubscribers) sub(info)
  }

  function setSaveState(state: SaveState): void {
    currentState = state
    if (state === 'saved') {
      const now = new Date()
      lastSavedAt = { h: now.getHours(), m: now.getMinutes() }
    }
    renderSaveIndicator()
  }

  function setFallbackHint(active: boolean): void {
    fallbackHint = active
    renderSaveIndicator()
  }

  function applyPrefs(prefs: Prefs): void {
    const localeChanged = prefs.locale !== currentLocale
    currentLocale = prefs.locale
    currentTheme = prefs.theme
    applyTheme(prefs.theme)
    document.documentElement.dataset.palette = prefs.palette
    document.documentElement.dataset.font = prefs.font
    document.documentElement.dataset.size = prefs.fontSize
    if (localeChanged) {
      appNameBtn.title = t(currentLocale, 'app_name_button_title')
      appNameBtn.textContent = t(currentLocale, 'app_name')
      fullscreenBtn.title = t(currentLocale, 'fullscreen')
      closeFileBtn.title = t(currentLocale, 'close_file_title')
      settingsBtn.title = t(currentLocale, 'settings')
      helpBtn.title = t(currentLocale, 'help_global_title')
      renderSaveIndicator()
    }
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

  function setAppNameEnabled(enabled: boolean): void {
    appNameBtn.disabled = !enabled
  }

  function onCloseFile(cb: () => void): void {
    closeFileHandler = cb
  }

  function onSaveRequest(cb: () => void): void {
    saveRequestHandler = cb
  }

  function onGrantRequest(cb: () => void): void {
    grantRequestHandler = cb
  }

  function requestSaveNow(): void {
    if (currentState === 'permission') {
      grantRequestHandler?.()
      return
    }
    if (currentState === 'dirty' || currentState === 'error') saveRequestHandler?.()
  }

  function subscribeSaveState(cb: (info: SaveStatusInfo) => void): () => void {
    saveStateSubscribers.add(cb)
    cb(computeSaveInfo())
    return () => { saveStateSubscribers.delete(cb) }
  }

  function setHeaderCompactSpaceHidden(hidden: boolean): void {
    header.classList.toggle('tt-header-compact', hidden)
  }

  setSaveState('saved')

  function dispose(): void {
    mq.removeEventListener('change', onSystemThemeChange)
  }

  return { root, headerLeft, headerCenter, headerRight, sidebar, panesRoot, setSaveState, setFallbackHint, applyPrefs, setTitle, onSettings, onHelp, onAppNameClick, setAppNameEnabled, onCloseFile, onSaveRequest, onGrantRequest, requestSaveNow, subscribeSaveState, setHeaderCompactSpaceHidden, dispose }
}
