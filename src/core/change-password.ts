// src/core/change-password.ts — Task 24/25: re-encrypts (or plain-serializes)
// the current in-memory document under a new password and persists it via the
// same writeFile/downloadFallback split used by the create flow in
// src/ui/start.ts. Extracted out of main.ts so this concurrency-sensitive
// path (Task 25 fix #3, re-review item #2) can be unit tested directly
// instead of only through prefs.ts's mocked PrefsAppCtl.
import type { Store } from './store'
import type { FileSession } from './fs'
import { buildSnapshot, commitSnapshot, type Snapshot } from './snapshot'
import type { LivePersister } from './live-persist'
import type { FileSnapshot } from './file-snapshot'
import { blobCodec, recordCodec } from './crypto'
import { writeFile, downloadFallback } from './fs'
import { toast } from '../ui/modal'
import { t } from './i18n'
import type { Shell } from '../ui/shell'

export interface ChangePasswordDeps {
  store: Store
  session: FileSession
  shell: Shell
  /** Told which file write landed (null: browser storage unavailable). */
  persister?: LivePersister | null
  /** The browser copy could not be re-sealed under the new password (it stays consistently under the old one). */
  onBrowserCopyRekeyFailed?: () => void
  /** The file writer, told the write landed so the pill shows it. */
  snapshot?: Pick<FileSnapshot, 'fileWritten'>
  /** Waits out (and blocks) any concurrent file write — see file-snapshot.ts's `runExclusive`. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  /** The password the file is under right now (live read), needed to restore the image blobs' key if the write fails. */
  getPassword(): string | null
  /** Flips the in-memory password held by main.ts's app closure. No-ops there if the app has since been torn down. */
  setPassword(newPw: string | null): void
}

/**
 * `currentPassword`/`fileSchemaVersion` are read live from the caller's own
 * state (not closed over here), so this function only ever needs the new
 * password and the deps above.
 *
 * It isn't one of the file's regular write moments, so it doesn't go through
 * the snapshot's `writeNow()` — but it does run inside `runExclusive()` so it
 * can't interleave with one, and does the same post-write bookkeeping —
 * `commitSnapshot`, `markSaved()` so the just-written state isn't treated as
 * still ahead of the file, plus the save indicator/title — since the disk
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
      // The image blobs are sealed under the file's key, so they have to move
      // to the new one before the bytes are built: `rekey` opens each image
      // with the OLD codec first, then forgets its sealed form so the write
      // re-seals it. A failed write puts the old key back (a fresh codec for
      // the old password: the session key cache may already hold the new
      // one, and the next save's header must match the key the blobs use).
      const images = deps.store.images
      const oldPw = deps.getPassword()
      // The browser copy first: every pending edit is in it under the old key before the key changes.
      await deps.persister?.flush()
      await images.rekey(newPw === null ? null : await blobCodec(newPw))
      let snapshot: Snapshot
      try {
        snapshot = await buildSnapshot(deps.store, newPw)
        if (deps.session.handle) {
          await writeFile(deps.session, snapshot.bytes)
        } else {
          downloadFallback(deps.session.name, snapshot.bytes)
          // Not sticky — see the matching note in src/ui/start.ts.
          toast(t(deps.store.doc.prefs.locale, 'fallback_notice'), { kind: 'warn' })
        }
      } catch (e) {
        await images.rekey(oldPw === null ? null : await blobCodec(oldPw))
        throw e
      }
      await commitSnapshot(deps.persister ?? null, snapshot.stamp, snapshot.revAtSnapshot)
      // The browser copy follows the file to the new key, in one commit. Same key as the file header and the image
      // blobs (the salt comes from the image store's own codec, not a second lookup of the session-key cache).
      // If this fails the file write stands (rolling it back would put the file's key back for nothing) and the copy
      // stays under the old key, consistently: the next open finds the lineage, cannot unlock it with the new password,
      // and asks for the old one (core/live-open.ts).
      if (deps.persister) {
        try {
          await deps.persister.rekey(newPw === null ? null : await recordCodec(newPw, images.codec()?.header?.salt))
        } catch (e) {
          console.error(e)
          deps.onBrowserCopyRekeyFailed?.()
        }
      }
      deps.setPassword(newPw)
      if (deps.store.rev === snapshot.revAtSnapshot) deps.store.markSaved()
      deps.snapshot?.fileWritten()
      deps.shell.setTitle(deps.session.name)
    })
  }
}
