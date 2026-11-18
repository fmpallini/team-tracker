// Minimal IndexedDB helper — no libs. Single object store 'kv' used as a key/value map.
import { stall } from './stall'

const DB_NAME = 'team-tracker'
const DB_VERSION = 1
const STORE_NAME = 'kv'

// Cached across calls — opening a fresh connection (and closing it) on every
// get/set/del was a full IndexedDB handshake per call for no benefit; a
// single connection lives for the page's lifetime instead.
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  // A wedged backend never answers the open (core/stall.ts). The deadline rejects instead, and the cache entry is
  // dropped like on any failed open so the next call tries afresh; a connection that turns up late is closed unused.
  const opening = stall(new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => {
      const db = req.result
      // The connection is cached for the page's lifetime, so it must notice when
      // it stops being usable — otherwise every later call throws
      // InvalidStateError until the tab is reloaded:
      //  - `close`: the browser force-closed it (storage pressure, "clear site data").
      //  - `versionchange`: another tab (a newer build of this app) wants to
      //    upgrade the database; staying open would block it, and with it that
      //    tab's file open/save, forever.
      db.addEventListener('close', () => { dbPromise = null })
      db.addEventListener('versionchange', () => { db.close(); dbPromise = null })
      resolve(db)
    }
    req.onblocked = () => console.error('IndexedDB open is blocked by another tab holding an older connection')
    req.onerror = () => {
      dbPromise = null // a failed open must not poison future calls with a rejected cache entry
      reject(req.error ?? new Error('IndexedDB open request failed'))
    }
  }), 'IndexedDB open (team-tracker)', { onLate: (db) => db.close() })
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null
  })
  dbPromise = opening
  return opening
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  // Values here are small (a file handle, a flag, the file-id registry), so a request this slow is a wedged store,
  // or a transaction queued behind one, not a slow one.
  return stall(new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const req = fn(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  }), `IndexedDB ${mode} (team-tracker)`)
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await withStore('readwrite', (store) => store.put(value, key))
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const result = await withStore<T | undefined>('readonly', (store) => store.get(key))
  return result
}

export async function idbDel(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key))
}
