// src/ui/app-hotkeys.ts — the pure routing half of main.ts's document-level
// keydown handler. main.ts wires the *effects* (save, open palette, drive the
// pane manager, switch team); this decides, from the event plus the two facts
// the decision depends on, WHICH of those effects a key maps to — or null to
// leave the key to the browser.
//
// Extracted so the routing table is unit-testable: main.ts is wiring-only and
// has no test, and the inline handler grew ~15 branches (layout chords,
// F-keys, Alt+Arrow layout vs Alt+Shift+Arrow history, Alt+bracket day-nav,
// Alt+digit team switch) whose only coverage was a couple of e2e smoke
// checks. ui/hotkeys.ts already split out the reusable predicates the same
// way (matchKey/matchDigit/comboHotkeyAllowed/navHotkeyAllowed); this is the
// app-specific table that composes them.
import { comboHotkeyAllowed, navHotkeyAllowed, matchKey, matchDigit } from './hotkeys'

export type AppHotkeyAction =
  | { type: 'save' }
  | { type: 'palette' }
  | { type: 'closeFile' }
  /** F1..F7 → pane module index 0..6. */
  | { type: 'paneModule'; index: number }
  /** Alt+Shift+Left / Alt+Shift+Right → step the focused pane's history. */
  | { type: 'historyStep'; dir: -1 | 1 }
  /** Alt+Shift+Up → jump the focused pane's history to its latest entry. */
  | { type: 'historyLatest' }
  /**
   * Alt+[ / Alt+] / Alt+T step by one calendar day (or to today); Alt+, /
   * Alt+. (`*WithContent`) skip straight to the prev/next day that actually
   * has a note. All only when the focused pane is showing a daily note.
   *
   * `,` / `.` rather than Alt+Shift+[ / ]: a shifted bracket produces
   * `{` / `}` for `e.key`, and the physical `]` key is `code` "Backslash"
   * (not "BracketRight") on a Brazilian ABNT2 keyboard, so neither the
   * character nor the code match reliably. Comma/period are unshifted with a
   * stable `e.code` on every layout.
   */
  | { type: 'dayNav'; to: 'prev' | 'next' | 'today' | 'prevWithContent' | 'nextWithContent' }
  /** Alt+Left / Alt+Right → focus pane 0 / pane 1. */
  | { type: 'selectPane'; index: 0 | 1 }
  /** Alt+Up → toggle single/dual pane. */
  | { type: 'toggleSplit' }
  /** Alt+Down → swap the two panes' sides. */
  | { type: 'swapPanes' }
  /** Alt+1..9 → switch to team index 0..8 (only when that team exists). */
  | { type: 'selectTeam'; index: number }

export interface AppHotkeyContext {
  /** `store.doc.teams.length` — bounds Alt+1..9. */
  teamCount: number
  /** Whether the currently focused pane is showing a daily note — gates Alt+[ / Alt+] / Alt+T. */
  focusedPaneShowsDailyNote: boolean
}

/**
 * Resolve a document keydown to the app action it triggers, or null to let
 * the browser keep the key. A non-null result always means "consume the
 * event": every branch here mirrors one that called `e.preventDefault()`
 * before acting, so the caller preventDefault()s unconditionally on a hit.
 *
 * `comboHotkeyAllowed` / `navHotkeyAllowed` read live DOM + modal state and
 * are consulted at exactly the points the inline handler consulted them —
 * when they say no, the key falls through to the browser (no action, no
 * preventDefault), same as before.
 *
 * The modeless-card dismissal (`dismissModelessModals()`) that several of
 * these branches ran *after* preventDefault stays in the caller: it is an
 * effect, not part of the routing decision, and whether a branch performs it
 * is preserved there.
 */
export function resolveAppHotkey(e: KeyboardEvent, ctx: AppHotkeyContext): AppHotkeyAction | null {
  // Always claim Ctrl/Cmd+S, even inside an editor field, so the browser's
  // own "save page" dialog never appears. No allow-check.
  if ((e.ctrlKey || e.metaKey) && matchKey(e, 's')) return { type: 'save' }

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && matchKey(e, 'k')) {
    return comboHotkeyAllowed(e) ? { type: 'palette' } : null
  }

  // Ctrl+Alt+L (not plain Ctrl+L, reserved by browser chrome; not
  // Ctrl+Shift+L, a common password-manager binding).
  if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && matchKey(e, 'l')) {
    return comboHotkeyAllowed(e) ? { type: 'closeFile' } : null
  }

  const fKeyMatch = /^F([1-7])$/.exec(e.key)
  if (fKeyMatch) {
    // navHotkeyAllowed, not hotkeyAllowed: must still fire while editing, or
    // F5/F6/F7 fall through to the browser's refresh / address-bar / caret
    // browsing default.
    if (!navHotkeyAllowed(e)) return null
    return { type: 'paneModule', index: Number(fKeyMatch[1]) - 1 }
  }

  if (!e.altKey) return null
  // Every Alt branch below needs the caret reachable while typing in a
  // rich-text field, and none inserts a character — checked once here since
  // it doesn't vary by branch.
  if (!navHotkeyAllowed(e)) return null

  if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    return { type: 'historyStep', dir: e.key === 'ArrowLeft' ? -1 : 1 }
  }
  if (e.shiftKey && e.key === 'ArrowUp') return { type: 'historyLatest' }
  if (e.shiftKey) return null

  // Alt+[ / Alt+] / Alt+T: daily-notes day nav. Match the physical key as
  // well as the produced character, for layouts where '['/']' sit behind
  // AltGr/dead keys (or Dvorak's 't'). Only acts when the focused pane is
  // currently showing a daily note; otherwise the key is left alone.
  const dayPrev = e.key === '[' || e.code === 'BracketLeft'
  const dayNext = e.key === ']' || e.code === 'BracketRight'
  const dayToday = matchKey(e, 't')
  if (dayPrev || dayNext || dayToday) {
    if (!ctx.focusedPaneShowsDailyNote) return null
    return { type: 'dayNav', to: dayPrev ? 'prev' : dayNext ? 'next' : 'today' }
  }

  // Alt+, / Alt+. — jump to the prev/next day that has a note (skip empties).
  const dayPrevContent = e.key === ',' || e.code === 'Comma'
  const dayNextContent = e.key === '.' || e.code === 'Period'
  if (dayPrevContent || dayNextContent) {
    if (!ctx.focusedPaneShowsDailyNote) return null
    return { type: 'dayNav', to: dayPrevContent ? 'prevWithContent' : 'nextWithContent' }
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    return { type: 'selectPane', index: e.key === 'ArrowLeft' ? 0 : 1 }
  }
  if (e.key === 'ArrowUp') return { type: 'toggleSplit' }
  if (e.key === 'ArrowDown') return { type: 'swapPanes' }

  for (let n = 1; n <= 9; n++) {
    // matchDigit, not Number(e.key): AZERTY's top row types symbols unless
    // Shift is held, so e.key is '&'/'é'/… where a digit is expected —
    // e.code stays 'Digit<n>'.
    if (!matchDigit(e, n)) continue
    // Digit with no matching team: the inline handler returned WITHOUT
    // preventDefault, i.e. the key was left to the browser. Same here.
    if (n > ctx.teamCount) return null
    return { type: 'selectTeam', index: n - 1 }
  }
  return null
}
