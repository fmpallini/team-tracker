// src/ui/help.ts — editor help modal (shortcuts, markdown syntax, @refs,
// /templates) and the global help modal (app-level shortcuts, plus the
// `chrome --app=...` chromeless-window recipe).
import type { Locale, MsgKey } from '../core/i18n'
import { t } from '../core/i18n'
import { el } from './dom'
import { showModal } from './modal'

const SHORTCUT_ROWS: readonly (readonly [string, MsgKey])[] = [
  ['Ctrl+B', 'help_shortcut_bold'],
  ['Ctrl+I', 'help_shortcut_italic'],
  ['Ctrl+U', 'help_shortcut_underline'],
  ['Ctrl+Shift+X', 'help_shortcut_strike'],
  ['Ctrl+Shift+8', 'help_shortcut_ul'],
  ['Ctrl+Shift+7', 'help_shortcut_ol'],
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
]

const GLOBAL_ROWS: readonly (readonly [string, MsgKey])[] = [
  ['Alt+1 … Alt+9', 'help_global_teams'],
  ['Ctrl+K', 'help_global_palette'],
  ['Ctrl+S', 'help_global_save'],
  ['Ctrl+Alt+L / 🔒', 'help_global_close_file'],
  ['Ctrl+F ou /', 'help_global_search'],
  ['Alt+← / Alt+→', 'help_global_history'],
  ['F11 / ⛶', 'help_global_fullscreen'],
]

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

export function showGlobalHelp(locale: Locale): void {
  const body = el(
    'div',
    { class: 'tt-help-body' },
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_global_shortcuts_heading')),
    table(locale, GLOBAL_ROWS),
    el('h3', { class: 'tt-help-heading' }, t(locale, 'help_appwindow_heading')),
    el('p', { class: 'tt-help-text' }, t(locale, 'help_appwindow_body')),
    el('pre', { class: 'tt-help-code-block' }, 'chrome --app=file:///caminho/para/app.html')
  )

  const handle: { close: () => void } = showModal({
    title: t(locale, 'help_global_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
}
