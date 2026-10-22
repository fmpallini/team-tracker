// src/core/live-store.ts — one document's slice of the browser live store:
// path-addressed records (doc-records.ts) sealed with the file's own key
// (crypto.ts's recordCodec) on top of the raw IndexedDB layer (live-db.ts).
//
// Row layout. A row's key is derived from its path: HMAC-SHA256 of the path under a
// per-document random secret (`LiveMeta.keySecret`, sealed under the document's key when it is
// encrypted), cut to 128 bits. The same path always lands on the same row, so a write needs no
// map of what exists (and no read of the stored rows), while no key reveals a title, a name or
// a date to anyone without the secret. The row value is
//   encrypted:  { s: sealed JSON text of { path, value } }   AAD = `<docId>:<key>`
//   plain:      { t: that JSON text }
// A record arrives as the JSON text of its value (the persister has serialized it to diff it) and is
// spliced into the row's text as it is, never parsed and stringified again.
// The AAD ties a row to its document and key, so rows swapped between keys (or
// documents) fail to open instead of yielding another record's content.
// A password change keeps the secret (only its sealing changes), so every row keeps its key
// and `rekey` just re-seals them in place.
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

export interface LiveChange {
  /** path → the JSON text of the record's value. */
  puts?: ReadonlyMap<string, string>
  deletes?: string[]
  putBlobs?: Map<string, Uint8Array>
  deleteBlobs?: string[]
  meta?: Partial<LiveMeta>
  /** Replace the document wholesale: every existing record and blob goes in the same commit, under a fresh meta (and key secret). */
  clear?: boolean
}

export interface LiveStore {
  readonly docId: string
  readonly encrypted: boolean
  meta(): Promise<LiveMeta | undefined>
  /** Reads and opens every record and blob. Rejects with CorruptFileError if the copy's key secret or any row does not open under this store's codec. */
  load(): Promise<{ records: DocRecords; blobs: Map<string, Uint8Array> }>
  /**
   * What the document holds, without reading a value: the number of records and the ids of its blobs. Rejects with
   * CorruptFileError when the copy cannot be written under this store's codec (no key secret, or one that does not open).
   */
  stat(): Promise<{ records: number; blobIds: string[] }>
  /** One atomic commit. Throws (and changes nothing, in the store or in memory) if the commit fails. */
  write(change: LiveChange): Promise<void>
  /** Re-seals every record under `codec` (null: plain), replaces the blobs with `blobs`, and updates meta, in one commit; only then swaps the codec. A failure leaves the old codec in force. */
  rekey(codec: RecordCodec | null, blobs: Map<string, Uint8Array>): Promise<void>
  /** Points the store at the key the copy is under now (another tab may have re-keyed it) and drops what it remembered of the copy's meta. */
  useCodec(codec: RecordCodec | null): void
  /** Deletes the document's meta, records and blobs. */
  remove(): Promise<void>
}

interface Payload { path: string; value: unknown }
type Row = { s: Uint8Array } | { t: string }

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

export function createLiveStore(db: LiveDb, docId: string, initialCodec: RecordCodec | null): LiveStore {
  let codec = initialCodec
  // The meta as this store last saw it (null: not read yet; undefined: there is none). Only the tab holding the write
  // lock writes, and a takeover goes through `useCodec` (live-follow.ts), so a flush need not read it again.
  let metaCache: LiveMeta | undefined | null = null
  // The row-key HMAC key, with the sealed secret it was opened from: a meta that carries other bytes means another key.
  let keyed: { sealed: Uint8Array; hmac: CryptoKey } | null = null

  const aad = (key: string) => `${docId}:${key}`
  const secretAad = `${docId}:key-secret`

  async function seal(c: RecordCodec | null, key: string, text: string): Promise<Row> {
    return c ? { s: await c.seal(aad(key), enc(text)) } : { t: text }
  }

  async function open(c: RecordCodec | null, key: string, row: unknown): Promise<Payload> {
    // isView, not instanceof: bytes read back from IndexedDB can come from another realm.
    const r = row as Partial<{ s: Uint8Array; t: string }> | null
    let payload: unknown
    try {
      if (r && ArrayBuffer.isView(r.s)) {
        if (!c) throw new CorruptFileError()
        payload = JSON.parse(dec(await c.open(aad(key), r.s)))
      } else if (r && typeof r.t === 'string' && !c) {
        payload = JSON.parse(r.t)
      } else {
        throw new CorruptFileError()
      }
    } catch { throw new CorruptFileError() }
    if (!payload || typeof (payload as Payload).path !== 'string') throw new CorruptFileError()
    return payload as Payload
  }

  const sealSecret = (c: RecordCodec | null, secret: Uint8Array): Promise<Uint8Array> => (c ? c.seal(secretAad, secret) : Promise.resolve(secret))

  /** The secret in `m`, opened under `c`. A copy without one (written by an earlier build) or whose one does not open is unusable. */
  async function openSecret(c: RecordCodec | null, m: LiveMeta): Promise<Uint8Array> {
    const sealed = m.keySecret as Uint8Array | undefined
    if (!sealed || !ArrayBuffer.isView(sealed)) throw new CorruptFileError()
    if (!c) {
      if (m.encrypted) throw new CorruptFileError()
      return sealed
    }
    try { return await c.open(secretAad, sealed) } catch { throw new CorruptFileError() }
  }

  async function keyer(m: LiveMeta): Promise<CryptoKey> {
    if (keyed && m.keySecret && sameBytes(keyed.sealed, m.keySecret)) return keyed.hmac
    const hmac = await crypto.subtle.importKey('raw', (await openSecret(codec, m)).slice(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    keyed = { sealed: m.keySecret, hmac }
    return hmac
  }

  const rowKey = async (hmac: CryptoKey, path: string): Promise<string> =>
    hex(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, enc(path))).subarray(0, 16))

  async function freshMeta(c: RecordCodec | null): Promise<LiveMeta> {
    return {
      docId, encrypted: c !== null, salt: c ? c.salt : null, check: c ? await c.makeCheck() : null,
      keySecret: await sealSecret(c, crypto.getRandomValues(new Uint8Array(16))),
      lastWriteId: null, knownWriteIds: [],
      unwrittenChanges: false, schemaVersion: SCHEMA_VERSION, fileName: '', modifiedAt: Date.now(), lastFileWriteAt: null,
    }
  }

  async function currentMeta(): Promise<LiveMeta | undefined> {
    if (metaCache === null) metaCache = await db.getMeta(docId)
    return metaCache
  }

  return {
    docId,
    get encrypted() { return codec !== null },

    async meta() {
      metaCache = await db.getMeta(docId)
      return metaCache
    },

    async load() {
      const meta = await db.getMeta(docId)
      if (meta) await keyer(meta)
      const all = await db.readAll(docId)
      const records: DocRecords = new Map()
      for (const row of all.records) {
        const { path, value } = await open(codec, row.key, row.value)
        records.set(path, value)
      }
      return { records, blobs: new Map(all.blobs.map((b) => [b.id, b.bytes])) }
    },

    async stat() {
      const meta = await currentMeta()
      if (!meta) return { records: 0, blobIds: [] }
      await keyer(meta)
      return db.stat(docId)
    },

    async write(change) {
      const existing = await currentMeta()
      // Clearing starts the document over: a fresh meta, with a fresh secret, replaces whatever the old one said.
      const base = change.clear || !existing ? await freshMeta(codec) : existing
      const hmac = await keyer(base)
      const putRecords: { key: string; value: unknown }[] = []
      for (const [path, json] of change.puts ?? []) {
        const key = await rowKey(hmac, path)
        putRecords.push({ key, value: await seal(codec, key, `{"path":${JSON.stringify(path)},"value":${json}}`) })
      }
      const deleteRecords = change.clear ? [] : await Promise.all((change.deletes ?? []).map((p) => rowKey(hmac, p)))
      const needsMeta = existing === undefined || change.meta !== undefined || putRecords.length > 0 || deleteRecords.length > 0
        || (change.putBlobs?.size ?? 0) > 0 || (change.deleteBlobs?.length ?? 0) > 0
      const meta: LiveMeta | undefined = needsMeta ? { ...base, ...change.meta, docId, modifiedAt: Date.now() } : undefined
      await db.commit(docId, {
        putRecords, deleteRecords,
        putBlobs: [...(change.putBlobs ?? [])].map(([id, bytes]) => ({ id, bytes })),
        deleteBlobs: change.deleteBlobs ?? [],
        meta,
        clear: change.clear,
      })
      // Only after the commit: a failed one must leave what this store believes about the copy as it was.
      if (meta) metaCache = meta
    },

    async rekey(next, blobs) {
      const all = await db.readAll(docId)
      const existing = await db.getMeta(docId)
      const secret = existing ? await openSecret(codec, existing) : crypto.getRandomValues(new Uint8Array(16))
      // The secret stays, so every row keeps its key and is re-sealed in place.
      const putRecords: { key: string; value: unknown }[] = []
      for (const row of all.records) {
        const payload = await open(codec, row.key, row.value)
        putRecords.push({ key: row.key, value: await seal(next, row.key, JSON.stringify(payload)) })
      }
      const meta: LiveMeta = {
        ...(existing ?? await freshMeta(next)),
        encrypted: next !== null, salt: next ? next.salt : null, check: next ? await next.makeCheck() : null,
        keySecret: await sealSecret(next, secret),
        modifiedAt: Date.now(),
      }
      await db.commit(docId, {
        putRecords, deleteRecords: [],
        putBlobs: [...blobs].map(([id, bytes]) => ({ id, bytes })),
        deleteBlobs: all.blobs.map((b) => b.id).filter((id) => !blobs.has(id)),
        meta,
      })
      codec = next
      metaCache = meta
      keyed = null
    },

    useCodec(next) {
      codec = next
      metaCache = null
      keyed = null
    },

    async remove() {
      await db.deleteDoc(docId)
      metaCache = null
      keyed = null
    },
  }
}
