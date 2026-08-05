// src/core/backup-controller.ts — mirrors the primary save's bytes to a
// second, user-picked file handle for corruption resilience. See
// docs/superpowers/specs/2026-08-04-passwordless-teamfile-design.md.
import type { Store } from './store'
import { idbGet } from './idb'
import { toast } from '../ui/modal'
import { t } from './i18n'

const DAY_MS = 24 * 60 * 60 * 1000

export interface BackupController {
  /** Writes now and resets the elapsed-time clock. Never rejects. No-op if the pref is off or no handle is stored yet. */
  writeBackupNow(bytes: Uint8Array): Promise<void>
  /** Writes only if >=24h have elapsed since the last backup write this session (or none yet). */
  maybeWriteBackup(bytes: Uint8Array): Promise<void>
}

export function createBackupController(deps: { store: Store }): BackupController {
  let cachedHandle: FileSystemFileHandle | null = null
  let lastBackupAt = 0
  let warnedThisSession = false

  async function getHandle(): Promise<FileSystemFileHandle | null> {
    if (!cachedHandle) {
      const id = deps.store.doc.prefs.backupHandleId
      if (!id) return null
      cachedHandle = (await idbGet<FileSystemFileHandle>(id)) ?? null
      if (!cachedHandle) return null
    }
    return cachedHandle
  }

  // Write backup bytes without the side effect of setting 'lastHandle' in IndexedDB.
  // fs.ts's forceWrite() also calls idbSet('lastHandle', handle), which would
  // clobber the primary file's "reopen last" pointer. This helper does the same
  // write, minus that side effect — backup writes must not affect the primary file.
  async function writeBackupBytes(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
    const writable = await handle.createWritable()
    await writable.write(bytes as BufferSource)
    await writable.close()
  }

  /**
   * Never rejects — this is a best-effort mirror, and its callers do
   * load-bearing bookkeeping right after awaiting it (`save-controller`'s
   * `markSaved()`/save-state, `main.ts`'s `app.password = newPw`). An escaping
   * rejection there would leave the app dirty-forever or, worse, desync the
   * in-memory password from the one the file on disk was just written with.
   * Hence the handle lookup lives INSIDE the try too: `idbGet` can reject on
   * its own (IndexedDB blocked/unavailable/private-mode), and that failure is
   * no more fatal than a failed write.
   */
  async function writeBackupNow(bytes: Uint8Array): Promise<void> {
    if (!deps.store.doc.prefs.dailyBackupEnabled) return
    try {
      const handle = await getHandle()
      if (!handle) return
      await writeBackupBytes(handle, bytes)
      lastBackupAt = Date.now()
    } catch (e) {
      console.error(e)
      if (!warnedThisSession) {
        warnedThisSession = true
        toast(t(deps.store.doc.prefs.locale, 'backup_write_failed_toast'), { sticky: false })
      }
    }
  }

  async function maybeWriteBackup(bytes: Uint8Array): Promise<void> {
    if (!deps.store.doc.prefs.dailyBackupEnabled) return
    if (Date.now() - lastBackupAt < DAY_MS) return
    await writeBackupNow(bytes)
  }

  return { writeBackupNow, maybeWriteBackup }
}
