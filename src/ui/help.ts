// src/ui/help.ts — editor help modal (shortcuts, markdown syntax, @refs,
// /templates) and the global help modal (app-level shortcuts, plus the
// `--app=...` chromeless-window recipe, filled in with this file's own URL and
// the detected browser).
import type { Locale, MsgKey } from '../core/i18n'
import { t } from '../core/i18n'
import { el, copyText } from './dom'
import { icon, type IconName } from './icons'
import { showModal } from './modal'

/** Key and example text in the first column is localized too ("Space", "or", the "text" placeholder), hence rows built per locale. */
type Rows = readonly (readonly [string, MsgKey])[]

const shortcutRows = (lc: Locale): Rows => [
  ['Ctrl+B', 'help_shortcut_bold'],
  ['Ctrl+I', 'help_shortcut_italic'],
  ['Ctrl+U', 'help_shortcut_underline'],
  ['Ctrl+Shift+5 / Ctrl+Shift+X', 'help_shortcut_strike'],
  ['Ctrl+Shift+6 / Ctrl+Shift+E', 'help_shortcut_codeblock'],
  ['Ctrl+Shift+7', 'help_shortcut_ol'],
  ['Ctrl+Shift+8', 'help_shortcut_ul'],
  ['Ctrl+Shift+9 / Ctrl+Shift+Q', 'help_shortcut_quote'],
  ['Ctrl+K', 'help_shortcut_link'],
  [t(lc, 'help_key_ctrl_click'), 'help_shortcut_open_link'],
  ['Ctrl+1 / Ctrl+2 / Ctrl+3', 'help_shortcut_heading'],
  ['Ctrl+0', 'help_shortcut_paragraph'],
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

const globalRows = (lc: Locale): Rows => [
  ['Alt+1 … Alt+9', 'help_global_teams'],
  ['Ctrl+Shift+K', 'help_global_palette'],
  ['Ctrl+S', 'help_global_save'],
  ['Ctrl+Alt+L / {lock}', 'help_global_close_file'],
  [`Ctrl+F ${t(lc, 'help_key_or')} /`, 'help_global_search'],
  ['Ctrl+Shift+F', 'help_global_search_all_teams'],
  ['Alt+Shift+← / Alt+Shift+→', 'help_global_history'],
  ['Alt+Shift+↑', 'help_global_history_latest'],
  ['{mouse} 4 / 5', 'help_global_history_mouse'],
  ['{back} / {next} {mouse}', 'help_global_history_menu'],
  ['Alt+←/→/↑/↓', 'help_global_pane_layout'],
  ['F1 … F7', 'help_global_pane_module'],
  ['Alt+[ / Alt+] / Alt+T', 'help_global_daily_nav'],
  ['Alt+, / Alt+.', 'help_global_daily_nav_content'],
  ['F11 / {fullscreen}', 'help_global_fullscreen'],
  // Enter and Space are deliberately two different actions on a focused row/
  // card (see the row/card builders in modules/risks.ts, milestones.ts and
  // action-items.ts) — documenting that split is the whole point of these
  // three rows, so they must never be collapsed back into one "Enter /
  // Espaço" row.
  ['↑ / ↓ (← / →)', 'help_global_row_nav'],
  ['Enter', 'help_global_row_enter'],
  [t(lc, 'help_key_space'), 'help_global_row_menu'],
]

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

export function showEditorHelp(locale: Locale): void {
  const body = el(
    'div',
    { class: 'tt-help-body' },
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_shortcuts_heading')),
    table(locale, shortcutRows(locale)),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_md_heading')),
    table(locale, mdRows(locale)),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_refs_heading')),
    el('p', { class: 'tt-help-text' }, t(locale, 'help_refs_text')),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_templates_heading')),
    el('p', { class: 'tt-help-text' }, t(locale, 'help_templates_text')),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_images_heading')),
    el('p', { class: 'tt-help-text' }, t(locale, 'help_images_text'))
  )

  const handle: { close: () => void } = showModal({
    title: t(locale, 'editor_help_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
}

export function showGlobalHelp(locale: Locale, opts?: { pwa?: boolean }): void {
  const isPwa = opts?.pwa ?? __PWA__
  const body = el(
    'div',
    { class: 'tt-help-body' },
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_global_shortcuts_heading')),
    table(locale, globalRows(locale)),
    // The --app= recipe is a workaround for opening the plain
    // dist/app.html without browser chrome — moot in the PWA build, which is
    // already installable/standalone, so it's only shown there.
    ...(isPwa
      ? []
      : [
          el('h3', { class: 'tt-help-heading' }, t(locale, 'help_appwindow_heading')),
          el('p', { class: 'tt-help-text' }, t(locale, 'help_appwindow_body')),
          copyableCommand(locale, appWindowCommand(location.href, (navigator as Navigator & { userAgentData?: UaData }).userAgentData, navigator.userAgent)),
          // The launcher name is inferred from the browser brand + OS — a page
          // can't see the real executable — so say so instead of presenting it
          // as authoritative.
          el('p', { class: 'tt-help-hint' }, t(locale, 'help_appwindow_guess')),
        ])
  )

  const handle: { close: () => void } = showModal({
    title: t(locale, 'help_global_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
}
