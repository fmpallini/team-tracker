// src/core/close-document.ts — Lock/Close and the window-close handler, with their
// dependencies injected so the orchestration is unit-testable (main.ts is wiring).
//
// Lock/Close is the moment the user is told to rely on: the file is written now. The
// browser copy already has every edit, so a file that cannot be written is never a
// loss — but it is never silent either: the user is shown why and offered a way out.
import type { Store } from './store'
import type { FileSession } from './fs'
import type { FileSnapshot } from './file-snapshot'
import type { LivePersister } from './live-persist'
import { downloadFallback } from './fs'
import { buildSnapshot } from './snapshot'
import { t } from './i18n'
import { toast } from '../ui/modal'
import type { showWriteFailedDialog } from '../ui/write-failed'

export interface CloseDocumentDeps {
  store: Store
  /** Null when the browser could not open its storage. */
  persister: LivePersister | null
  snapshot: Pick<FileSnapshot, 'writeNow' | 'flush' | 'resolveGrants'>
  session: FileSession
  getPassword(): string | null
  /** Commits debounced editor input into the store. */
  flushEditors(): void
  /** The dialog, with the locale and the document-specific callbacks already filled in by this module. */
  ask(opts: Omit<Parameters<typeof showWriteFailedDialog>[0], 'locale'>): ReturnType<typeof showWriteFailedDialog>
  /** Releases everything the document holds; called once, after the file is written or the user chose to leave it. */
  teardown(): void | Promise<void>
  /** Whether the conflict modal is up: its Overwrite/Fork/Reload are the way out, so no second dialog is stacked on it. */
  isConflictOpen?(): boolean
}

/**
 * Edits that exist only in this tab's memory: the browser copy is failing or was never available, and the file does
 * not have them either. Closing or reloading now would discard them.
 */
export function browserCopyAtRisk(store: Pick<Store, 'dirty'>, persister: Pick<LivePersister, 'lastError'> | null): boolean {
  return store.dirty && (!persister || persister.lastError != null)
}

/**
 * "Try again" in the write-failed dialog: the browser copy first, then the file where there is a file to write. True
 * only when everything that can hold the edits does. With no file handle and no browser storage nothing can be fixed.
 */
export async function retryWrites(deps: Pick<CloseDocumentDeps, 'persister' | 'session'> & { snapshot: Pick<FileSnapshot, 'writeNow'> }): Promise<boolean> {
  const { persister, snapshot, session } = deps
  await persister?.flush()
  if (persister && persister.lastError != null) return false
  if (!session.handle) return persister != null
  return (await snapshot.writeNow('close')).ok
}

export async function closeDocument(deps: CloseDocumentDeps): Promise<'closed' | 'kept-open'> {
  const { store, persister, snapshot } = deps
  const locale = store.doc.prefs.locale

  deps.flushEditors()
  // The browser copy first: it is what keeps the work safe whatever happens to the file.
  await persister?.flush()
  const browserCopyFailed = !store.readOnly && persister?.lastError != null

  const finish = async (): Promise<'closed'> => {
    // Edits made while a dialog was up still belong in the browser copy.
    await persister?.flush()
    await deps.teardown()
    return 'closed'
  }

  for (;;) {
    const result = await snapshot.writeNow('close')
    await snapshot.flush()
    // With no file to write, the browser copy is the only place the edits live: when that is failing too, leaving
    // would discard them, so it is a failure like any other (its way out is a download or a recovered store).
    const noWhereToKeepEdits = result.ok === false && result.reason === 'nohandle' && browserCopyAtRisk(store, persister)
    if (result.ok || result.reason === 'readonly' || (result.reason === 'nohandle' && !noWhereToKeepEdits)) {
      // The file now holds the document, so nothing is at risk; the browser merely could not keep its own copy.
      if (result.ok && browserCopyFailed) toast(t(locale, 'close_browser_copy_failed_toast'), { kind: 'warn' })
      return finish()
    }
    // The conflict modal resolves itself with its own choices; stacking this dialog on it would hide that.
    if (result.reason === 'conflict' || deps.isConflictOpen?.()) return 'kept-open'

    const choice = await deps.ask({
      reason: result.reason === 'nohandle' ? 'error' : result.reason,
      canRegrant: result.reason === 'permission' && deps.session.handle !== null,
      // Whether "the browser keeps your work" is still true: it is not when its own copy is failing or missing.
      copyFailed: !persister || persister.lastError != null,
      onRegrant: () => snapshot.resolveGrants(),
      onDownload: () => { void downloadCopy(deps.store, deps.session, () => deps.getPassword()) },
      onRetry: () => retryWrites(deps),
    })
    if (choice === 'cancelled') return 'kept-open'
    if (choice === 'closed-anyway') return finish()
    // 'resolved': write once more to be sure, and ask again if it is not really fixed.
  }
}

/** A `.tmv` of the document as it is now, handed to the user as a download. */
export async function downloadCopy(store: Store, session: FileSession, getPassword: () => string | null): Promise<void> {
  try {
    const snap = await buildSnapshot(store, getPassword())
    downloadFallback(session.name, snap.bytes)
  } catch (e) {
    console.error(e)
    toast(t(store.doc.prefs.locale, 'save_error_toast'), { kind: 'error', sticky: true })
  }
}

/**
 * `beforeunload`: the window cannot wait for an asynchronous file write, so all that is done is to get the browser
 * copy as current as an unload allows. The browser's "leave site?" prompt appears only when the file is overdue (older
 * than the timer interval) — then the user is nudged towards Lock/Close, which guarantees a file write. Leaving anyway
 * loses nothing: the next open reconciles the file with the browser copy. The exception is a document with no working
 * browser copy (storage failing, or never available): its edits would be lost, so that prompts at once.
 */
export function createBeforeUnloadHandler(deps: {
  flushEditors(): void
  store: Pick<Store, 'dirty'>
  persister: LivePersister | null
  snapshot: Pick<FileSnapshot, 'isOverdue'>
}): (e: BeforeUnloadEvent) => void {
  return (e) => {
    deps.flushEditors()
    void deps.persister?.flush()
    if (deps.snapshot.isOverdue() || browserCopyAtRisk(deps.store, deps.persister)) {
      e.preventDefault()
      e.returnValue = ''
    }
  }
}
