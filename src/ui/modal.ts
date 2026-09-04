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
  /** Return `false` to veto a close attempt (Escape or any path through `handle.close()`) — e.g. action-items.ts blocks closing a card that has content but no name. `onClose` does not fire on a vetoed attempt. Absent = every close is allowed. */
  beforeClose?: () => boolean
  /** Rendered in the title row, right-aligned next to `title` — e.g. action-items.ts's expand-mode toggle and (once expanded) its mirrored save-state pill. Omit for the plain title-only header every other modal uses. */
  headerExtra?: HTMLElement
  /**
   * Marks this as a *modeless* dialog: one that edits live into the store
   * (no OK/Cancel, closing isn't a commit) and so shouldn't wall off the
   * app's navigation hotkeys the way a real blocking dialog does. The
   * action-item card modal is the only one. `blockedByModal()` still counts
   * it (competing popovers, the update notice), but `blockedByBlockingModal()`
   * — which gates the palette / team-switch / pane hotkeys — ignores it, and
   * `dismissModelessModals()` can close it on the way into such a switch.
   */
  modeless?: boolean
  /** Rendered after the Cancel/OK button row, visually separated from it — e.g. promptPassword's "Use without password" escape hatch with its own disclaimer, kept apart from the primary encrypted flow. */
  footer?: HTMLElement
}

export interface ModalHandle {
  close: () => void
  /** The dialog's own element (not the full-viewport overlay) — for a caller that needs to toggle its own classes on it, e.g. action-items.ts's expand-mode sizing. Every other caller can ignore this and use `close()` alone. */
  dialogEl: HTMLElement
}

interface RenderedDialog extends ModalHandle {
  buttonEls: HTMLButtonElement[]
}

/**
 * Tab-reachable elements inside a dialog, in DOM order — used both to trap
 * Tab/Shift+Tab at the dialog's edges and to pick the initial focus target.
 * Excludes anything explicitly taken out of tab order (tabindex="-1", e.g.
 * the secondary hover-only buttons on kanban/risk rows). No modal in this
 * app currently CSS-hides a field instead of omitting it from the DOM, so
 * there's no offsetParent/visibility check to make — worth revisiting if
 * that ever changes, since offsetParent is always null under jsdom and any
 * check built on it couldn't be covered by this app's test suite.
 */
function getFocusable(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
  return Array.from(candidates).filter((node) => {
    if (node.hasAttribute('disabled')) return false
    if (node.tabIndex < 0) return false
    return true
  })
}

interface OpenDialog {
  dialog: HTMLElement
  /** Same veto-respecting close as the returned handle's. */
  close: () => void
  modeless: boolean
}

// Every open dialog, oldest first. Each `renderDialog` pushes its own
// entry here on open and removes it on close. Escape acts on the topmost
// entry only: without this, a single Escape reaching `document` fires
// *every* open modal's keydown listener, so closing the editor-help modal
// (or the link dialog, a confirm, promptPassword…) stacked over the
// action-item card modal would close the card modal underneath it too.
const openDialogs: OpenDialog[] = []

/**
 * Closes every currently-open *modeless* dialog (see `ModalOptions.modeless`),
 * respecting each one's `beforeClose`. Returns `true` if they all closed (or
 * there were none), `false` if any vetoed — the caller of a navigation that
 * called this should then abort, leaving the user on the dialog that refused
 * to close (e.g. the card modal parking the cursor back on a required-but-
 * empty name field). Used by the palette / team-switch / pane hotkeys and by
 * same-pane @ref navigation, all of which would otherwise tear the pane out
 * from under an open card.
 */
export function dismissModelessModals(): boolean {
  // Snapshot: close() mutates openDialogs. Topmost first is fine — there is
  // only ever one modeless dialog today, and independent ones have no close
  // ordering constraint.
  for (const entry of [...openDialogs].reverse()) {
    if (!entry.modeless) continue
    entry.close()
  }
  return !openDialogs.some((e) => e.modeless)
}

function renderDialog(opts: ModalOptions): RenderedDialog {
  const overlay = el('div', { class: opts.modeless ? 'tt-modal-overlay tt-modal-modeless' : 'tt-modal-overlay' })

  let closed = false
  function close(): void {
    if (closed) return
    if (opts.beforeClose && opts.beforeClose() === false) return
    closed = true
    const i = openDialogs.findIndex((e) => e.dialog === dialog)
    if (i !== -1) openDialogs.splice(i, 1)
    overlay.remove()
    document.removeEventListener('keydown', onKeydown)
    opts.onClose?.()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // A nested overlay that handled Escape itself (the @-mention
      // dropdown, emoji/template pickers, a context menu — all of which
      // preventDefault on their own Escape) shouldn't also close the modal
      // they float above. Topmost-only below covers modal-over-modal; this
      // covers popup-over-modal for any popup that marks the event handled.
      if (e.defaultPrevented) return
      if (openDialogs[openDialogs.length - 1]?.dialog !== dialog) return
      close()
      return
    }
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
      // preventDefault so the Enter can't also act on whatever the primary
      // action focuses next. The link modal (src/ui/editor.ts insertLink)
      // resolves its promise here, then a microtask later focuses the
      // editor and inserts the link — without this, the browser's default
      // Enter then ran on the now-focused contenteditable and split off a
      // stray empty paragraph, leaving the caret adrift from the new link.
      e.preventDefault()
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

  const titleRow = opts.headerExtra
    ? el('div', { class: 'tt-modal-title-row' }, el('h2', { class: 'tt-modal-title' }, opts.title), opts.headerExtra)
    : el('h2', { class: 'tt-modal-title' }, opts.title)

  const dialog = el(
    'div',
    { class: 'tt-modal-dialog', role: 'dialog', 'aria-modal': 'true' },
    titleRow,
    opts.body,
    buttonsRow,
    opts.footer ?? null
  )

  overlay.appendChild(dialog)
  openDialogs.push({ dialog, close, modeless: opts.modeless ?? false })
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

  return { close, buttonEls, dialogEl: dialog }
}

export function showModal(opts: ModalOptions): ModalHandle {
  const { close, dialogEl } = renderDialog(opts)
  return { close, dialogEl }
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

    const body = el(
      'form',
      { class: 'tt-password-form', onsubmit: (e: Event) => e.preventDefault() },
      el('label', { class: 'tt-field' }, t(locale, 'password'), pwInput),
      meter ? meter.el : null,
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

    // The password-less option is a separate flow, not a third primary
    // action: it lives in its own row under the Cancel/OK pair, with the
    // "plain text, no encryption" disclaimer sitting right next to the
    // button it describes rather than floating above the password fields.
    const plainFooter = opts.allowPlain
      ? el(
          'div',
          { class: 'tt-password-plain-row' },
          el('p', { class: 'tt-password-plain-hint' }, t(locale, 'create_plain_hint')),
          el(
            'button',
            {
              class: 'tt-btn',
              type: 'button',
              onclick: () => {
                finish({ plain: true })
                close()
              },
            },
            t(locale, 'create_plain_btn')
          )
        )
      : undefined

    const { close, buttonEls } = renderDialog({ title: opts.title, body, buttons: [cancelBtn, okBtn], footer: plainFooter })
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
