import { idbGet, idbSet } from './idb'

export interface FileSession {
  handle: FileSystemFileHandle | null // null in fallback mode
  name: string
  lastModified: number // updated after each read/write
}

export const supportsFsApi: boolean = typeof window !== 'undefined' && 'showOpenFilePicker' in window

export class ExternalChangeError extends Error {}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

async function readHandle(handle: FileSystemFileHandle): Promise<{ bytes: Uint8Array; lastModified: number }> {
  const file = await handle.getFile()
  const buf = await file.arrayBuffer()
  return { bytes: new Uint8Array(buf), lastModified: file.lastModified }
}

export async function pickOpen(): Promise<{ session: FileSession; bytes: Uint8Array } | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      // Chromium expands a registered MIME type like application/octet-stream
      // into every OS-associated extension for that type, so the picker's
      // filter ends up listing far more than .tmv. An unregistered app-
      // specific MIME type has no OS associations to merge in, keeping the
      // filter to just the extension below.
      types: [{ description: 'Team Tracker', accept: { 'application/vnd.teamtracker.tmv': ['.tmv'] } }],
    })
    if (!handle) return null
    const { bytes, lastModified } = await readHandle(handle)
    const session: FileSession = { handle, name: handle.name, lastModified }
    await idbSet('lastHandle', handle)
    return { session, bytes }
  } catch (e) {
    if (isAbortError(e)) return null
    throw e
  }
}

export async function pickCreate(suggestedName: string): Promise<FileSession | null> {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      // Unregistered MIME type keeps the filter to .tmv — see pickOpen above.
      types: [{ description: 'Team Tracker', accept: { 'application/vnd.teamtracker.tmv': ['.tmv'] } }],
    })
    const { lastModified } = await readHandle(handle)
    const session: FileSession = { handle, name: handle.name, lastModified }
    await idbSet('lastHandle', handle)
    return session
  } catch (e) {
    if (isAbortError(e)) return null
    throw e
  }
}

/**
 * Save-picker for the daily `.bck` mirror file. Deliberately NOT `pickCreate`:
 *  - it must not touch the `'lastHandle'` IndexedDB key, which is the primary
 *    file's "reopen last" pointer — pointing it at a freshly created, empty
 *    `.bck` would make the next launch try to open a 0-byte file and report a
 *    bogus "corrupt file" error instead of opening the user's real `.tmv`
 *    (same class of bug the `forceWrite`/`writeBackupBytes` split already
 *    fixed on the write side, see `core/backup-controller.ts`);
 *  - the picker filter is `.bck`, not `.tmv`.
 * Unregistered MIME type keeps the filter to .bck — see `pickOpen` above.
 *
 * `startIn`, when given the primary file's handle, opens the picker in that
 * file's folder by default — the user can still navigate elsewhere, so this
 * is a starting point, not a guarantee (see `prefs_backup_hint`'s wording).
 */
export async function pickCreateBackup(suggestedName: string, startIn?: FileSystemHandle): Promise<FileSession | null> {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Team Tracker Backup', accept: { 'application/vnd.teamtracker.bck': ['.bck'] } }],
      startIn,
    })
    const { lastModified } = await readHandle(handle)
    return { handle, name: handle.name, lastModified }
  } catch (e) {
    if (isAbortError(e)) return null
    throw e
  }
}

/**
 * Shared by `reopenLast` (handle pulled from IndexedDB) and the File Handling
 * API launch path (handle handed in by the OS/browser on `.tmv` double-click,
 * see `pwa/manifest.json`'s `file_handlers` and `ui/start.ts`'s
 * `window.launchQueue` consumer) — both need the same permission re-check
 * before reading, since a handle persisted or received across a launch
 * doesn't carry its earlier grant with it.
 */
export async function openFromHandle(
  handle: FileSystemFileHandle,
  persist = true
): Promise<{ session: FileSession; bytes: Uint8Array } | null> {
  let permission = await handle.queryPermission({ mode: 'readwrite' })
  if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'readwrite' })
  if (permission !== 'granted') return null
  const { bytes, lastModified } = await readHandle(handle)
  const session: FileSession = { handle, name: handle.name, lastModified }
  // `reopenLast` passes persist:false — the handle it hands in came from this
  // same IndexedDB entry, so writing it straight back is a no-op round trip.
  if (persist) await idbSet('lastHandle', handle)
  return { session, bytes }
}

export async function reopenLast(): Promise<{ session: FileSession; bytes: Uint8Array } | null> {
  const handle = await idbGet<FileSystemFileHandle>('lastHandle')
  if (!handle) return null
  return openFromHandle(handle, false)
}

/**
 * Compares two sessions by their underlying file-system entry (not
 * name/path, so it stays correct across renames) — e.g. so a File Handling
 * API launch (see `ui/start.ts`) can detect it's re-launching the file
 * that's already open rather than reopening it from disk over unsaved
 * in-memory edits. `false` in fallback mode, where sessions have no handle.
 */
export async function sameEntry(a: FileSession, b: FileSession): Promise<boolean> {
  if (!a.handle || !b.handle) return false
  return a.handle.isSameEntry(b.handle)
}

export async function writeFile(session: FileSession, bytes: Uint8Array): Promise<void> {
  const { handle } = session
  if (!handle) throw new Error('writeFile requires a file handle (fallback mode has no handle)')
  const current = await handle.getFile()
  if (current.lastModified !== session.lastModified) throw new ExternalChangeError()
  const writable = await handle.createWritable()
  await writable.write(bytes as BufferSource)
  await writable.close()
  const after = await handle.getFile()
  session.lastModified = after.lastModified
  await idbSet('lastHandle', handle)
}

export async function forceWrite(session: FileSession, bytes: Uint8Array): Promise<void> {
  const { handle } = session
  if (!handle) throw new Error('forceWrite requires a file handle (fallback mode has no handle)')
  const writable = await handle.createWritable()
  await writable.write(bytes as BufferSource)
  await writable.close()
  const after = await handle.getFile()
  session.lastModified = after.lastModified
  await idbSet('lastHandle', handle)
}

export async function readCurrent(session: FileSession): Promise<Uint8Array> {
  const { handle } = session
  if (!handle) throw new Error('readCurrent requires a file handle (fallback mode has no handle)')
  const { bytes, lastModified } = await readHandle(handle)
  session.lastModified = lastModified
  return bytes
}

/**
 * One-shot save for the team export/import feature — unlike `pickCreate`,
 * there's no ongoing `FileSession` to hand back (the export file is written
 * once and never reopened by this app), so this skips the handle-tracking
 * machinery entirely. Returns false on user cancel (caller should just do
 * nothing, not fall back to `downloadFallback` — that would defeat Cancel).
 */
export async function pickSaveJson(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    })
    const writable = await handle.createWritable()
    await writable.write(bytes as BufferSource)
    await writable.close()
    return true
  } catch (e) {
    if (isAbortError(e)) return false
    throw e
  }
}

export function downloadFallback(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
