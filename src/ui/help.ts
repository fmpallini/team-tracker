// src/ui/help.ts — editor help modal (shortcuts, markdown syntax, @refs,
// /templates) and the global help modal (app-level shortcuts, plus the
// `--app=...` chromeless-window recipe, filled in with this file's own URL and
// the detected browser).
import type { Locale, MsgKey } from '../core/i18n'
import { t } from '../core/i18n'
import { el } from './dom'
import { showModal } from './modal'

const SHORTCUT_ROWS: readonly (readonly [string, MsgKey])[] = [
  ['Ctrl+B', 'help_shortcut_bold'],
  ['Ctrl+I', 'help_shortcut_italic'],
  ['Ctrl+U', 'help_shortcut_underline'],
  ['Ctrl+Shift+5 / Ctrl+Shift+X', 'help_shortcut_strike'],
  ['Ctrl+Shift+6 / Ctrl+Shift+E', 'help_shortcut_codeblock'],
  ['Ctrl+Shift+7', 'help_shortcut_ol'],
  ['Ctrl+Shift+8', 'help_shortcut_ul'],
  ['Ctrl+Shift+9 / Ctrl+Shift+Q', 'help_shortcut_quote'],
  ['Ctrl+K', 'help_shortcut_link'],
  ['Ctrl+clique / clique do meio', 'help_shortcut_open_link'],
  ['Ctrl+1 / Ctrl+2 / Ctrl+3', 'help_shortcut_heading'],
  ['Ctrl+0', 'help_shortcut_paragraph'],
]

const MD_ROWS: readonly (readonly [string, MsgKey])[] = [
  ['**texto**', 'help_md_bold'],
  ['*texto*', 'help_md_italic'],
  ['~~texto~~', 'help_md_strike'],
  ['# / ## / ###', 'help_md_headings'],
  ['- texto', 'help_md_ul'],
  ['1. texto', 'help_md_ol'],
  ['---', 'help_md_hr'],
  ['```', 'help_md_codeblock'],
  ['> texto', 'help_md_quote'],
  ['[texto](url)', 'help_md_link'],
]

const GLOBAL_ROWS: readonly (readonly [string, MsgKey])[] = [
  ['Alt+1 … Alt+9', 'help_global_teams'],
  ['Ctrl+Shift+K', 'help_global_palette'],
  ['Ctrl+S', 'help_global_save'],
  ['Ctrl+Alt+L / 🔒', 'help_global_close_file'],
  ['Ctrl+F ou /', 'help_global_search'],
  ['Ctrl+Shift+F', 'help_global_search_all_teams'],
  ['Alt+Shift+← / Alt+Shift+→', 'help_global_history'],
  ['Alt+Shift+↑', 'help_global_history_latest'],
  ['🖱 4 / 5', 'help_global_history_mouse'],
  ['◀ / ▶ 🖱', 'help_global_history_menu'],
  ['Alt+←/→/↑/↓', 'help_global_pane_layout'],
  ['F1 … F7', 'help_global_pane_module'],
  ['Alt+[ / Alt+] / Alt+T', 'help_global_daily_nav'],
  ['Alt+, / Alt+.', 'help_global_daily_nav_content'],
  ['F11 / ⛶', 'help_global_fullscreen'],
  // Enter and Space are deliberately two different actions on a focused row/
  // card (see the row/card builders in modules/risks.ts, milestones.ts and
  // action-items.ts) — documenting that split is the whole point of these
  // three rows, so they must never be collapsed back into one "Enter /
  // Espaço" row.
  ['↑ / ↓ (← / →)', 'help_global_row_nav'],
  ['Enter', 'help_global_row_enter'],
  ['Espaço', 'help_global_row_menu'],
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

const COPY_GLYPH = '⧉'
const COPIED_GLYPH = '✓'

/** Async Clipboard API where the page has it; the hidden-textarea + execCommand('copy') route otherwise (file:// is an insecure context, so navigator.clipboard is absent there — the very case this help block is shown in). */
function copyToClipboard(text: string): void {
  const viaTextarea = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy', false, undefined)
    document.body.removeChild(ta)
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(viaTextarea)
  else viaTextarea()
}

/** A `<pre>` command with a copy button that fades in on hover/focus — same look and feedback as the editor's code-block copy chrome. */
function copyableCommand(locale: Locale, command: string): HTMLElement {
  let resetTimer: ReturnType<typeof setTimeout> | null = null
  const btn = el('button', {
    class: 'tt-cb-btn tt-help-cmd-copy', type: 'button', title: t(locale, 'editor_cb_copy'),
    onclick: () => {
      copyToClipboard(command)
      btn.textContent = COPIED_GLYPH
      btn.title = t(locale, 'editor_cb_copied')
      if (resetTimer) clearTimeout(resetTimer)
      resetTimer = setTimeout(() => {
        btn.textContent = COPY_GLYPH
        btn.title = t(locale, 'editor_cb_copy')
      }, 900)
    },
  }, COPY_GLYPH)
  return el('div', { class: 'tt-help-cmd' }, el('pre', { class: 'tt-help-code-block' }, command), btn)
}

function table(locale: Locale, rows: readonly (readonly [string, MsgKey])[]): HTMLElement {
  const body = rows.map(([code, key]) =>
    el('tr', {}, el('td', { class: 'tt-help-code' }, code), el('td', {}, t(locale, key)))
  )
  return el('table', { class: 'tt-help-table' }, el('tbody', {}, ...body))
}

export function showEditorHelp(locale: Locale): void {
  const body = el(
    'div',
    { class: 'tt-help-body' },
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_shortcuts_heading')),
    table(locale, SHORTCUT_ROWS),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_md_heading')),
    table(locale, MD_ROWS),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_refs_heading')),
    el('p', { class: 'tt-help-text' }, t(locale, 'help_refs_text')),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_templates_heading')),
    el('p', { class: 'tt-help-text' }, t(locale, 'help_templates_text'))
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
    table(locale, GLOBAL_ROWS),
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
