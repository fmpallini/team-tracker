// Minimal IndexedDB helper — no libs. Single object store 'kv' used as a key/value map.

const DB_NAME = 'team-tracker'
const DB_VERSION = 1
const STORE_NAME = 'kv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      const req = fn(store)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
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
