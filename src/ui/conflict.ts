// src/ui/conflict.ts — Task 25: modal shown when a write hits
// `ExternalChangeError` (the file changed outside this tab/app since it was
// last read or written).
import { t, type Locale } from '../core/i18n'
import { el } from './dom'
import { showModal, type ModalButton, type ModalHandle } from './modal'

export interface ConflictModalOptions {
  locale: Locale
  /** readCurrent → decryptDocument → store.replaceDoc (discards local edits). */
  onReload(): Promise<void>
  /** forceWrite the current in-memory state, ignoring the external change. */
  onOverwrite(): Promise<void>
}

/**
 * This modal is only ever opened from the save controller's
 * `onExternalChange()` hook, which itself only fires while a save was
 * attempted — i.e. while `store.dirty` was true. "Reload" therefore always
 * risks discarding in-memory changes, so it always confirms; no separate
 * `dirty` flag is needed in this module's contract.
 */
export function showConflictModal(opts: ConflictModalOptions): void {
  const { locale } = opts
  let handle: ModalHandle

  function confirmReload(): void {
    const body = el('p', { class: 'tt-modal-message' }, t(locale, 'conflict_reload_confirm'))
    let inner: ModalHandle
    const cancelBtn: ModalButton = { label: t(locale, 'cancel'), onClick: () => inner.close() }
    const confirmBtn: ModalButton = {
      label: t(locale, 'conflict_reload_btn'),
      primary: true,
      onClick: () => {
        inner.close()
        handle.close()
        Promise.resolve(opts.onReload()).catch((e) => console.error(e))
      },
    }
    inner = showModal({ title: t(locale, 'conflict_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function overwrite(): void {
    handle.close()
    Promise.resolve(opts.onOverwrite()).catch((e) => console.error(e))
  }

  const body = el('p', { class: 'tt-modal-message' }, t(locale, 'conflict_message'))
  const reloadBtn: ModalButton = { label: t(locale, 'conflict_reload_btn'), onClick: () => confirmReload() }
  const overwriteBtn: ModalButton = { label: t(locale, 'conflict_overwrite_btn'), primary: true, onClick: () => overwrite() }
  handle = showModal({ title: t(locale, 'conflict_title'), body, buttons: [reloadBtn, overwriteBtn] })
}
