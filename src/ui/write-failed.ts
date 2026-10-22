// src/ui/write-failed.ts — what the user is offered when the file could not be
// written at Lock/Close. Nothing is lost at this point (the browser copy has every
// edit), so the choices are about the FILE: get it written after all (re-grant
// permission, retry), take a copy out right now (download), leave it behind on
// purpose (close anyway), or stay. Nothing here closes the document by itself.
import { t, type Locale } from '../core/i18n'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'

export interface WriteFailedOptions {
  locale: Locale
  reason: 'permission' | 'error' | 'conflict'
  /** Whether re-granting means anything here: there is a file handle to re-grant. Only offered for `permission`. */
  canRegrant: boolean
  /** Re-requests permission (a user gesture is on the stack); true when the grant is held. */
  onRegrant(): Promise<boolean>
  /** Hands the user a `.tmv` copy of the document as it is now. */
  onDownload(): void
  /** Tries the write again; true when it worked. */
  onRetry(): Promise<boolean>
  /** The browser copy is failing (or missing) too, so "the browser keeps your work" is not true: say so, and call closing what it is. */
  copyFailed?: boolean
  /** Offer "close anyway" (default). Off when the dialog was opened from the pill: there is no closing to push through. */
  allowCloseAnyway?: boolean
}

/**
 * 'resolved': the problem is gone (the caller checks by writing once more); 'closed-anyway': the user chose to leave
 * the file behind; 'cancelled': stay in the document (Cancel, Escape).
 */
export function showWriteFailedDialog(opts: WriteFailedOptions): Promise<'closed-anyway' | 'resolved' | 'cancelled'> {
  const { locale } = opts
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: 'closed-anyway' | 'resolved' | 'cancelled'): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const still = el('p', { class: 'tt-write-failed-still tt-field-error' }, t(locale, 'write_failed_still'))
    still.hidden = true
    let busy = false

    /** Runs an async fix; a fix that did not work leaves the dialog up with a note, a working one resolves. */
    const attempt = (fix: () => Promise<boolean>): void => {
      if (busy) return
      busy = true
      still.hidden = true
      fix()
        .then((ok) => {
          if (ok) { finish('resolved'); handle.close() } else still.hidden = false
        })
        .catch((e: unknown) => { console.error(e); still.hidden = false })
        .finally(() => { busy = false })
    }

    const buttons: ModalButton[] = []
    if (opts.allowCloseAnyway !== false) {
      buttons.push({ label: t(locale, opts.copyFailed ? 'write_failed_close_discard' : 'write_failed_close_anyway'), danger: true, left: true, onClick: () => { finish('closed-anyway'); handle.close() } })
    }
    buttons.push(
      { label: t(locale, 'cancel'), icon: 'close', onClick: () => { finish('cancelled'); handle.close() } },
      { label: t(locale, 'write_failed_download'), onClick: () => opts.onDownload() },
      { label: t(locale, 'write_failed_retry'), primary: !(opts.reason === 'permission' && opts.canRegrant), onClick: () => attempt(() => opts.onRetry()) },
    )
    if (opts.reason === 'permission' && opts.canRegrant) {
      buttons.push({ label: t(locale, 'write_failed_regrant'), primary: true, onClick: () => attempt(() => opts.onRegrant()) })
    }

    const bodyKey = opts.copyFailed ? 'write_failed_body_store' : opts.reason === 'permission' ? 'write_failed_body_permission' : 'write_failed_body_error'
    const handle: ModalHandle = showModal({
      title: t(locale, 'write_failed_title'),
      body: el('div', {}, el('p', { class: 'tt-modal-message' }, t(locale, bodyKey)), still),
      buttons,
      onClose: () => finish('cancelled'),
    })
  })
}
