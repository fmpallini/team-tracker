// src/ui/modal.ts
import { t, type Locale } from '../core/i18n'
import { el } from './dom'
import { createPasswordMeter } from './password-meter'

export interface ModalButton {
  label: string
  primary?: boolean
  /** Renders with the outlined, --danger-colored style — e.g. a Delete action alongside Cancel/Save. */
  danger?: boolean
  /** Pushes this button to the start of the row (`margin-right: auto`) so it visually separates from the rest — e.g. keeping a Delete action apart from Cancel/Save. */
  left?: boolean
  onClick: () => void
}

export interface ModalOptions {
  title: string
  body: HTMLElement
  buttons: ModalButton[]
  /** Fires exactly once, however the dialog closes (a button's onClick calling handle.close(), or Escape) — e.g. openPrefs uses this to trigger a save on the way out instead of waiting for the next nav change or autosave tick. */
  onClose?: () => void
}

export interface ModalHandle {
  close: () => void
}

interface RenderedDialog extends ModalHandle {
  buttonEls: HTMLButtonElement[]
}

/**
 * Tab-reachable elements inside a dialog, in DOM order — used both to trap
 * Tab/Shift+Tab at the dialog's edges and to pick the initial focus target.
 * Excludes anything explicitly taken out of tab order (tabindex="-1", e.g.
 * the secondary hover-only buttons on kanban/risk rows) and anything hidden
 * via CSS (offsetParent null), same as a native focus trap would.
 */
function getFocusable(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
  return Array.from(candidates).filter((node) => {
    if (node.hasAttribute('disabled')) return false
    if (node.tabIndex < 0) return false
    if (node.offsetParent === null && node !== document.activeElement) return false
    return true
  })
}

function renderDialog(opts: ModalOptions): RenderedDialog {
  const overlay = el('div', { class: 'tt-modal-overlay' })

  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    overlay.remove()
    document.removeEventListener('keydown', onKeydown)
    opts.onClose?.()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { close(); return }
    // Enter in a text field submits the modal via its primary action —
    // mirrors native <form> submit-on-Enter so every showModal() caller
    // (team/person add-edit, etc.) gets it for free instead of each needing
    // its own keydown wiring (promptPassword already has its own, richer
    // version of this for its two-field confirm flow).
    //
    // dialog.contains(e.target) matters: a caller that opens this modal from
    // inside its own capture-phase Enter handler (e.g. the Ctrl+K palette's
    // "Due" row) does so mid-dispatch, before that same Enter event finishes
    // bubbling — so this listener, freshly added to `document`, still sees
    // it. Without the containment check, e.target was the palette's own
    // (already-detached) <input>, which still satisfies `instanceof
    // HTMLInputElement`, so this modal immediately clicked its own primary
    // button and closed itself before ever painting.
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && dialog.contains(e.target)) {
      const primary = opts.buttons.find((b) => b.primary)
      primary?.onClick()
    }
    // Focus trap: the overlay is the last element in <body>, so without this
    // Tab from the last field would walk off into the page behind it (and
    // Shift+Tab from the first field likewise) instead of cycling within the
    // dialog — the background isn't inert, just visually covered.
    if (e.key === 'Tab') {
      const focusable = getFocusable(dialog)
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) { e.preventDefault(); last.focus() }
      } else {
        if (active === last || !dialog.contains(active)) { e.preventDefault(); first.focus() }
      }
    }
  }

  const buttonEls: HTMLButtonElement[] = opts.buttons.map((b) => {
    const classes = ['tt-btn']
    if (b.primary) classes.push('tt-btn-primary')
    if (b.danger) classes.push('tt-btn-danger')
    if (b.left) classes.push('tt-btn-left')
    const btn = el(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        onclick: () => b.onClick(),
      },
      b.label
    )
    return btn
  })
  const buttonsRow = el('div', { class: 'tt-modal-buttons' }, ...buttonEls)

  const dialog = el(
    'div',
    { class: 'tt-modal-dialog', role: 'dialog', 'aria-modal': 'true' },
    el('h2', { class: 'tt-modal-title' }, opts.title),
    opts.body,
    buttonsRow
  )

  overlay.appendChild(dialog)
  document.addEventListener('keydown', onKeydown)
  document.body.appendChild(overlay)

  // Default the initial focus to the dialog's first field/row so keyboard
  // interaction (Tab, Enter, or a list's own arrow keys) works immediately
  // without a preceding click. Several callers (promptPassword, kanban card,
  // person add/edit) already .focus() a specific field of their own right
  // after showModal() returns — that call simply wins over this one, so it's
  // harmless for them and only changes behavior for callers that had no
  // initial focus at all.
  getFocusable(dialog)[0]?.focus()

  return { close, buttonEls }
}

export function showModal(opts: ModalOptions): ModalHandle {
  const { close } = renderDialog(opts)
  return { close }
}

export function showErrorModal(locale: Locale, message: string): ModalHandle {
  const body = el('p', { class: 'tt-modal-message' }, message)
  const handle: ModalHandle = showModal({
    title: t(locale, 'err_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
  return handle
}

/**
 * Shared shape for every "confirm before deleting" dialog in the app: a
 * message, Cancel, and a confirm button that closes the dialog either way.
 * `variant` defaults to 'primary' (most callers) — action-items.ts's kanban
 * card delete is the one caller that wants the stronger 'danger' styling.
 */
export function confirmDelete(locale: Locale, opts: {
  title: string
  message: string
  confirmLabel: string
  variant?: 'danger' | 'primary'
  onConfirm: () => void
}): void {
  const body = el('p', { class: 'tt-modal-message' }, opts.message)
  const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => handle.close() }
  const confirmBtn: ModalButton = {
    label: opts.confirmLabel,
    danger: opts.variant === 'danger',
    primary: opts.variant !== 'danger',
    onClick: () => {
      opts.onConfirm()
      handle.close()
    },
  }
  const handle: ModalHandle = showModal({ title: opts.title, body, buttons: [cancelBtn, confirmBtn] })
}

export function promptPassword(
  locale: Locale,
  opts: { confirm?: boolean; allowPlain?: boolean; title: string }
): Promise<{ password: string } | { plain: true } | null> {
  return new Promise((resolve) => {
    let settled = false

    function finish(value: { password: string } | { plain: true } | null): void {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onEsc)
      resolve(value)
    }

    const pwInput = el('input', {
      type: 'password',
      class: 'tt-input',
      name: 'tt-password',
      autocomplete: opts.confirm ? 'new-password' : 'current-password',
      minlength: 4,
    })
    const confirmInput = opts.confirm
      ? el('input', { type: 'password', class: 'tt-input', name: 'tt-password-confirm', autocomplete: 'new-password', minlength: 4 })
      : null
    const errorEl = el('div', { class: 'tt-field-error' })

    const meter = opts.confirm ? createPasswordMeter(locale) : null

    const plainHint = opts.allowPlain ? el('p', { class: 'tt-password-plain-hint' }, t(locale, 'create_plain_hint')) : null

    const body = el(
      'form',
      { class: 'tt-password-form', onsubmit: (e: Event) => e.preventDefault() },
      el('label', { class: 'tt-field' }, t(locale, 'password'), pwInput),
      meter ? meter.el : null,
      confirmInput ? el('label', { class: 'tt-field' }, t(locale, 'password_confirm'), confirmInput) : null,
      errorEl,
      plainHint
    )

    const cancelBtn: ModalButton = {
      label: t(locale, 'cancel'),
      onClick: () => {
        finish(null)
        close()
      },
    }
    const okBtn: ModalButton = { label: t(locale, 'ok'), primary: true, onClick: () => trySubmit() }
    const plainBtn: ModalButton | null = opts.allowPlain
      ? {
          label: t(locale, 'create_plain_btn'),
          onClick: () => {
            finish({ plain: true })
            close()
          },
        }
      : null

    const buttons = plainBtn ? [cancelBtn, plainBtn, okBtn] : [cancelBtn, okBtn]
    const { close, buttonEls } = renderDialog({ title: opts.title, body, buttons })
    const okEl = buttonEls[buttonEls.length - 1]!
    okEl.disabled = true

    function updateOkEnabled(): void {
      okEl.disabled = pwInput.value.length === 0 || (confirmInput !== null && confirmInput.value.length === 0)
    }

    function trySubmit(): void {
      if (okEl.disabled) return
      if (confirmInput && pwInput.value.length < 4) {
        errorEl.textContent = t(locale, 'password_too_short')
        return
      }
      if (confirmInput && confirmInput.value !== pwInput.value) {
        errorEl.textContent = t(locale, 'password_mismatch')
        return
      }
      const value = pwInput.value
      finish({ password: value })
      close()
    }

    function onFieldKeydown(e: KeyboardEvent): void {
      if (e.key === 'Enter') {
        e.preventDefault()
        trySubmit()
      }
    }

    function onEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape') finish(null)
    }

    pwInput.addEventListener('input', () => {
      updateOkEnabled()
      meter?.update(pwInput.value)
    })
    pwInput.addEventListener('keydown', onFieldKeydown)
    confirmInput?.addEventListener('input', updateOkEnabled)
    confirmInput?.addEventListener('keydown', onFieldKeydown)
    document.addEventListener('keydown', onEsc)

    pwInput.focus()
  })
}

interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastOptions {
  sticky?: boolean
  /** Task 25: e.g. the "Salvar como…" recovery action on a failed save. */
  action?: ToastAction
}

/**
 * Most toasts a user will ever see at once. Two was already enough to cover
 * the lower-right corner of a note editor — a sticky fallback notice with a
 * transient one stacked under it — and the stack has no upper bound of its
 * own, so a burst could wall off that corner indefinitely. Oldest goes first:
 * the newest message is the one the user is looking for.
 */
const MAX_TOASTS = 3

let toastStack: HTMLElement | null = null

function getToastStack(): HTMLElement {
  if (!toastStack || !toastStack.isConnected) {
    toastStack = el('div', { class: 'tt-toast-stack' })
    document.body.appendChild(toastStack)
  }
  return toastStack
}

export function toast(msg: string, opts?: ToastOptions): void {
  const stack = getToastStack()
  const children: (Node | string)[] = [msg]
  if (opts?.action) {
    const action = opts.action
    children.push(el('button', { class: 'tt-toast-action', type: 'button', onclick: () => action.onClick() }, action.label))
  }
  const node = el('div', { class: 'tt-toast' }, ...children)
  function dismiss(): void {
    node.remove()
  }
  // A click anywhere in the toast dismisses it, including on the action
  // button — the button's own onclick (above) runs first (event target),
  // then this bubbles to run the action before removing the node.
  node.addEventListener('click', dismiss)
  stack.appendChild(node)
  // Trim from the top (oldest) — including sticky ones, which is the point:
  // a sticky toast that has been on screen through three later messages has
  // said what it had to say.
  while (stack.childElementCount > MAX_TOASTS) {
    stack.firstElementChild?.remove()
  }
  if (!opts?.sticky) {
    setTimeout(dismiss, 4000)
  }
}
