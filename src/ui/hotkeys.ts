// src/ui/hotkeys.ts
const EDITABLE_SELECTOR = 'input,textarea,select,[contenteditable="true"]'

/**
 * True while a modal dialog is open (see the `.tt-modal-overlay` class in
 * modal.ts). Shared by both guards below.
 */
function blockedByModal(): boolean {
  return document.querySelector('.tt-modal-overlay') !== null
}

/**
 * True while the user is typing in a form field/contenteditable, or while a
 * modal dialog is open. Used by `hotkeyAllowed` only — plain-key global
 * hotkeys (e.g. Alt+1..9) must not fire while the user is typing.
 */
function blockedByFieldOrModal(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  if (target?.closest?.(EDITABLE_SELECTOR)) return true
  return blockedByModal()
}

/**
 * Guards the global Alt+1..9 team-switch hotkey and the Alt+ArrowLeft/Right
 * pane-history hotkey (see main.ts) from firing while the user is typing in
 * a form field, while AltGr is held (reported by browsers as
 * ctrlKey+altKey), or while a modal dialog is open.
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
