// src/ui/modal.ts
import { t, type Locale } from '../core/i18n'
import { el } from './dom'

export interface ModalButton {
  label: string
  primary?: boolean
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
  close(): void
}

interface RenderedDialog extends ModalHandle {
  buttonEls: HTMLButtonElement[]
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
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      const primary = opts.buttons.find((b) => b.primary)
      primary?.onClick()
    }
  }

  const buttonEls: HTMLButtonElement[] = opts.buttons.map((b) => {
    const btn = el(
      'button',
      {
        class: b.primary ? 'tt-btn tt-btn-primary' : 'tt-btn',
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

  return { close, buttonEls }
}

export function showModal(opts: ModalOptions): ModalHandle {
  const { close } = renderDialog(opts)
  return { close }
}

export function showErrorModal(locale: Locale, message: string): ModalHandle {
  const body = el('p', { class: 'tt-modal-message' }, message)
  let handle: ModalHandle
  handle = showModal({
    title: t(locale, 'err_title'),
    body,
    buttons: [{ label: t(locale, 'ok'), primary: true, onClick: () => handle.close() }],
  })
  return handle
}

export function promptPassword(locale: Locale, opts: { confirm?: boolean; title: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false

    function finish(value: string | null): void {
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

    const body = el(
      'div',
      { class: 'tt-password-form' },
      el('label', { class: 'tt-field' }, t(locale, 'password'), pwInput),
      confirmInput ? el('label', { class: 'tt-field' }, t(locale, 'password_confirm'), confirmInput) : null,
      errorEl
    )

    const cancelBtn: ModalButton = {
      label: t(locale, 'cancel'),
      onClick: () => {
        finish(null)
        close()
      },
    }
    const okBtn: ModalButton = { label: t(locale, 'ok'), primary: true, onClick: () => trySubmit() }

    const { close, buttonEls } = renderDialog({ title: opts.title, body, buttons: [cancelBtn, okBtn] })
    const okEl = buttonEls[1]!
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
      finish(value)
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

    pwInput.addEventListener('input', updateOkEnabled)
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
  if (!opts?.sticky) {
    setTimeout(dismiss, 4000)
  }
}
