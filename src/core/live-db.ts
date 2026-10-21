// src/core/live-db.ts — the raw IndexedDB layer under the browser live store
// (live-store.ts adds sealing, live-persist.ts adds diffing). A database of its
// own, separate from idb.ts's `team-tracker` key/value store, because it needs
// per-document ranges and multi-store transactions.
//
//   meta    key docId                one LiveMeta per document
//   records key [docId, recordKey]   { docId, key, value }
//   blobs   key [docId, imageId]     { docId, id, bytes }
//
// Everything a document owns is reachable by the range [docId] .. [docId, []]
// (an array sorts after any string key part).

export interface LiveMeta {
  docId: string
  encrypted: boolean
  /** The PBKDF2 salt the records are sealed under (same as the file header's); null for plain documents. */
  salt: Uint8Array | null
  /** Sealed known plaintext, so the password can be tested without opening a record. */
  check: Uint8Array | null
  /** writeId of the last file write or file load this browser knows about. */
  lastWriteId: string | null
  /** The last 20 writeIds this browser produced or loaded, newest first. */
  knownWriteIds: string[]
  /** True while the browser copy has edits the file at `lastWriteId` lacks. */
  unwrittenChanges: boolean
  schemaVersion: number
  fileName: string
  modifiedAt: number
  lastFileWriteAt: number | null
}

export interface LiveBatch {
  putRecords: { key: string; value: unknown }[]
  deleteRecords: string[]
  putBlobs: { id: string; bytes: Uint8Array }[]
  deleteBlobs: string[]
  meta?: LiveMeta
  /** Delete every record and blob of the document first, in the same transaction: the batch then replaces the document wholesale. */
  clear?: boolean
}

export interface LiveDb {
  getMeta(docId: string): Promise<LiveMeta | undefined>
  listMeta(): Promise<LiveMeta[]>
  readAll(docId: string): Promise<{ records: { key: string; value: unknown }[]; blobs: { id: string; bytes: Uint8Array }[] }>
  /** One transaction over all three stores: everything in `batch` lands, or nothing does (a rejection keeps the browser's error name, e.g. QuotaExceededError). */
  commit(docId: string, batch: LiveBatch): Promise<void>
  deleteDoc(docId: string): Promise<void>
  close(): void
}

const DB_VERSION = 1

interface RecordRow { docId: string; key: string; value: unknown }
interface BlobRow { docId: string; id: string; bytes: Uint8Array }

/** Every key whose first part is `docId`. */
const docRange = (docId: string): IDBKeyRange => IDBKeyRange.bound([docId], [docId, []])

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function whenDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export async function openLiveDb(factory: IDBFactory | undefined = globalThis.indexedDB, name = 'team-tracker-live'): Promise<LiveDb> {
  if (!factory) throw new Error('IndexedDB is unavailable')
  const idb: IDBFactory = factory
  // One cached connection, like idb.ts. It must notice when it stops being usable (the browser
  // force-closed it, or another tab wants to upgrade the database) and reopen on the next call.
  let conn: Promise<IDBDatabase> | null = null
  let closed = false

  function connect(): Promise<IDBDatabase> {
    if (closed) return Promise.reject(new Error('live database is closed'))
    if (conn) return conn
    conn = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(name, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'docId' })
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: ['docId', 'key'] })
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: ['docId', 'id'] })
      }
      req.onsuccess = () => {
        const db = req.result
        db.addEventListener('close', () => { conn = null })
        db.addEventListener('versionchange', () => { db.close(); conn = null })
        resolve(db)
      }
      req.onblocked = () => console.error('IndexedDB open is blocked by another tab holding an older connection')
      req.onerror = () => {
        conn = null // a failed open must not poison later calls
        reject(req.error ?? new Error('IndexedDB open request failed'))
      }
    })
    return conn
  }

  await connect()

  async function read<T>(stores: string[], fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await connect()
    const tx = db.transaction(stores, 'readonly')
    return fn(tx)
  }

  return {
    getMeta: (docId) => read(['meta'], (tx) => request<LiveMeta | undefined>(tx.objectStore('meta').get(docId))),
    listMeta: () => read(['meta'], (tx) => request<LiveMeta[]>(tx.objectStore('meta').getAll())),
    readAll: (docId) => read(['records', 'blobs'], async (tx) => {
      const [records, blobs] = await Promise.all([
        request<RecordRow[]>(tx.objectStore('records').getAll(docRange(docId))),
        request<BlobRow[]>(tx.objectStore('blobs').getAll(docRange(docId))),
      ])
      return { records: records.map((r) => ({ key: r.key, value: r.value })), blobs: blobs.map((b) => ({ id: b.id, bytes: b.bytes })) }
    }),
    async commit(docId, batch) {
      const db = await connect()
      const tx = db.transaction(['meta', 'records', 'blobs'], 'readwrite')
      const done = whenDone(tx)
      try {
        const records = tx.objectStore('records'), blobs = tx.objectStore('blobs')
        if (batch.clear) {
          records.delete(docRange(docId))
          blobs.delete(docRange(docId))
        }
        for (const r of batch.putRecords) records.put({ docId, key: r.key, value: r.value } satisfies RecordRow)
        for (const k of batch.deleteRecords) records.delete([docId, k])
        for (const b of batch.putBlobs) blobs.put({ docId, id: b.id, bytes: b.bytes } satisfies BlobRow)
        for (const id of batch.deleteBlobs) blobs.delete([docId, id])
        if (batch.meta) tx.objectStore('meta').put(batch.meta)
      } catch (e) {
        try { tx.abort() } catch { /* already finished */ }
        done.catch(() => {})
        throw e
      }
      await done
    },
    async deleteDoc(docId) {
      const db = await connect()
      const tx = db.transaction(['meta', 'records', 'blobs'], 'readwrite')
      const done = whenDone(tx)
      tx.objectStore('meta').delete(docId)
      tx.objectStore('records').delete(docRange(docId))
      tx.objectStore('blobs').delete(docRange(docId))
      await done
    },
    close() {
      closed = true
      void conn?.then((db) => db.close(), () => {})
      conn = null
    },
  }
}

let shared: Promise<LiveDb | null> | null = null

/**
 * The app's one connection, opened on first use. Null when the browser cannot open IndexedDB (private mode,
 * blocked storage): the document then runs from memory and the file alone. A failure is not remembered, so the
 * next document opened tries again.
 */
export function sharedLiveDb(): Promise<LiveDb | null> {
  shared ??= openLiveDb().catch((e: unknown) => {
    console.error(e)
    shared = null
    return null
  })
  return shared
}

/** Test seam: forgets the shared connection (closing it) so the next call opens afresh. */
export function resetSharedLiveDb(): void {
  const old = shared
  shared = null
  void old?.then((db) => db?.close())
}
