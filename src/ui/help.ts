// src/ui/help.ts — the one Help modal: a tab rail (Global, Editor and one tab
// per module family) beside the keys that apply there. It opens on the tab of
// the focused pane's module, so `?` answers "what can I press here", and the
// other tabs stay one click away. Same frame as Preferences (ui/tab-rail.ts).
//
// Key groups several modules share (lists & cards, date fields) are defined
// once and composed into each module's tab, so a row is never written twice.
// The Global tab also carries the saving explanation and the `--app=...`
// chromeless-window recipe, filled in with this file's own URL and the
// detected browser.
import type { Locale, MsgKey } from '../core/i18n'
import { t } from '../core/i18n'
import type { ModuleRef } from '../core/types'
import { el, copyText } from './dom'
import { icon, type IconName } from './icons'
import { showModal, type ModalHandle } from './modal'
import { createTabRail } from './tab-rail'

export type HelpTab = 'global' | 'editor' | 'notes' | 'people' | 'tasks' | 'milestones' | 'risks'

/** Which tab documents a pane showing `kind`. */
const PANE_TAB: Record<ModuleRef['kind'], HelpTab> = {
  daily: 'notes', general: 'editor', person: 'editor',
  stakeholders: 'people', members: 'people',
  actions: 'tasks', milestones: 'milestones', risks: 'risks',
}

/** Key and example text in the first column is localized too ("Space", "or", the "text" placeholder), hence rows built per locale. */
type Rows = readonly (readonly [string, MsgKey])[]

// --- Editor ----------------------------------------------------------------

const inlineRows: Rows = [
  ['Ctrl+B', 'help_shortcut_bold'],
  ['Ctrl+I', 'help_shortcut_italic'],
  ['Ctrl+U', 'help_shortcut_underline'],
  ['Ctrl+Shift+5 / Ctrl+Shift+X', 'help_shortcut_strike'],
]

const blockRows: Rows = [
  ['Ctrl+1 / Ctrl+2 / Ctrl+3', 'help_shortcut_heading'],
  ['Ctrl+0', 'help_shortcut_paragraph'],
  ['Ctrl+Shift+8', 'help_shortcut_ul'],
  ['Ctrl+Shift+7', 'help_shortcut_ol'],
  ['Ctrl+Shift+9 / Ctrl+Shift+Q', 'help_shortcut_quote'],
  ['Ctrl+Shift+6 / Ctrl+Shift+E', 'help_shortcut_codeblock'],
]

const linkRows = (lc: Locale): Rows => [
  ['Ctrl+K', 'help_shortcut_link'],
  [t(lc, 'help_key_ctrl_click'), 'help_shortcut_open_link'],
]

const historyRows: Rows = [
  ['Ctrl+Z', 'help_shortcut_undo'],
  ['Ctrl+Shift+Z / Ctrl+Y', 'help_shortcut_redo'],
]

const mdRows = (lc: Locale): Rows => {
  const text = t(lc, 'help_key_text')
  return [
    [`**${text}**`, 'help_md_bold'],
    [`*${text}*`, 'help_md_italic'],
    [`~~${text}~~`, 'help_md_strike'],
    ['# / ## / ###', 'help_md_headings'],
    [`- ${text}`, 'help_md_ul'],
    [`1. ${text}`, 'help_md_ol'],
    ['---', 'help_md_hr'],
    ['```', 'help_md_codeblock'],
    [`> ${text}`, 'help_md_quote'],
    [`[${text}](url)`, 'help_md_link'],
  ]
}

// --- Global ----------------------------------------------------------------

const globalRows = (lc: Locale): Rows => [
  ['Alt+1 … Alt+9', 'help_global_teams'],
  ['Ctrl+Shift+K', 'help_global_palette'],
  ['Ctrl+Alt+L / {lock}', 'help_global_close_file'],
  [`Ctrl+F ${t(lc, 'help_key_or')} /`, 'help_global_search'],
  ['Ctrl+Shift+F', 'help_global_search_all_teams'],
  ['Alt+Shift+← / Alt+Shift+→', 'help_global_history'],
  ['Alt+Shift+↑', 'help_global_history_latest'],
  ['{mouse} 4 / 5', 'help_global_history_mouse'],
  ['{back} / {next} {mouse}', 'help_global_history_menu'],
  ['Alt+←/→/↑/↓', 'help_global_pane_layout'],
  ['F1', 'help_global_help'],
  ['F2 … F8', 'help_global_pane_module'],
  ['F11 / {fullscreen}', 'help_global_fullscreen'],
  ['Ctrl+Enter', 'help_global_open_other_pane'],
  ['Ctrl+← / → / ↑ / ↓', 'help_global_move_item'],
  // Ctrl+Z is the app-wide undo of a delete or a move to another team (the
  // Undo toast's keyboard route, see ui/undo-toast.ts); inside a text field it
  // stays that field's own undo, which the Editor tab documents.
  ['Ctrl+Z', 'help_global_undo_delete'],
]

// --- Shared by the modules ---------------------------------------------------

const listNavRows: Rows = [['↑ / ↓', 'help_global_row_nav']]

// Enter and Space are deliberately two different actions on a focused row/
// card (see the row/card builders in modules/risks.ts, milestones.ts and
// action-items.ts) — documenting that split is the whole point of these
// rows, so they must never be collapsed back into one "Enter / Espaço" row.
const listRows = (lc: Locale): Rows => [
  ['Home / End / PgUp / PgDn', 'help_global_row_jump'],
  ['Enter', 'help_global_row_enter'],
  [t(lc, 'help_key_space'), 'help_global_row_menu'],
  ['Alt+N', 'help_global_new_item'],
  ['Enter', 'help_global_new_item_run'],
  ['Delete', 'help_global_row_delete'],
]

const dateRows: Rows = [['↑ / ↓, t, Alt+C / Alt+↓', 'help_global_date_keys']]

// --- App window ------------------------------------------------------------

type BrowserBrand = 'chrome' | 'edge' | 'chromium'
type Platform = 'win' | 'mac' | 'linux'

interface UaData { brands?: readonly { brand: string }[]; platform?: string }

/** Executable (or macOS app-bundle) names, per platform and Chromium brand. */
const APP_LAUNCHERS: Record<Platform, Record<BrowserBrand, string>> = {
  win: { chrome: 'chrome', edge: 'msedge', chromium: 'chromium' },
  mac: { chrome: 'Google Chrome', edge: 'Microsoft Edge', chromium: 'Chromium' },
  linux: { chrome: 'google-chrome', edge: 'microsoft-edge', chromium: 'chromium' },
}

/**
 * The command that opens `href` in a chromeless `--app=` window, for the
 * browser the page is running in. Best-effort: a page can tell the brand and
 * OS (`userAgentData`, else the UA string) but never the executable's real
 * path, so it names the launcher a shell/Run box resolves and falls back to
 * plain Chrome on anything it doesn't recognise. `href` is already
 * percent-encoded, so double quotes are all the quoting it needs.
 */
export function appWindowCommand(href: string, uaData?: UaData, userAgent = ''): string {
  const brands = uaData?.brands?.map((b) => b.brand) ?? []
  // Google Chrome's brand list carries both "Google Chrome" and "Chromium";
  // an unbranded Chromium build carries only the latter.
  const brand: BrowserBrand = brands.includes('Microsoft Edge') || /\bEdg\//.test(userAgent)
    ? 'edge'
    : brands.includes('Chromium') && !brands.includes('Google Chrome') ? 'chromium' : 'chrome'
  const os = `${uaData?.platform ?? ''} ${userAgent}`
  const platform: Platform = /win/i.test(os) ? 'win' : /mac/i.test(os) ? 'mac' : 'linux'
  const app = `--app="${href.split('#')[0]}"`
  return platform === 'mac'
    ? `open -na "${APP_LAUNCHERS.mac[brand]}" --args ${app}`
    : `${APP_LAUNCHERS[platform][brand]} ${app}`
}

/** A `<pre>` command with a copy button that fades in on hover/focus — same look and feedback as the editor's code-block copy chrome. */
function copyableCommand(locale: Locale, command: string): HTMLElement {
  let resetTimer: ReturnType<typeof setTimeout> | null = null
  const btn = el('button', {
    class: 'tt-cb-btn tt-help-cmd-copy', type: 'button', title: t(locale, 'editor_cb_copy'),
    onclick: () => {
      copyText(command)
      btn.replaceChildren(icon('check'))
      btn.title = t(locale, 'editor_cb_copied')
      if (resetTimer) clearTimeout(resetTimer)
      resetTimer = setTimeout(() => {
        btn.replaceChildren(icon('copy'))
        btn.title = t(locale, 'editor_cb_copy')
      }, 900)
    },
  }, icon('copy'))
  return el('div', { class: 'tt-help-cmd' }, el('pre', { class: 'tt-help-code-block' }, command), btn)
}

// --- Building blocks ---------------------------------------------------------

/** A shortcut cell: plain text, with `{name}` tokens swapped for that stroke icon — the same drawing as the button the row refers to. */
function keyCell(code: string): HTMLElement {
  const parts = code.split(/\{(\w+)\}/)
  const nodes = parts.map((part, i) => (i % 2 === 1 ? icon(part as IconName, 13) : part))
  return el('td', { class: 'tt-help-code' }, ...nodes)
}

function table(locale: Locale, rows: Rows): HTMLElement {
  const body = rows.map(([code, key]) =>
    el('tr', {}, keyCell(code), el('td', {}, t(locale, key)))
  )
  return el('table', { class: 'tt-help-table' }, el('tbody', {}, ...body))
}

interface Ctx {
  locale: Locale
  /** The PWA build is already installable/standalone, so the `--app=` recipe is moot there. */
  pwa: boolean
  goto: (tab: HelpTab) => void
}

function section(ctx: Ctx, headingKey: MsgKey, content: (Node | null)[], shared = false): HTMLElement {
  const badge = shared
    ? el('span', { class: 'tt-help-badge', title: t(ctx.locale, 'help_shared_title') }, t(ctx.locale, 'help_shared_badge'))
    : null
  return el(
    'section',
    { class: 'tt-help-section' },
    el('div', { class: 'tt-help-section-head' }, el('h3', { class: 'tt-help-heading' }, t(ctx.locale, headingKey)), badge),
    ...content
  )
}

const rowsSection = (ctx: Ctx, headingKey: MsgKey, rows: Rows, shared = false): HTMLElement =>
  section(ctx, headingKey, [table(ctx.locale, rows)], shared)

const textSection = (ctx: Ctx, headingKey: MsgKey, textKey: MsgKey): HTMLElement =>
  section(ctx, headingKey, [el('p', { class: 'tt-help-text' }, t(ctx.locale, textKey))])

/** Lists & cards: the keys a risk, milestone, task or person row answers. People navigate by org chart, so they skip the ↑/↓ row. */
const listsSection = (ctx: Ctx, withNav: boolean): HTMLElement =>
  rowsSection(ctx, 'help_sec_lists', [...(withNav ? listNavRows : []), ...listRows(ctx.locale)], true)

const datesSection = (ctx: Ctx): HTMLElement => rowsSection(ctx, 'help_sec_dates', dateRows, true)

// --- Tabs --------------------------------------------------------------------

interface TabDef {
  id: HelpTab
  label: MsgKey
  build(ctx: Ctx): HTMLElement[]
}

const TABS: readonly TabDef[] = [
  {
    id: 'global',
    label: 'help_tab_global',
    build: (ctx) => [
      rowsSection(ctx, 'help_global_shortcuts_heading', globalRows(ctx.locale)),
      textSection(ctx, 'help_saving_heading', 'help_saving_text'),
      // The --app= recipe is a workaround for opening the plain
      // dist/app.html without browser chrome — moot in the PWA build, which is
      // already installable/standalone, so it's only shown there.
      ...(ctx.pwa
        ? []
        : [section(ctx, 'help_appwindow_heading', [
            el('p', { class: 'tt-help-text' }, t(ctx.locale, 'help_appwindow_body')),
            copyableCommand(ctx.locale, appWindowCommand(location.href, (navigator as Navigator & { userAgentData?: UaData }).userAgentData, navigator.userAgent)),
            // The launcher name is inferred from the browser brand + OS — a page
            // can't see the real executable — so say so instead of presenting it
            // as authoritative.
            el('p', { class: 'tt-help-hint' }, t(ctx.locale, 'help_appwindow_guess')),
          ])]),
    ],
  },
  {
    id: 'editor',
    label: 'help_tab_editor',
    build: (ctx) => [
      rowsSection(ctx, 'help_sec_inline', inlineRows),
      rowsSection(ctx, 'help_sec_blocks', blockRows),
      rowsSection(ctx, 'help_sec_links', linkRows(ctx.locale)),
      rowsSection(ctx, 'help_md_heading', mdRows(ctx.locale)),
      textSection(ctx, 'help_refs_heading', 'help_refs_text'),
      textSection(ctx, 'help_templates_heading', 'help_templates_text'),
      textSection(ctx, 'help_images_heading', 'help_images_text'),
      rowsSection(ctx, 'help_sec_leave', [['Esc', 'help_notes_leave']]),
      rowsSection(ctx, 'help_sec_history', historyRows),
    ],
  },
  {
    id: 'notes',
    label: 'module_daily',
    build: (ctx) => [
      rowsSection(ctx, 'help_sec_days', [
        ['Alt+[ / Alt+] / Alt+T', 'help_global_daily_nav'],
        ['Alt+, / Alt+.', 'help_global_daily_nav_content'],
        ['Alt+C', 'help_global_calendar_toggle'],
      ]),
      el(
        'div',
        { class: 'tt-help-section' },
        el('button', { class: 'tt-btn', type: 'button', onclick: () => ctx.goto('editor') }, t(ctx.locale, 'help_notes_editor_link'))
      ),
    ],
  },
  {
    id: 'people',
    label: 'help_tab_people',
    build: (ctx) => [
      rowsSection(ctx, 'help_sec_org', [
        ['↑ / ↓ (← / →)', 'help_people_nav'],
        ['Ctrl+← / → / ↑ / ↓', 'help_people_move'],
      ]),
      listsSection(ctx, false),
    ],
  },
  {
    id: 'tasks',
    label: 'module_actions',
    build: (ctx) => [
      rowsSection(ctx, 'help_sec_board', [['Ctrl+← / → / ↑ / ↓', 'help_tasks_move']]),
      listsSection(ctx, true),
      datesSection(ctx),
    ],
  },
  {
    id: 'milestones',
    label: 'module_milestones',
    build: (ctx) => [
      rowsSection(ctx, 'help_sec_rows', [['Esc', 'help_followup_leave']]),
      listsSection(ctx, true),
      datesSection(ctx),
    ],
  },
  {
    id: 'risks',
    label: 'module_risks',
    build: (ctx) => [
      rowsSection(ctx, 'help_sec_rows', [
        ['Esc', 'help_followup_leave'],
        ['Ctrl+← / → / ↑ / ↓', 'help_risks_move'],
      ]),
      listsSection(ctx, true),
      datesSection(ctx),
    ],
  },
]

/** The tab that documents a pane showing `kind`; Global when the pane is empty. */
export function helpTabFor(kind: ModuleRef['kind'] | undefined): HelpTab {
  return kind ? PANE_TAB[kind] : 'global'
}

// The Help modal on screen, if any: F1 closes it again, and a second open replaces it instead of stacking.
let openHandle: ModalHandle | null = null

/** Closes the Help modal when it is open; false when there was none. */
export function closeHelp(): boolean {
  if (!openHandle) return false
  openHandle.close()
  return true
}

/**
 * Opens the Help modal. `pane` is the module the focused pane shows: help opens
 * on its tab and that tab keeps a "pane" mark when the reader browses away. An
 * explicit `tab` wins (the editor's help button opens the Editor tab).
 */
export function showHelp(locale: Locale, opts: { tab?: HelpTab; pane?: ModuleRef['kind']; pwa?: boolean } = {}): void {
  closeHelp()
  const paneTab = opts.pane ? helpTabFor(opts.pane) : null
  const rail = createTabRail<HelpTab>({
    idPrefix: 'tt-help',
    tabs: TABS.map(({ id, label }) => ({
      id,
      label: t(locale, label),
      extra: id === paneTab ? el('span', { class: 'tt-help-pane-mark', title: t(locale, 'help_tab_pane_title') }, t(locale, 'help_tab_pane')) : undefined,
    })),
    initial: opts.tab ?? paneTab ?? 'global',
    onSelect: (_id, changed) => render(changed),
  })
  const ctx: Ctx = {
    locale,
    pwa: opts.pwa ?? __PWA__,
    goto: (tab) => {
      rail.select(tab)
      render(true)
      rail.focusActive()
    },
  }

  function render(resetScroll: boolean): void {
    rail.panel.replaceChildren(...TABS.find((tab) => tab.id === rail.active)!.build(ctx))
    if (resetScroll) rail.panel.scrollTop = 0
  }

  // Read-only, so there is nothing to confirm: one close mark in the header replaces the OK button, as in Preferences.
  const closeBtn = el(
    'button',
    { class: 'tt-btn tt-modal-close', type: 'button', title: t(locale, 'close'), 'aria-label': t(locale, 'close'), onclick: () => handle.close() },
    icon('close', 14)
  )
  const handle: ModalHandle = showModal({
    title: t(locale, 'help_global_title'),
    body: el('div', { class: 'tt-prefs-dialog tt-help-dialog' }, rail.tabs, rail.panel),
    buttons: [],
    headerExtra: closeBtn,
    onClose: () => { if (openHandle === handle) openHandle = null },
  })
  openHandle = handle

  render(false)
  // The close mark comes first in the DOM, so the dialog's default initial focus would land on it.
  rail.focusActive()
}
