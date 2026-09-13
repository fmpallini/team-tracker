// src/ui/undo-toast.ts — renders an UndoOffer (core/undo-delete.ts) as the
// action button on the toast that follows a delete.
//
// An in-toast button rather than a hotkey, deliberately: Alt+Left/Alt+Right is
// already per-pane navigation history and Ctrl+Z is already the rich editor's
// native undo. A button collides with neither, and it makes the offer's short
// lifetime visible instead of leaving the user to guess whether an undo is
// still available.
import type { Store } from '../core/store'
import type { UndoOffer } from '../core/undo-delete'
import { t, type Locale } from '../core/i18n'
import { toast, dismissToast } from './modal'

/**
 * Ten seconds rather than the 4000ms default: this toast is the only window
 * in which a delete can be taken back, so it has to outlast the moment of
 * realising the delete was a mistake.
 */
export const UNDO_TOAST_MS = 10_000

export const UNDO_TOAST_KEY = 'undo-delete'

/**
 * Shows `message`, adding an Undo button when `offer` is available.
 *
 * `deleteWithUndo` returns `null` for two unrelated reasons: the underlying
 * `store.update` was blocked (a read-only, non-writer tab — nothing was
 * actually deleted) or `mutate` found nothing to delete. Only a read-only
 * store can tell the two apart from here, so that's the one case where even
 * the plain-message toast is suppressed — otherwise a read-only tab would
 * announce a deletion that never happened. `offer` non-null but
 * `!isAvailable()` (nothing calls store.update() between deleteWithUndo()
 * and this today, but nothing enforces that either) falls through to the
 * same plain-toast path rather than rendering a button that would refuse to
 * do anything.
 *
 * Also watches the store: the offer expires the instant anything else
 * mutates the document (see `deleteWithUndo`), so the toast is dismissed
 * then rather than left on screen with a button that would refuse to work.
 * `onMutate` covers `update()`/`updateNav()`; `replaceDoc()` does not fire it,
 * which is why `offer.undo()` re-checks `rev` itself as the real backstop —
 * and, since that backstop can still refuse, the button's click handler
 * always shows *some* toast after calling it, restored or not.
 *
 * The store watcher and expiry timer are released when the Undo button is
 * clicked or the toast expires naturally. They are NOT released just because
 * the toast is dismissed by clicking its body (modal.ts's own click-anywhere
 * dismiss) — that removes the DOM node but leaves this function's listener
 * and timer running harmlessly until one of the other two fires.
 */
export function offerUndoToast(
  store: Store,
  locale: Locale,
  message: string,
  offer: UndoOffer | null,
): void {
  if (!offer?.isAvailable()) {
    if (!store.readOnly) toast(message)
    return
  }

  // A mutable holder rather than closing over `offer` directly: modal.ts's
  // own dismiss timer (src/ui/modal.ts's `setTimeout(dismiss, …)`) is never
  // cleared, so whatever keeps the toast node reachable also keeps this
  // function's whole closure — `offer` included — reachable for the rest of
  // its ten seconds, no matter how early the toast is dismissed (mutation
  // watcher, key replacement, the MAX_TOASTS trim, or a body click all
  // remove the DOM node without cancelling that timer). stopWatching()
  // nulls this out on every dismissal path it *does* know about, so the
  // captured team clone inside `offer` (see core/undo-delete.ts) is released
  // at that point rather than only once the node itself is finally unreachable.
  let heldOffer: UndoOffer | null = offer

  let unsubscribe: (() => void) | null = null
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  const stopWatching = (): void => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
    unsubscribe?.()
    unsubscribe = null
    heldOffer = null
  }

  toast(message, {
    key: UNDO_TOAST_KEY,
    duration: UNDO_TOAST_MS,
    action: {
      label: t(locale, 'undo'),
      onClick: () => {
        // Before offer.undo(), which itself calls store.update() and would
        // otherwise trip the watcher below and dismiss the confirmation toast
        // this is about to show.
        const active = heldOffer
        stopWatching()
        if (active?.undo()) toast(t(locale, 'undo_restored'))
        else toast(t(locale, 'undo_unavailable'))
      },
    },
  })

  unsubscribe = store.onMutate(() => {
    stopWatching()
    dismissToast(UNDO_TOAST_KEY)
  })

  // Mirror modal.ts's dismiss timer so cleanup does not depend on modal.ts
  // exposing a dismiss hook it does not have. When the toast naturally expires
  // after UNDO_TOAST_MS, release the store watcher so it doesn't outlive the
  // toast it was watching.
  expiryTimer = setTimeout(stopWatching, UNDO_TOAST_MS)
}
