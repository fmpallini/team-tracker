// src/core/change-password.ts — Task 24/25: re-encrypts (or plain-serializes)
// the current in-memory document under a new password and persists it via the
// same writeFile/downloadFallback split used by the create flow in
// src/ui/start.ts. Extracted out of main.ts so this concurrency-sensitive
// path (Task 25 fix #3, re-review item #2) can be unit tested directly
// instead of only through prefs.ts's mocked PrefsAppCtl.
import type { Store } from './store'
import type { FileSession } from './fs'
import { encryptDocument, serializePlain } from './crypto'
import { writeFile, downloadFallback } from './fs'
import { toast } from '../ui/modal'
import { t } from './i18n'
import type { Shell } from '../ui/shell'
import type { BackupController } from './backup-controller'

export interface ChangePasswordDeps {
  store: Store
  session: FileSession
  shell: Shell
  backupCtl: BackupController
  /** Waits out (and blocks) any concurrent save — see save-controller.ts's `runExclusive`. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  /** Flips the in-memory password held by main.ts's app closure. No-ops there if the app has since been torn down. */
  setPassword(newPw: string | null): void
}

/**
 * `currentPassword`/`fileSchemaVersion` are read live from the caller's own
 * state (not closed over here), so this function only ever needs the new
 * password and the deps above.
 *
 * It isn't a regular dirty-driven save, so it doesn't go through
 * `saveCtl.saveNow()` — but (Task 25 fix #3) it does run inside
 * `runExclusive()` so it can't interleave with one, and mirrors its
 * post-write bookkeeping — `markSaved()` so the just-written state isn't
 * re-saved as if still dirty, plus the save indicator/title — since the disk
 * file is now fully in sync with `store.doc` under the new key.
 */
export function createChangePassword(deps: ChangePasswordDeps) {
  return async function changePassword(newPw: string | null): Promise<void> {
    await deps.runExclusive(async () => {
      // Task 25 re-review item #2: `runExclusive` alone kept this from
      // interleaving with a save, but it never checked `store.readOnly` — a
      // read-only tab (lost the cross-tab lock) could still successfully
      // rewrite the file under a new password, the one write path every
      // other trigger (`saveNow`/`doSave`) explicitly guards against. The
      // check has to run *inside* `runExclusive`'s `fn`, not before calling
      // it: the tab could still be read-write when `changePassword` is
      // invoked but lose the lock while waiting out an in-flight save, and
      // `fn` is exactly the window that needs to stay guarded once it
      // actually starts writing.
      if (deps.store.readOnly) throw new Error('read-only')
      const bytes = newPw === null ? serializePlain(deps.store.doc) : await encryptDocument(deps.store.doc, newPw)
      if (deps.session.handle) {
        await writeFile(deps.session, bytes)
      } else {
        downloadFallback(deps.session.name, bytes)
        // Not sticky — see the matching note in src/ui/start.ts.
        toast(t(deps.store.doc.prefs.locale, 'fallback_notice'))
      }
      // Belt-and-braces: `writeBackupNow` is contractually non-throwing, but
      // this is the one call site where an escaped rejection would be
      // actively harmful — the primary file is already written under the new
      // password, so bailing here would leave the in-memory password holding
      // the old one while the user is told the change failed.
      await deps.backupCtl.writeBackupNow(bytes).catch((e: unknown) => console.error(e))
      deps.setPassword(newPw)
      deps.store.markSaved()
      deps.shell.setSaveState('saved')
      deps.shell.setTitle(deps.session.name, false)
    })
  }
}
