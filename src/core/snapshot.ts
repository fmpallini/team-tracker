// src/core/snapshot.ts — one file write, in two halves. `buildSnapshot` turns the
// live document into `.tmv` bytes under a fresh write stamp; once the caller has
// put those bytes on disk, `commitSnapshot` tells the browser store which write
// that was, so the next open can tell this file from an older or foreign one
// (live-open.ts). Every writer (the save cycle, a password change, the conflict
// overwrite, creating a file) goes through here so none forgets the second half.
//
// `contentFingerprint` is what lets a write be skipped: two documents with the
// same fingerprint make files with the same content (bar the stamp and key
// order), because the file is the document's JSON plus image bytes whose ids are
// their own content hash. `nav` (where the user is looking) is left out on purpose: moving
// around is not a change worth a file write. The browser copy carries it instead
// (live-open.ts takes the copy's nav when it opens an unchanged file).
import type { Store } from './store'
import type { Doc } from './types'
import type { LivePersister } from './live-persist'
import { newStamp, type FileStamp } from './file-stamp'
import { docToBytes } from './doc-bytes'

export interface Snapshot {
  bytes: Uint8Array
  stamp: FileStamp
  /** `store.rev` when serialization began: an edit after it is not in `bytes`, so only a matching rev may clear `dirty`. */
  revAtSnapshot: number
  /** `contentFingerprint` of what `bytes` hold; null when an edit landed during serialization, so that is not known. */
  fingerprint: string | null
}

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

/** Objects with their keys sorted: a document rebuilt from the browser copy's records (doc-records.ts) orders them differently. */
function sortedKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * SHA-256 of the document's JSON without `nav`, keys sorted. The JSON is taken synchronously, at the call: an edit
 * made while the hash is computed is not in it.
 */
export function contentFingerprint(doc: Doc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ ...doc, nav: undefined }, sortedKeys))
  return crypto.subtle.digest('SHA-256', json).then(hex)
}

export async function buildSnapshot(store: Store, password: string | null): Promise<Snapshot> {
  // Captured before docToBytes awaits anything: an edit that lands during serialization is not in the bytes.
  const revAtSnapshot = store.rev
  const contentRev = store.contentRev
  const fingerprint = contentFingerprint(store.doc)
  const stamp = newStamp()
  const bytes = await docToBytes(store.doc, password, store.images, stamp)
  // An edit during serialization may or may not be in the bytes: then what they hold is unknown, never assumed.
  return { bytes, stamp, revAtSnapshot, fingerprint: store.contentRev === contentRev ? await fingerprint : null }
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
