// src/core/live-store.ts — one document's slice of the browser live store:
// path-addressed records (doc-records.ts) sealed with the file's own key
// (crypto.ts's recordCodec) on top of the raw IndexedDB layer (live-db.ts).
//
// Row layout. Keys are random 128-bit hex minted when a path is first written
// and remembered in a path→key map built by `load()`, so for an encrypted
// document no key reveals a title, a name or a date. The row value is
//   encrypted:  { s: sealed JSON of { path, value } }   AAD = `<docId>:<key>`
//   plain:      { v: { path, value } }
// The AAD ties a row to its document and key, so rows swapped between keys (or
// documents) fail to open instead of yielding another record's content.
// Image blobs are stored exactly as the file holds them (ImageStore.getStored:
// already sealed under the file key, or raw for a plain file); this module never seals them.
//
// Header-key coupling (the 3.2.0 bug class): the codec handed to
// `createLiveStore` must come from the same `recordCodec` call whose `salt` ends
// up in `meta`, never from a second lookup of the global session-key cache.
import type { RecordCodec } from './crypto'
import { CorruptFileError } from './crypto'
import type { DocRecords } from './doc-records'
import type { LiveDb, LiveMeta } from './live-db'
import { SCHEMA_VERSION } from './document'
import { randomHex } from './file-stamp'

export interface LiveChange {
  puts?: DocRecords
  deletes?: string[]
  putBlobs?: Map<string, Uint8Array>
  deleteBlobs?: string[]
  meta?: Partial<LiveMeta>
  /** Replace the document wholesale: every existing record and blob goes in the same commit. Allowed before `load()`. */
  clear?: boolean
}

export interface LiveStore {
  readonly docId: string
  readonly encrypted: boolean
  meta(): Promise<LiveMeta | undefined>
  /** Reads and opens every record and blob. Rejects with CorruptFileError if any row does not open under this store's codec. Must precede the first `write` to a document that already has rows. */
  load(): Promise<{ records: DocRecords; blobs: Map<string, Uint8Array> }>
  /** One atomic commit. Throws (and changes nothing, in the store or in memory) if the commit fails. */
  write(change: LiveChange): Promise<void>
  /** Re-seals every record under `codec` (null: plain), replaces the blobs with `blobs`, and updates meta, in one commit; only then swaps the codec. A failure leaves the old codec in force. */
  rekey(codec: RecordCodec | null, blobs: Map<string, Uint8Array>): Promise<void>
  /** Points the store at the key the copy is under now (another tab may have re-keyed it) and forgets which rows it knew: the next `load()` rebuilds them. */
  useCodec(codec: RecordCodec | null): void
  /** Deletes the document's meta, records and blobs. */
  remove(): Promise<void>
}

interface Payload { path: string; value: unknown }
type Row = { s: Uint8Array } | { v: Payload }

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

export function createLiveStore(db: LiveDb, docId: string, initialCodec: RecordCodec | null): LiveStore {
  let codec = initialCodec
  let pathToKey = new Map<string, string>()
  // False until load(), remove() or a first write onto an empty document has established what rows exist.
  let indexed = false

  const aad = (key: string) => `${docId}:${key}`

  async function seal(c: RecordCodec | null, key: string, payload: Payload): Promise<Row> {
    return c ? { s: await c.seal(aad(key), enc(JSON.stringify(payload))) } : { v: payload }
  }

  async function open(c: RecordCodec | null, key: string, row: unknown): Promise<Payload> {
    // isView, not instanceof: bytes read back from IndexedDB can come from another realm.
    const r = row as Partial<{ s: Uint8Array; v: Payload }> | null
    let payload: unknown
    if (r && ArrayBuffer.isView(r.s)) {
      if (!c) throw new CorruptFileError()
      try { payload = JSON.parse(dec(await c.open(aad(key), r.s))) } catch { throw new CorruptFileError() }
    } else if (r && r.v && !c) {
      payload = r.v
    } else {
      throw new CorruptFileError()
    }
    if (!payload || typeof (payload as Payload).path !== 'string') throw new CorruptFileError()
    return payload as Payload
  }

  function freshMeta(c: RecordCodec | null): LiveMeta {
    return {
      docId, encrypted: c !== null, salt: c ? c.salt : null, check: null, lastWriteId: null, knownWriteIds: [],
      unwrittenChanges: false, schemaVersion: SCHEMA_VERSION, fileName: '', modifiedAt: Date.now(), lastFileWriteAt: null,
    }
  }

  return {
    docId,
    get encrypted() { return codec !== null },

    meta: () => db.getMeta(docId),

    async load() {
      const all = await db.readAll(docId)
      const records: DocRecords = new Map()
      const index = new Map<string, string>()
      for (const row of all.records) {
        const { path, value } = await open(codec, row.key, row.value)
        records.set(path, value)
        index.set(path, row.key)
      }
      pathToKey = index
      indexed = true
      return { records, blobs: new Map(all.blobs.map((b) => [b.id, b.bytes])) }
    },

    async write(change) {
      const existing = await db.getMeta(docId)
      if (!indexed) {
        if (existing && !change.clear) throw new Error('live store written before it was loaded')
        indexed = true
      }
      // Clearing starts every path over: no row is reused, and the old rows go in the same commit.
      const known = change.clear ? new Map<string, string>() : pathToKey
      const minted = new Map<string, string>()
      const putRecords: { key: string; value: unknown }[] = []
      for (const [path, value] of change.puts ?? []) {
        const key = known.get(path) ?? randomHex(16)
        if (!known.has(path)) minted.set(path, key)
        putRecords.push({ key, value: await seal(codec, key, { path, value }) })
      }
      const removed = change.clear ? [] : (change.deletes ?? []).filter((p) => pathToKey.has(p))
      const deleteRecords = removed.map((p) => pathToKey.get(p)!)
      const needsMeta = existing === undefined || change.meta !== undefined || putRecords.length > 0 || deleteRecords.length > 0
        || (change.putBlobs?.size ?? 0) > 0 || (change.deleteBlobs?.length ?? 0) > 0
      // A wholesale replacement starts the meta over: what the old one says about key, salt and lineage is about the old copy.
      const base = change.clear || !existing ? { ...freshMeta(codec), check: codec ? await codec.makeCheck() : null } : existing
      const meta: LiveMeta | undefined = needsMeta ? { ...base, ...change.meta, docId, modifiedAt: Date.now() } : undefined
      await db.commit(docId, {
        putRecords, deleteRecords,
        putBlobs: [...(change.putBlobs ?? [])].map(([id, bytes]) => ({ id, bytes })),
        deleteBlobs: change.deleteBlobs ?? [],
        meta,
        clear: change.clear,
      })
      // Only after the commit: a failed one must leave every path addressable for the retry.
      if (change.clear) pathToKey = new Map()
      for (const [path, key] of minted) pathToKey.set(path, key)
      for (const p of removed) pathToKey.delete(p)
    },

    async rekey(next, blobs) {
      const all = await db.readAll(docId)
      const index = new Map<string, string>()
      const putRecords: { key: string; value: unknown }[] = []
      for (const row of all.records) {
        const payload = await open(codec, row.key, row.value)
        index.set(payload.path, row.key)
        putRecords.push({ key: row.key, value: await seal(next, row.key, payload) })
      }
      const existing = await db.getMeta(docId)
      const meta: LiveMeta = {
        ...(existing ?? freshMeta(next)),
        encrypted: next !== null, salt: next ? next.salt : null, check: next ? await next.makeCheck() : null,
        modifiedAt: Date.now(),
      }
      await db.commit(docId, {
        putRecords, deleteRecords: [],
        putBlobs: [...blobs].map(([id, bytes]) => ({ id, bytes })),
        deleteBlobs: all.blobs.map((b) => b.id).filter((id) => !blobs.has(id)),
        meta,
      })
      codec = next
      pathToKey = index
      indexed = true
    },

    useCodec(next) {
      codec = next
      pathToKey = new Map()
      indexed = false
    },

    async remove() {
      await db.deleteDoc(docId)
      pathToKey = new Map()
      indexed = true
    },
  }
}
