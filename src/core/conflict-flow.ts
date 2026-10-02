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
import type { FileSession } from './fs'
import type { Shell } from '../ui/shell'
import { t } from './i18n'
import { pickCreate, forceWrite } from './fs'
import { docToBytes } from './doc-bytes'
import { showConflictModal } from '../ui/conflict'
import { toast } from '../ui/modal'

export interface ConflictFlowDeps {
  store: Store
  session: FileSession
  shell: Pick<Shell, 'setSaveState' | 'setTitle'>
  /** Read live on every use — a password change updates it after this flow is built. */
  getPassword: () => string | null
  /** Replaces the in-memory document with the file's current contents (the "Reload" choice). */
  reloadFromDisk: () => Promise<void>
  /** Re-requests the lapsed file permission; the "Grant access…" action of the permission toast. */
  resolveGrants: () => Promise<void>
  /** Re-opens the document on the fork's new file — see the note in `fork` for why not in place. */
  reopen: (forkSession: FileSession, doc: Doc, password: string | null) => void
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
      await deps.reloadFromDisk()
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

    // Before serializing, not after: `backupHandleId` travels
    // inside the .tmv itself, so a fork that kept it would mirror
    // its own saves into the ORIGINAL file's .bck and quietly
    // overwrite the backups belonging to a document it just
    // diverged from. The user re-picks a backup target for the
    // fork in prefs.
    store.update((d) => {
      d.prefs.dailyBackupEnabled = false
      d.prefs.backupHandleId = null
    })

    const currentPw = deps.getPassword()
    await forceWrite(forkSession, await docToBytes(store.doc, currentPw))
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
    // auto-save interval, a fresh backup controller, the right
    // title and a clean save state, with no new lifecycle code:
    // onDocumentOpened() already tears the previous app down.
    // (pickCreate has also repointed the 'lastHandle' IndexedDB
    // key at the fork, so "reopen last" follows it.)
    open = false
    deps.reopen(forkSession, store.doc, currentPw)
    return true
  }

  async function overwrite(): Promise<void> {
    try {
      await forceWrite(session, await docToBytes(store.doc, deps.getPassword()))
      store.markSaved()
      shell.setSaveState('saved')
      shell.setTitle(session.name, false)
    } catch (e) {
      console.error(e)
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        // Same lapsed-permission case save-controller.ts's doSave()
        // handles for a normal save — reached here instead because the
        // write that hit it was this "Overwrite" retry. Reuses the same
        // recovery, resolveGrants(): if the file is still externally
        // different once permission's fixed, the retried (non-forced)
        // save surfaces the conflict modal again rather than silently
        // forcing this "Overwrite" choice through a permission
        // side-channel — the user re-confirms instead of it happening
        // unattended.
        shell.setSaveState('permission')
        toast(t(locale(), 'save_permission_toast'), {
          sticky: true,
          action: { label: t(locale(), 'grant_access_ellipsis'), onClick: () => void deps.resolveGrants() },
        })
      } else {
        shell.setSaveState('error')
        toast(t(locale(), 'save_error_toast'), { sticky: true })
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
    })
  }

  return { onExternalChange, isOpen: () => open }
}
