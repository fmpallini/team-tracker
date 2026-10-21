// src/ui/reconcile-dialogs.ts — the two questions core/live-open.ts can put to the
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
function ask<T>(locale: Locale, titleKey: MsgKey, bodyKey: MsgKey, choices: { label: MsgKey; value: T; primary?: boolean }[], dismissed: () => T): Promise<T> {
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
      body: el('p', { class: 'tt-modal-message' }, t(locale, bodyKey)),
      buttons,
      onClose: () => finish(dismissed()),
    })
  })
}

/**
 * The file is an older version than the one this browser produced (typically a backup or cloud-history restore).
 * Dismissing keeps the browser copy: it is the one that loses nothing.
 */
export function askOlderFile(locale: Locale): Promise<Choice> {
  return ask<Choice>(locale, 'reconcile_older_title', 'reconcile_older_body', [
    { label: 'reconcile_older_use_file', value: 'file' },
    { label: 'reconcile_older_keep_browser', value: 'browser', primary: true },
  ], () => 'browser')
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
