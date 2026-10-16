// src/ui/readonly-lock.ts — while this tab is read-only (it lost, or never
// got, the cross-tab write lock; see core/tab-lock.ts), store.update() is
// blocked, so anything typed or toggled would show on screen and then be lost.
// The rich editors go non-editable on their own (ui/editor.ts's
// setEditorsReadOnly); this covers every other editing gesture with one
// document-level capture-phase guard: it runs before any module listener, so
// stopping the event there means no module ever sees it. Navigation (buttons,
// @mention chips, menus) is untouched. Containers marked data-readonly-exempt
// (the search box, the palette, the password prompt a takeover reload may
// raise while still read-only) keep working.
import { t, type Locale } from '../core/i18n'
import { toast } from './modal'

export const READONLY_TOAST_KEY = 'readonly-blocked'

/** Click targets that edit without being a form control. */
const EDITING_CLICK_TARGETS = '.tt-date-picker, .tt-kanban-color-row button'

let armed: { locale: () => Locale } | null = null

function refuse(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
  if (armed) toast(t(armed.locale(), 'readonly_blocked_toast'), { key: READONLY_TOAST_KEY })
}

function lockedTarget(e: Event): Element | null {
  const target = e.target
  if (!(target instanceof Element) || target.closest('[data-readonly-exempt]')) return null
  return target
}

function onBeforeInput(e: Event): void {
  const target = lockedTarget(e)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) refuse(e)
}

function onKeydown(e: KeyboardEvent): void {
  const target = lockedTarget(e)
  if (target instanceof HTMLSelectElement && e.key !== 'Tab' && e.key !== 'Escape') refuse(e)
}

function onMousedown(e: MouseEvent): void {
  const target = lockedTarget(e)
  if (target?.closest('select')) refuse(e)
}

function onClick(e: MouseEvent): void {
  const target = lockedTarget(e)
  if (!target) return
  if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) refuse(e)
  else if (target.closest(EDITING_CLICK_TARGETS)) refuse(e)
}

function onDragstart(e: DragEvent): void {
  if (lockedTarget(e)) refuse(e)
}

/** Arms (or lifts) the guard. Idempotent: arming twice installs the listeners once. */
export function setReadOnlyLock(readOnly: boolean, locale: () => Locale): void {
  document.documentElement.toggleAttribute('data-readonly', readOnly)
  if (readOnly) {
    if (armed) { armed.locale = locale; return }
    armed = { locale }
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('mousedown', onMousedown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('dragstart', onDragstart, true)
    return
  }
  if (!armed) return
  armed = null
  document.removeEventListener('beforeinput', onBeforeInput, true)
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('mousedown', onMousedown, true)
  document.removeEventListener('click', onClick, true)
  document.removeEventListener('dragstart', onDragstart, true)
}
