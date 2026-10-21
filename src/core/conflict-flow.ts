// src/core/conflict-flow.ts — what happens when a write hits `ExternalChangeError`
// (the file changed outside this tab since it was last read or written): the
// conflict modal and its three ways out — Reload, Overwrite, Fork.
//
// Extracted out of main.ts's `onDocumentOpened` (which just wires its deps in)
// because this is the path where a wrong branch loses someone's data, and as
// part of that closure it could only be exercised end to end. Same shape as
// change-password.ts / tab-lock.ts: everything stateful comes in through deps.
import type { Doc } from './types'
import type { Store } from './store'
import type { ImageStore } from './image-store'
import type { FileSession } from './fs'
import type { Shell } from '../ui/shell'
import { t } from './i18n'
import { pickCreate, forceWrite } from './fs'
import { docToBytes } from './doc-bytes'
import { buildSnapshot, commitSnapshot } from './snapshot'
import { newStamp, randomHex, type FileStamp } from './file-stamp'
import type { LivePersister } from './live-persist'
import type { ReloadedDocument } from './reload-document'
import type { FileSnapshot } from './file-snapshot'
import { showConflictModal } from '../ui/conflict'
import { toast } from '../ui/modal'
import { SAVE_PERMISSION_TOAST_KEY, SAVE_ERROR_TOAST_KEY } from '../ui/file-health-toasts'

export interface ConflictFlowDeps {
  store: Store
  session: FileSession
  shell: Pick<Shell, 'setTitle'>
  /** Read live on every use — a password change updates it after this flow is built. */
  getPassword: () => string | null
  /** Reads and decodes the file as it is now (asking for its password if that changed) without touching the open document. */
  readFromDisk: () => Promise<ReloadedDocument>
  /** Replaces the open document with what `readFromDisk` returned (the "Reload" choice) and refreshes the UI around it. */
  applyReloaded: (reloaded: ReloadedDocument) => void
  /** Re-requests the lapsed file permission; the "Grant access…" action of the permission toast. */
  resolveGrants: () => Promise<void>
  /** Told which file write landed (null: browser storage unavailable). */
  persister?: LivePersister | null
  /** The file writer, told how the conflict ended (or that the overwrite failed) so the pill follows. */
  snapshot?: Pick<FileSnapshot, 'fileWritten' | 'fileReloaded' | 'fileWriteFailed'>
  /** Re-opens the document on the fork's new file — see the note in `fork` for why not in place. */
  reopen: (forkSession: FileSession, doc: Doc, password: string | null, images: ImageStore, stamp: FileStamp) => void
}

export interface ConflictFlow {
  /** The save controller's `onExternalChange` hook: opens the conflict modal (once). */
  onExternalChange: () => void
  /** Whether the modal is up — teardown leaves it to resolve an unsaved close rather than stacking a discard prompt over it. */
  isOpen: () => boolean
}

export function createConflictFlow(deps: ConflictFlowDeps): ConflictFlow {
  const { store, session, shell } = deps

  // Task 25 fix #5: guards against a second conflict modal stacking on top of
  // the first — e.g. a trailing save round (fix #1) or the auto-save
  // interval hitting the same unresolved `ExternalChangeError` again while
  // the user hasn't chosen Reload/Overwrite yet. Reset once the modal's
  // chosen action (successfully or not) settles.
  let open = false

  const locale = (): Doc['prefs']['locale'] => store.doc.prefs.locale

  async function reload(): Promise<void> {
    try {
      const reloaded = await deps.readFromDisk()
      // Another document under the same name (a different file dropped over it, or restored from elsewhere) is not
      // this one's newer version: adopting it would graft foreign content onto this document's browser copy.
      if (reloaded.doc.docId !== store.doc.docId) throw new Error('the file holds a different document')
      deps.applyReloaded(reloaded)
      // The file is now the truth: the browser copy takes its content and its write as the lineage.
      await deps.persister?.adoptFileStamp(reloaded.stamp)
      deps.snapshot?.fileReloaded()
    } catch (e) {
      console.error(e)
      toast(t(locale(), 'conflict_reload_failed'), { sticky: true })
    } finally {
      open = false
    }
  }

  // Gap 3: the non-destructive way out of a conflict. Both other options throw
  // away one side of it — reload discards the in-memory edits, overwrite
  // discards whatever the other writer put in the file. Forking keeps both: the
  // in-memory document goes to a new file the user picks, and the original is
  // left exactly as the other writer left it. Resolves false when the user
  // dismissed the picker (the modal reopens; `open` stays true).
  async function fork(): Promise<boolean> {
    const stem = session.name.replace(/\.tmv$/i, '')
    const forkSession = await pickCreate(`${stem} (copy).tmv`)
    if (!forkSession) return false

    const currentPw = deps.getPassword()
    // The fork is a different document from here on, with its own browser copy: a shared docId would let the
    // original's copy (whose lineage the other writer's file broke) claim the fork file as its own.
    const forkDoc: Doc = { ...store.doc, docId: randomHex(16) }
    const stamp = newStamp()
    await forceWrite(forkSession, await docToBytes(forkDoc, currentPw, store.images, stamp))
    // The document's content is now persisted — to the fork rather
    // than to `session`, but persisted. Clearing dirty here is what
    // stops teardown (reached via `reopen` below) from
    // trying one last save into the ORIGINAL handle and hitting the
    // very ExternalChangeError this fork exists to resolve.
    store.markSaved()

    // Re-open rather than mutate `session` in place. `session` is
    // a shared mutable object, but tab-lock.ts captures
    // `session.name` ONCE into its lock name and BroadcastChannel
    // name — mutating it would leave the fork holding the original
    // file's write lock, i.e. two documents contending for one
    // lock. Going back through openDocument() gives the fork a
    // correctly-keyed tab lock, a fresh save controller and
    // auto-save interval, the right title and a clean save state, with no new lifecycle code:
    // onDocumentOpened() already tears the previous app down.
    // (forceWrite above has also repointed the 'lastHandle' IndexedDB
    // key at the fork, so "reopen last" follows it.)
    open = false
    deps.reopen(forkSession, forkDoc, currentPw, store.images, stamp)
    return true
  }

  async function overwrite(): Promise<void> {
    try {
      // An edit landing while the write is in flight is not in the bytes just
      // written; clearing `dirty` for it would drop it from every later save.
      const snapshot = await buildSnapshot(store, deps.getPassword())
      await forceWrite(session, snapshot.bytes)
      await commitSnapshot(deps.persister ?? null, snapshot.stamp, snapshot.revAtSnapshot)
      deps.snapshot?.fileWritten()
      if (store.rev === snapshot.revAtSnapshot) {
        store.markSaved()
        shell.setTitle(session.name)
      }
    } catch (e) {
      console.error(e)
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        // Same lapsed-permission case file-snapshot.ts's writeNow()
        // handles for a normal write — reached here instead because the
        // write that hit it was this "Overwrite" retry. Reuses the same
        // recovery, resolveGrants(): if the file is still externally
        // different once permission's fixed, the retried (non-forced)
        // save surfaces the conflict modal again rather than silently
        // forcing this "Overwrite" choice through a permission
        // side-channel — the user re-confirms instead of it happening
        // unattended.
        deps.snapshot?.fileWriteFailed('permission')
        // Keyed like file-health-toasts.ts's own toast, so the next successful write dismisses it.
        toast(t(locale(), 'save_permission_toast'), {
          sticky: true,
          key: SAVE_PERMISSION_TOAST_KEY,
          action: { label: t(locale(), 'grant_access_ellipsis'), onClick: () => void deps.resolveGrants() },
        })
      } else {
        deps.snapshot?.fileWriteFailed('error')
        toast(t(locale(), 'save_error_toast'), { sticky: true, key: SAVE_ERROR_TOAST_KEY })
      }
    } finally {
      open = false
    }
  }

  function onExternalChange(): void {
    if (open) return
    open = true
    showConflictModal({
      locale: locale(),
      onReload: reload,
      // Guarded on `session.handle`: without one there is no save picker
      // and no `writeFile()` either, so a conflict can't arise in the
      // first place (downloadFallback never throws ExternalChangeError).
      // Omitting the callback drops the button rather than showing one
      // that can't work.
      onFork: session.handle ? fork : undefined,
      onOverwrite: overwrite,
      // Escape (or any close without a choice) leaves the conflict unresolved:
      // release the guard so the next save attempt raises the modal again
      // instead of `saveNow()` no-opping forever behind a modal nobody can see.
      onDismiss: () => { open = false },
    })
  }

  return { onExternalChange, isOpen: () => open }
}
