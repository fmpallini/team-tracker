// src/ui/hotkeys.ts
const EDITABLE_SELECTOR = 'input,textarea,select,[contenteditable="true"]'

/**
 * True if `e` is the letter shortcut for `letter` (a single lowercase a–z),
 * matched BOTH by the produced character (`e.key` — so it follows the user's
 * layout and the mnemonic, e.g. Ctrl+B really is "B" on a Dvorak board) AND
 * by the physical key (`e.code` === `Key<L>` — so it still fires on layouts
 * where `e.key` for that position isn't the letter: Dvorak/Colemak, or a
 * dead-key/AltGr layout that reports an unrelated `e.key` while Ctrl is
 * held). The digit-row shortcuts (headings, lists) already keyed off
 * `e.code` alone; this brings the letter shortcuts up to the same
 * layout-independence — the reason Ctrl+Shift+X (strikethrough) silently did
 * nothing on some international keyboards while Ctrl+Shift+7/8 worked.
 */
export function matchKey(e: KeyboardEvent, letter: string): boolean {
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`
}

/**
 * True if `e` is the number shortcut for digit `n` (0–9), matched by the
 * produced digit (`e.key`) or the physical number-row key (`e.code` ===
 * `Digit<n>`) — the latter covers layouts (AZERTY) whose top row types
 * symbols unless Shift is held, so `e.key` is `'&'`/`'é'`/… where `'1'`/`'2'`
 * is expected.
 */
export function matchDigit(e: KeyboardEvent, n: number): boolean {
  return e.key === String(n) || e.code === `Digit${n}`
}

/**
 * True while a modal dialog is open (see the `.tt-modal-overlay` class in
 * modal.ts). Shared by both guards below, and by update-notice.ts to keep
 * the relaunch-for-update button non-clickable behind an open modal.
 */
export function blockedByModal(): boolean {
  return document.querySelector('.tt-modal-overlay') !== null
}

/**
 * True while the user is typing in a form field/contenteditable, or while a
 * modal dialog is open. Used by `hotkeyAllowed` only — a hotkey whose own key
 * would otherwise insert a character (e.g. search-ui.ts's `/` to focus
 * search, which the in-editor `/` template picker also claims) must not fire
 * while the user is typing.
 */
function blockedByFieldOrModal(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  if (target?.closest?.(EDITABLE_SELECTOR)) return true
  return blockedByModal()
}

/**
 * Guards a hotkey whose bare key would otherwise insert a character into
 * whatever field has focus (e.g. search-ui.ts's `/` to focus search) from
 * firing while the user is typing in a form field, while AltGr is held
 * (reported by browsers as ctrlKey+altKey), or while a modal dialog is open.
 * For hotkeys that *don't* type a character — Alt+1..9, Alt+Arrow, F1..F7 —
 * use `navHotkeyAllowed` instead, which stays reachable while editing.
 */
export function hotkeyAllowed(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey) return false
  return !blockedByFieldOrModal(e)
}

/**
 * Like `hotkeyAllowed`, but for global hotkeys whose own combo requires
 * Ctrl/Cmd (e.g. Ctrl+K for the command palette). Unlike `hotkeyAllowed`,
 * this must still fire while focus is inside an input/textarea/
 * contenteditable — the palette needs to be reachable while typing notes in
 * the WYSIWYG editor. Only a modal dialog being open blocks it.
 */
export function comboHotkeyAllowed(_e: KeyboardEvent): boolean {
  return !blockedByModal()
}

/**
 * Like `comboHotkeyAllowed`, but for the app's plain-key *navigation*
 * hotkeys — Alt+1..9 (team switch), Alt+Arrow/Alt+Shift+Arrow (pane
 * select/split/swap/history), and F1..F7 (pane module jump). These must
 * also reach the app while focus is inside a rich-text editor field (a
 * daily note, a risk title, a milestone follow-up): none of them insert a
 * character when typed, so there's nothing to protect by staying silent
 * while editing — and staying silent was actively harmful. `hotkeyAllowed`
 * returning false meant this app's keydown handler returned *before*
 * `e.preventDefault()`, so the browser's own default for that key ran
 * instead, unopposed: Alt+Arrow's back/forward navigation, Alt alone
 * opening the window menu on some platforms, or — worse — F5's page
 * refresh, F6's address-bar focus, or Firefox's F7 caret-browsing prompt,
 * any of which could fire mid-edit. Still blocked by AltGr (reported as
 * ctrlKey+altKey) and by an open modal, same as `hotkeyAllowed`.
 */
export function navHotkeyAllowed(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && comboHotkeyAllowed(e)
}
