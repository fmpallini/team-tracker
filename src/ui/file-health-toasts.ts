// src/ui/file-health-toasts.ts — the toasts that go with a file write going wrong
// (core/file-snapshot.ts holds no text of its own). A lapsed permission and a
// failed write are both sticky until a later write succeeds; the browser copy keeps
// the work meanwhile, which is what the wording says.
import type { FileHealth, FileSnapshot } from '../core/file-snapshot'
import { t, type Locale } from '../core/i18n'
import { toast, dismissToast } from './modal'

/** `toast()` keys, shared by every place that raises these notices so a repeat replaces instead of stacking, and so one success can clear them. */
export const SAVE_PERMISSION_TOAST_KEY = 'save-permission'
export const SAVE_ERROR_TOAST_KEY = 'save-error'

/** Returns the unsubscribe. `locale` is read on every use: it can change while the document is open. */
export function watchFileHealth(snapshot: FileSnapshot, locale: () => Locale): () => void {
  // One toast per episode: while the grant stays missing, the timer keeps retrying and the health keeps re-announcing it.
  let permissionToasted = false
  let errorToasted = false
  let previous: FileHealth['kind'] | null = null

  function onHealth(h: FileHealth): void {
    const was = previous
    previous = h.kind
    if (h.kind === 'permission') {
      if (permissionToasted) return
      permissionToasted = true
      const lc = locale()
      toast(t(lc, 'save_permission_toast'), {
        sticky: true,
        key: SAVE_PERMISSION_TOAST_KEY,
        action: { label: t(lc, 'grant_access_ellipsis'), onClick: () => void snapshot.resolveGrants() },
      })
    } else if (h.kind === 'error') {
      // 'conflict' belongs to the conflict modal, which is already up.
      if (h.message === 'conflict' || errorToasted) return
      errorToasted = true
      toast(t(locale(), 'save_error_toast'), { sticky: true, key: SAVE_ERROR_TOAST_KEY })
    } else if (h.kind === 'ok') {
      // Only on a transition into ok (a write just succeeded), not for the snapshot subscribe() announces at once.
      if (was === null || was === 'ok') return
      permissionToasted = false
      errorToasted = false
      dismissToast(SAVE_PERMISSION_TOAST_KEY)
      dismissToast(SAVE_ERROR_TOAST_KEY)
    }
  }

  return snapshot.subscribe(onHealth)
}
