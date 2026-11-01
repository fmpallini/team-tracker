// src/ui/reconcile-dialogs.ts — the questions core/live-open.ts can put to the
// user when a file is opened and the browser already holds a copy of the document.
import { t, type Locale, type MsgKey } from '../core/i18n'
import { OpenCancelled } from '../core/live-open'
import { el } from './dom'
import { showModal, type ModalButton } from './modal'

type Choice = 'browser' | 'file'

/**
 * Shows `title`/`body` with one button per choice; `dismissed` is what closing without a choice (Escape) means.
 * Resolves after the dialog is gone, so a caller never opens its next dialog on top of this one.
 */
function ask<T>(locale: Locale, titleKey: MsgKey, bodyKey: MsgKey, choices: { label: MsgKey; value: T; primary?: boolean }[], dismissed: () => T, bodyParams?: Record<string, string>): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const buttons: ModalButton[] = choices.map((c) => ({
      label: t(locale, c.label),
      primary: c.primary,
      onClick: () => { finish(c.value); handle.close() },
    }))
    const handle = showModal({
      title: t(locale, titleKey),
      body: el('p', { class: 'tt-modal-message' }, t(locale, bodyKey, bodyParams)),
      buttons,
      onClose: () => finish(dismissed()),
    })
  })
}

/**
 * The file is an older version than the one this browser produced (typically a cloud-history restore of the same
 * file; a backup copy elsewhere is another file, which live-open.ts opens separately without asking). Keeping the
 * browser copy overwrites the file, so dismissing is not a choice: it cancels the open (rejects with OpenCancelled).
 */
export async function askOlderFile(locale: Locale): Promise<Choice> {
  const answer = await ask<Choice | 'cancel'>(locale, 'reconcile_older_title', 'reconcile_older_body', [
    { label: 'reconcile_older_cancel', value: 'cancel' },
    { label: 'reconcile_older_use_file', value: 'file' },
    { label: 'reconcile_older_keep_browser', value: 'browser', primary: true },
  ], () => 'cancel')
  if (answer === 'cancel') throw new OpenCancelled()
  return answer
}

/**
 * The browser copy follows another file (`copyFileName`) and holds edits no file has; the opened file is a copy of it,
 * or that file moved or renamed. Opening separately loses nothing, so it is the primary choice; dismissing cancels the
 * open (rejects with OpenCancelled).
 */
export async function askOtherFile(locale: Locale, copyFileName: string): Promise<'separate' | 'same'> {
  const answer = await ask<'separate' | 'same' | 'cancel'>(locale, 'reconcile_other_title', 'reconcile_other_body', [
    { label: 'reconcile_other_cancel', value: 'cancel' },
    { label: 'reconcile_other_same', value: 'same' },
    { label: 'reconcile_other_separate', value: 'separate', primary: true },
  ], () => 'cancel', { file: copyFileName })
  if (answer === 'cancel') throw new OpenCancelled()
  return answer
}

/**
 * The file changed elsewhere and the browser also holds edits the file never got. Both answers discard something,
 * so dismissing is not a choice: it cancels the open (rejects with OpenCancelled).
 */
export async function askBothChanged(locale: Locale): Promise<Choice> {
  const answer = await ask<Choice | 'cancel'>(locale, 'reconcile_both_title', 'reconcile_both_body', [
    { label: 'reconcile_both_cancel', value: 'cancel' },
    { label: 'reconcile_both_use_file', value: 'file' },
    { label: 'reconcile_both_keep_browser', value: 'browser', primary: true },
  ], () => 'cancel')
  if (answer === 'cancel') throw new OpenCancelled()
  return answer
}

/**
 * The browser copy holds edits the file never got, but cannot be read (wrong or forgotten password, damaged). Opening
 * the file replaces it, so that is a choice: dismissing cancels the open and leaves the copy as it is.
 */
export async function confirmDiscardCopy(locale: Locale): Promise<void> {
  const answer = await ask<'file' | 'cancel'>(locale, 'reconcile_unusable_title', 'reconcile_unusable_body', [
    { label: 'reconcile_unusable_cancel', value: 'cancel', primary: true },
    { label: 'reconcile_unusable_use_file', value: 'file' },
  ], () => 'cancel')
  if (answer === 'cancel') throw new OpenCancelled()
}
