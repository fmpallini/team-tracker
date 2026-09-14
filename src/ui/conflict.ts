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
  /**
   * Gap 3: the non-destructive way out. Writes the in-memory document to a
   * NEW file the user picks and moves the live session onto it, leaving the
   * external change in the original file untouched — so neither side of the
   * conflict is lost. Resolves true when the fork completed, false when the
   * user dismissed the save picker; on false this modal reopens, because a
   * cancelled picker must not silently drop the user back into an
   * unresolved conflict with no prompt.
   *
   * Optional: callers that can't fork (fallback mode, where there is no
   * save picker at all) simply omit it and get the original two buttons.
   */
  onFork?: () => Promise<boolean>
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

  function confirmReload(): void {
    const body = el('p', { class: 'tt-modal-message' }, t(locale, 'conflict_reload_confirm'))
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
    const inner: ModalHandle = showModal({ title: t(locale, 'conflict_title'), body, buttons: [cancelBtn, confirmBtn] })
  }

  function overwrite(): void {
    handle.close()
    Promise.resolve(opts.onOverwrite()).catch((e) => console.error(e))
  }

  /**
   * No confirmation step, unlike reload: forking destroys nothing, so there
   * is nothing to warn about. Any failure — including a cancelled picker —
   * reopens this modal rather than leaving the user with a dirty document,
   * a save pill stuck in error, and no visible way to act on it.
   */
  function fork(): void {
    const onFork = opts.onFork
    if (!onFork) return
    handle.close()
    Promise.resolve(onFork())
      .then((done) => { if (!done) showConflictModal(opts) })
      .catch((e: unknown) => { console.error(e); showConflictModal(opts) })
  }

  const body = el('p', { class: 'tt-modal-message' }, t(locale, 'conflict_message'))
  const reloadBtn: ModalButton = { label: t(locale, 'conflict_reload_btn'), onClick: () => confirmReload() }
  const overwriteBtn: ModalButton = { label: t(locale, 'conflict_overwrite_btn'), primary: true, onClick: () => overwrite() }
  // Fork leads: it is the only option that keeps both sides of the conflict.
  const buttons: ModalButton[] = opts.onFork
    ? [{ label: t(locale, 'conflict_fork_btn'), onClick: () => fork() }, reloadBtn, overwriteBtn]
    : [reloadBtn, overwriteBtn]
  const handle: ModalHandle = showModal({ title: t(locale, 'conflict_title'), body, buttons })
}
