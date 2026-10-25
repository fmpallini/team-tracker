// src/ui/shell.ts
import type { Prefs } from '../core/types'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'
import { iconButton, setIconButtonTitle } from './icons'
import { formatHHMM, formatAge } from '../core/date'
import type { FileHealth } from '../core/file-snapshot'
import { syncThemeColor } from '../core/theme-color'

/** What the save pill reports. The file's own health, plus two conditions that outrank it. */
export type PillHealth = FileHealth['kind'] | 'store-error' | 'readonly'

/** The pill's click, by what it does: re-grant a lapsed permission, export a copy (browsers that cannot write the file), or open the dialog for a failed write. */
export type PillAction = 'regrant' | 'export' | 'failure'

/** What the pill needs to know besides the file's health. */
export interface PillContext {
  /** When the file is next due (or, in export mode, when the last export turns stale); null if unknown. */
  nextWriteAt: number | null
  /** The browser store is failing: edits exist only in memory. */
  storeError: boolean
  /** This tab lost the write lock. */
  readOnly: boolean
}

/** Already-formatted (current-locale) snapshot of the save pill — what `subscribeSaveState` broadcasts, so a mirroring control (e.g. action-items.ts's expanded-modal header pill) never needs its own copy of the label/tooltip rules. */
export interface SaveStatusInfo {
  health: PillHealth
  label: string
  title: string
  /** Whether clicking the pill does anything in this state. */
  clickable: boolean
  /** Export mode only: the last export is older than the write interval. */
  stale: boolean
}

export interface Shell {
  root: HTMLElement
  headerLeft: HTMLElement
  /** Center header slot, between the search bar and the right-side buttons — empty/unused by the shell itself; sidebar.ts fills it with the active team's name when the team sidebar is collapsed. */
  headerCenter: HTMLElement
  headerRight: HTMLElement
  sidebar: HTMLElement
  panesRoot: HTMLElement
  /**
   * Repaints the save pill. The pill reports whether the app can write the file when it needs to — not whether the
   * document is "dirty", which the browser copy makes mostly moot. The label is static; the last and next file write are in the hover.
   */
  setFileHealth(health: FileHealth, ctx: PillContext): void
  applyPrefs(prefs: Prefs): void
  setTitle(fileName: string | null): void
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
  /** Registers the handler for clicks on the save pill, called with what the click is for. Only permission, a failed write and export respond; every other state is inert. */
  onPillAction(cb: (action: PillAction) => void): void
  /**
   * Same effect as clicking the real pill, for a caller that mirrors it in its own UI (action-items.ts's
   * expanded-modal header pill) instead of the header pill itself.
   */
  requestPillAction(): void
  /**
   * Subscribes to every save-state pill update — state plus its
   * already-formatted (current-locale) label/tooltip, the same strings the
   * real pill renders. Fires once immediately with the current snapshot (a
   * fresh subscriber doesn't wait for the next change), then again on every
   * subsequent `setFileHealth`/locale-changing `applyPrefs` call (and, in export mode, as the age ticks over). Returns an unsubscribe function.
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
  /** Drops the centred team indicator once its slot is too narrow to show more than a stub (see responsive.ts). */
  setHeaderTeamSpaceHidden(hidden: boolean): void
  /**
   * Releases the OS-theme `matchMedia` listener this shell registered.
   *
   * Load-bearing, not hygiene: `matchMedia`'s MediaQueryList outlives any one
   * document, so a shell that never unregisters stays reachable from it
   * forever — and because that handler shares `createShell`'s closure scope
   * with `setFileHealth`/`applyPrefs`/etc., which capture `root`, keeping it
   * alive pins the shell's *entire DOM tree*. Every close-file → open-file
   * cycle then retained a whole previous UI (~340 nodes, ~140 listeners
   * measured in e2e/leak.spec.ts). main.ts calls this from its per-document
   * `disposers`.
   */
  dispose(): void
}

/** Which clicks do something, and what. Single source for the pill's click look and for `SaveStatusInfo.clickable`. */
const CLICK_ACTION: Partial<Record<PillHealth, PillAction>> = { permission: 'regrant', error: 'failure', 'store-error': 'failure', export: 'export' }

const LABEL_KEY: Record<Exclude<PillHealth, 'export'>, MsgKey> = {
  ok: 'pill_ok',
  writing: 'pill_writing',
  permission: 'pill_permission',
  error: 'pill_error',
  'store-error': 'pill_store_error',
  readonly: 'pill_readonly',
}

const TITLE_KEY: Record<Exclude<PillHealth, 'ok' | 'export'>, MsgKey> = {
  writing: 'pill_writing_title',
  permission: 'pill_permission_title',
  error: 'pill_error_title',
  'store-error': 'pill_store_error_title',
  readonly: 'pill_readonly_title',
}

/** How often the export age ("Export file · 3 h ago") is refreshed. */
const AGE_TICK_MS = 60_000

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
 * locale the next time `setFileHealth()` runs. This avoids a redundant API
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
  // The trailing chevron is the affordance: without it the button reads as a
  // plain title, and the palette it opens is only discoverable via the tooltip.
  // Label lives in its own span so a locale switch can rewrite the text without
  // wiping the chevron.
  const appNameLabel = el('span', { class: 'tt-app-name-label' }, t(locale, 'app_name'))
  const appNameChevron = el('span', { class: 'tt-app-name-chevron', 'aria-hidden': 'true' })
  appNameChevron.innerHTML =
    '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6L8 10.5L12.5 6"/></svg>'
  const appNameBtn = el(
    'button',
    { class: 'tt-app-name', type: 'button', title: t(locale, 'app_name_button_title'), onclick: () => appNameHandler?.() },
    appNameLabel,
    appNameChevron
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
  let pillActionHandler: ((action: PillAction) => void) | null = null
  const saveIndicator = el(
    'span',
    { class: 'tt-save-pill' },
    savePillIcon,
    savePillText
  )
  // The click target: the pill is its only child; kept as a wrapper so the mirrored
  // pill in the expanded action-item modal can clone the same shape.
  const savePillWrap = el(
    'span',
    { class: 'tt-save-pill-wrap', onclick: () => requestPillAction() },
    saveIndicator
  )

  const fullscreenBtn = iconButton({
    class: 'tt-btn-fullscreen',
    title: t(locale, 'fullscreen'),
    icon: 'fullscreen',
    onclick: () => toggleFullscreen(),
  })
  let closeFileHandler: (() => void) | null = null
  const closeFileBtn = iconButton({
    class: 'tt-btn-close-file',
    title: t(locale, 'close_file_title'),
    icon: 'lock',
    onclick: () => closeFileHandler?.(),
  })
  let settingsHandler: (() => void) | null = null
  const settingsBtn = iconButton({
    class: 'tt-btn-settings',
    title: t(locale, 'settings'),
    icon: 'gear',
    onclick: () => settingsHandler?.(),
  })
  let helpHandler: (() => void) | null = null
  const helpBtn = iconButton({
    class: 'tt-btn-help',
    title: t(locale, 'help_global_title'),
    icon: 'help',
    onclick: () => helpHandler?.(),
  })

  // The right cluster is status, then view/help utilities, then settings and the session-ending close-file button last, kept apart from the utilities. (mountSearch() appends the search box to headerLeft.)
  headerRight.append(
    savePillWrap,
    el('span', { class: 'tt-header-btn-group' }, fullscreenBtn, helpBtn),
    el('span', { class: 'tt-header-btn-group' }, settingsBtn, closeFileBtn)
  )

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
    if (currentTheme === 'system') {
      applyTheme('system')
      syncThemeColor()
    }
  }
  mq.addEventListener('change', onSystemThemeChange)

  // What the pill last painted from. Kept raw (never pre-formatted text) so a locale switch, or the minute tick in
  // export mode, reformats instead of showing what was true when it was last painted.
  let fileHealth: FileHealth = { kind: 'ok', lastWrittenAt: null }
  let pillCtx: PillContext = { nextWriteAt: null, storeError: false, readOnly: false }
  let ageTimer: ReturnType<typeof setInterval> | null = null
  const saveStateSubscribers = new Set<(info: SaveStatusInfo) => void>()

  const clock = (ms: number): string => {
    const d = new Date(ms)
    return formatHHMM(d.getHours(), d.getMinutes(), currentLocale)
  }

  /** The health the pill shows: a read-only tab outranks a failed browser store, which outranks any problem with the file. */
  function pillHealth(): PillHealth {
    if (pillCtx.readOnly) return 'readonly'
    if (pillCtx.storeError) return 'store-error'
    return fileHealth.kind
  }

  /** `label`/`title` computation shared by the real pill (renderSaveIndicator) and every subscribeSaveState() listener — one place the text and tooltip rules live, so a mirroring control never drifts from the real pill's wording. */
  function computeSaveInfo(): SaveStatusInfo {
    const health = pillHealth()
    let label: string
    let title: string
    let stale = false
    if (health === 'export') {
      const at = fileHealth.kind === 'export' ? fileHealth.lastExportedAt : null
      const age = at === null ? null : formatAge(Date.now() - at)
      label = at === null ? t(currentLocale, 'pill_export') : age === null ? t(currentLocale, 'pill_export_now') : t(currentLocale, 'pill_export_ago', { age })
      title = t(currentLocale, 'pill_export_title')
      stale = pillCtx.nextWriteAt !== null && Date.now() > pillCtx.nextWriteAt
    } else {
      label = t(currentLocale, LABEL_KEY[health])
      if (health === 'ok') {
        // Green: the label stays plain; the hover gives the last and next file write and says the browser cache holds the changes.
        const written = fileHealth.kind === 'ok' ? fileHealth.lastWrittenAt : null
        const next = pillCtx.nextWriteAt
        title = next === null
          ? t(currentLocale, 'pill_ok_title_plain')
          : written !== null
            ? t(currentLocale, 'pill_ok_title', { written: clock(written), next: clock(next) })
            : t(currentLocale, 'pill_ok_title_nofile', { next: clock(next) })
      } else {
        title = t(currentLocale, TITLE_KEY[health])
      }
    }
    return { health, label, title, clickable: CLICK_ACTION[health] !== undefined, stale }
  }

  function renderSaveIndicator(): void {
    const info = computeSaveInfo()
    savePillText.textContent = info.label
    savePillIcon.classList.toggle('tt-save-pill-spin', info.health === 'writing')
    saveIndicator.title = info.title
    saveIndicator.dataset.state = info.health
    saveIndicator.classList.toggle('tt-save-pill-clickable', info.clickable)
    saveIndicator.classList.toggle('tt-save-pill-stale', info.stale)
    for (const sub of saveStateSubscribers) sub(info)
  }

  function setFileHealth(health: FileHealth, ctx: PillContext): void {
    fileHealth = health
    pillCtx = ctx
    renderSaveIndicator()
    // The age is the one thing on the pill that changes with time alone.
    const needsTick = pillHealth() === 'export'
    if (needsTick && ageTimer === null) ageTimer = setInterval(renderSaveIndicator, AGE_TICK_MS)
    else if (!needsTick && ageTimer !== null) { clearInterval(ageTimer); ageTimer = null }
  }

  function applyPrefs(prefs: Prefs): void {
    const localeChanged = prefs.locale !== currentLocale
    currentLocale = prefs.locale
    currentTheme = prefs.theme
    applyTheme(prefs.theme)
    document.documentElement.dataset.palette = prefs.palette
    syncThemeColor()
    document.documentElement.dataset.font = prefs.font
    document.documentElement.dataset.size = prefs.fontSize
    if (localeChanged) {
      appNameBtn.title = t(currentLocale, 'app_name_button_title')
      appNameLabel.textContent = t(currentLocale, 'app_name')
      setIconButtonTitle(fullscreenBtn, t(currentLocale, 'fullscreen'))
      setIconButtonTitle(closeFileBtn, t(currentLocale, 'close_file_title'))
      setIconButtonTitle(settingsBtn, t(currentLocale, 'settings'))
      setIconButtonTitle(helpBtn, t(currentLocale, 'help_global_title'))
    }
    if (localeChanged) renderSaveIndicator()
  }

  function setTitle(fileName: string | null): void {
    document.title = `Team Tracker v${__APP_VERSION__}` + (fileName ? ` — ${fileName}` : '')
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

  function onPillAction(cb: (action: PillAction) => void): void {
    pillActionHandler = cb
  }

  function requestPillAction(): void {
    const action = CLICK_ACTION[pillHealth()]
    if (action) pillActionHandler?.(action)
  }

  function subscribeSaveState(cb: (info: SaveStatusInfo) => void): () => void {
    saveStateSubscribers.add(cb)
    cb(computeSaveInfo())
    return () => { saveStateSubscribers.delete(cb) }
  }

  function setHeaderCompactSpaceHidden(hidden: boolean): void {
    header.classList.toggle('tt-header-compact', hidden)
  }

  function setHeaderTeamSpaceHidden(hidden: boolean): void {
    header.classList.toggle('tt-header-team-hidden', hidden)
  }

  renderSaveIndicator()

  function dispose(): void {
    mq.removeEventListener('change', onSystemThemeChange)
    if (ageTimer !== null) clearInterval(ageTimer)
    ageTimer = null
  }

  return { root, headerLeft, headerCenter, headerRight, sidebar, panesRoot, setFileHealth, applyPrefs, setTitle, onSettings, onHelp, onAppNameClick, setAppNameEnabled, onCloseFile, onPillAction, requestPillAction, subscribeSaveState, setHeaderCompactSpaceHidden, setHeaderTeamSpaceHidden, dispose }
}
