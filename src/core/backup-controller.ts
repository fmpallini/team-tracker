// src/core/backup-controller.ts — mirrors the primary save's bytes to a
// second, user-picked file handle for corruption resilience. See
// docs/superpowers/specs/2026-08-04-passwordless-teamfile-design.md.
import type { Store } from './store'
import { idbGet } from './idb'
import { toast } from '../ui/modal'
import { t } from './i18n'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface BackupController {
  /** Writes now and resets the elapsed-time clock. Never rejects. No-op if the pref is off, no handle is stored yet, or the stored handle's write permission has lapsed. */
  writeBackupNow(bytes: Uint8Array): Promise<void>
  /** Writes only if the interval implied by `prefs.backupFrequency` ('daily' => 24h, 'hourly' => 1h) has elapsed since the last backup write — seeded from the .bck file's own on-disk lastModified on the first check each session, so the gate survives a reopen instead of always writing on the next save. */
  maybeWriteBackup(bytes: Uint8Array): Promise<void>
  /**
   * Re-requests write permission on the backup handle, if one is configured
   * and its grant has lapsed. Meant to be chained directly off a click that
   * already re-granted the *primary* file's permission (save-controller.ts's
   * "Grant access…" toast action) — the primary and backup files are separate
   * paths with independent grants, so fixing one never fixes the other on its
   * own. Calling this immediately after, with no intervening `await` on
   * anything else, keeps it inside the same user-activation window so the
   * browser's native prompt (if the backup grant actually needs re-asking)
   * doesn't require a second physical gesture. No-op, never throws, if
   * there's no backup configured or the grant is already fine.
   */
  regrantPermission(): Promise<void>
  /**
   * True only when a backup is configured (a handle id is set) and its
   * grant is not currently 'granted'. Read-only — never prompts, never
   * writes. Backup writes are interval-gated (daily/hourly), so unlike the
   * primary file a lapsed backup grant can otherwise go undetected for up
   * to a day; save-controller.ts calls this after every successful primary
   * save (cheap — a single `queryPermission`) so the save-state pill can
   * reflect it immediately instead of waiting for the next backup attempt.
   */
  hasMissingGrant(): Promise<boolean>
  /**
   * True only when a backup is configured (a handle id is set) but that id
   * has no matching entry in this machine's IndexedDB — the file was moved
   * to a different computer (or browser profile) than the one that picked
   * the backup target, so the id travelled in the .tmv but the handle it
   * names never did. Distinct from `hasMissingGrant()`: that's a handle
   * that still exists but needs re-permissioning; this is no handle at all.
   * Read-only — never prompts, never writes. A failed IDB lookup itself
   * (already `writeBackupNow()`'s own failure mode) is reported `false`
   * here, not orphaned — it isn't proof the reference is gone.
   */
  checkOrphaned(): Promise<boolean>
}

export function createBackupController(deps: { store: Store }): BackupController {
  let cachedHandle: FileSystemFileHandle | null = null
  let lastBackupAt = 0
  let lastBackupAtInitialized = false
  let warnedThisSession = false

  async function loadHandle(): Promise<FileSystemFileHandle | null> {
    if (!cachedHandle) {
      const id = deps.store.doc.prefs.backupHandleId
      if (!id) return null
      cachedHandle = (await idbGet<FileSystemFileHandle>(id)) ?? null
      // Seeds the elapsed-time clock from the .bck file's own on-disk
      // lastModified, once per session, so `maybeWriteBackup`'s interval
      // gate survives a reopen instead of resetting to "never" every launch
      // (which would write a fresh backup on the very next save regardless
      // of how recently the real one on disk was written). Guarded by
      // `size > 0`: `pickCreateBackup` (fs.ts) creates the file the moment
      // it's picked, before any real content is ever written — reading that
      // brand-new empty file's creation timestamp as "just backed up" would
      // make the actual first write skip for up to a full interval, leaving
      // an empty .bck behind. Only checked on this first resolution — a
      // write later in the same session already advances `lastBackupAt`
      // itself (see writeBackupNow), so nothing here should override that.
      if (cachedHandle && !lastBackupAtInitialized) {
        lastBackupAtInitialized = true
        try {
          const file = await cachedHandle.getFile()
          if (file.size > 0) lastBackupAt = file.lastModified
        } catch (e) {
          console.error(e)
        }
      }
    }
    return cachedHandle
  }

  /**
   * Returns the backup handle only if it's actually writable right now, else
   * null (caller no-ops). A handle restored from IndexedDB does NOT carry its
   * earlier read-write grant across browser sessions — `fs.ts`'s
   * `openFromHandle` re-checks for exactly this reason. Without the check the
   * first backup write of every new session would blow up inside
   * `createWritable()` with an opaque `NotAllowedError`; with it, a lapsed
   * grant degrades to a clean, diagnosable no-op.
   *
   * Deliberately `queryPermission` only, no `requestPermission`: backup writes
   * ride along with (auto-)saves, which have no transient user activation, so
   * a re-request would be denied anyway — see `regrantPermission()` for the
   * one path that does have activation to spend.
   */
  async function getHandle(): Promise<FileSystemFileHandle | null> {
    const handle = await loadHandle()
    if (!handle) return null
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return null
    return handle
  }

  async function regrantPermission(): Promise<void> {
    // Consistent with hasMissingGrant()/writeBackupNow(): a disabled backup
    // must stay silent, not fire its own native permission prompt off the
    // back of the primary file's "Grant access…" click for a feature the
    // user has turned off.
    if (!deps.store.doc.prefs.dailyBackupEnabled) return
    const handle = await loadHandle()
    if (!handle) return
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return
    try {
      const permission = await handle.requestPermission({ mode: 'readwrite' })
      if (permission === 'granted') warnedThisSession = false
    } catch (e) {
      console.error(e)
    }
  }

  async function hasMissingGrant(): Promise<boolean> {
    if (!deps.store.doc.prefs.dailyBackupEnabled) return false
    const handle = await loadHandle()
    if (!handle) return false
    return (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted'
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
    // Ensures the disk-seeded `lastBackupAt` (see loadHandle's own comment)
    // is in place before the gate below reads it — this is the *first*
    // touch of the handle on a fresh session for the common case (an
    // auto-save arriving before any explicit write), so without this the
    // gate would still compare against the stale in-memory default of 0.
    // Cheap on every later call: loadHandle() short-circuits on the cached
    // handle and never re-reads the disk timestamp once seeded. Failures are
    // swallowed here (best-effort seed only, falls through to the default
    // "write now" gate) — writeBackupNow below retries the same lookup and
    // is where a real failure gets logged/toasted, not this pre-fetch.
    try {
      await loadHandle()
    } catch {
      /* best-effort seed only — see comment above */
    }
    const intervalMs = deps.store.doc.prefs.backupFrequency === 'hourly' ? HOUR_MS : DAY_MS
    if (Date.now() - lastBackupAt < intervalMs) return
    await writeBackupNow(bytes)
  }

  async function checkOrphaned(): Promise<boolean> {
    if (!deps.store.doc.prefs.dailyBackupEnabled) return false
    if (!deps.store.doc.prefs.backupHandleId) return false
    try {
      return (await loadHandle()) === null
    } catch (e) {
      console.error(e)
      return false
    }
  }

  return { writeBackupNow, maybeWriteBackup, regrantPermission, hasMissingGrant, checkOrphaned }
}
