// src/core/snapshot.ts — one file write, in two halves. `buildSnapshot` turns the
// live document into `.tmv` bytes under a fresh write stamp; once the caller has
// put those bytes on disk, `commitSnapshot` tells the browser store which write
// that was, so the next open can tell this file from an older or foreign one
// (live-open.ts). Every writer (the save cycle, a password change, the conflict
// overwrite, creating a file) goes through here so none forgets the second half.
import type { Store } from './store'
import type { LivePersister } from './live-persist'
import { newStamp, type FileStamp } from './file-stamp'
import { docToBytes } from './doc-bytes'

export interface Snapshot {
  bytes: Uint8Array
  stamp: FileStamp
  /** `store.rev` when serialization began: an edit after it is not in `bytes`, so only a matching rev may clear `dirty`. */
  revAtSnapshot: number
}

export async function buildSnapshot(store: Store, password: string | null): Promise<Snapshot> {
  // Captured before docToBytes awaits anything: an edit that lands during serialization is not in the bytes.
  const revAtSnapshot = store.rev
  const stamp = newStamp()
  const bytes = await docToBytes(store.doc, password, store.images, stamp)
  return { bytes, stamp, revAtSnapshot }
}

/**
 * Never throws: by the time this runs the file is already written, so a failure of the browser store here must
 * not be reported as a failed save. The persister keeps the stamp and applies it with its next successful commit.
 */
export async function commitSnapshot(persister: LivePersister | null, stamp: FileStamp, revAtSnapshot: number): Promise<void> {
  if (!persister) return
  try {
    await persister.markFileWritten(stamp, revAtSnapshot)
  } catch (e) {
    console.error(e)
  }
}
