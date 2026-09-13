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
 * Shows `message`, adding an Undo button when `offer` is non-null.
 *
 * Also watches the store: the offer expires the instant anything else
 * mutates the document (see `deleteWithUndo`), so the toast is dismissed
 * then rather than left on screen with a button that would refuse to work.
 * `onMutate` covers `update()`/`updateNav()`; `replaceDoc()` does not fire it,
 * which is why `offer.undo()` re-checks `rev` itself as the real backstop.
 */
export function offerUndoToast(
  store: Store,
  locale: Locale,
  message: string,
  offer: UndoOffer | null,
): void {
  if (!offer) {
    toast(message)
    return
  }

  let unsubscribe: (() => void) | null = null
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  const stopWatching = (): void => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
    unsubscribe?.()
    unsubscribe = null
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
        stopWatching()
        if (offer.undo()) toast(t(locale, 'undo_restored'))
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
