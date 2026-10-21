import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, sharedLiveDb, resetSharedLiveDb, type LiveDb, type LiveMeta } from '../src/core/live-db'

// A fresh in-memory IndexedDB per test (jsdom has none of its own).
let factory: IDBFactory
beforeEach(() => {
  factory = new IDBFactory()
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => { vi.unstubAllGlobals() })

const meta = (docId: string, over: Partial<LiveMeta> = {}): LiveMeta => ({
  docId, encrypted: false, salt: null, check: null, lastWriteId: null, knownWriteIds: [],
  unwrittenChanges: false, schemaVersion: 18, fileName: 'a.tmv', modifiedAt: 1, lastFileWriteAt: null, ...over,
})
const empty = { putRecords: [], deleteRecords: [], putBlobs: [], deleteBlobs: [] }

test('meta round-trips per document and listMeta returns all of them', async () => {
  const db = await openLiveDb(factory)
  expect(await db.getMeta('d1')).toBeUndefined()
  await db.commit('d1', { ...empty, meta: meta('d1', { fileName: 'one.tmv' }) })
  await db.commit('d2', { ...empty, meta: meta('d2') })
  expect((await db.getMeta('d1'))!.fileName).toBe('one.tmv')
  expect((await db.listMeta()).map((m) => m.docId).sort()).toEqual(['d1', 'd2'])
})

test('Uint8Array fields come back as Uint8Array with the same bytes', async () => {
  const db = await openLiveDb(factory)
  await db.commit('d1', {
    putRecords: [{ key: 'k', value: { s: new Uint8Array([1, 2, 3]) } }], deleteRecords: [],
    putBlobs: [{ id: 'img', bytes: new Uint8Array([9, 8]) }], deleteBlobs: [],
    meta: meta('d1', { salt: new Uint8Array([5, 6]), check: new Uint8Array([7]) }),
  })
  const m = (await db.getMeta('d1'))!
  expect(Array.from(m.salt!)).toEqual([5, 6])
  expect(Array.from(m.check!)).toEqual([7])
  const all = await db.readAll('d1')
  expect(Array.from((all.records[0]!.value as { s: Uint8Array }).s)).toEqual([1, 2, 3])
  expect(Array.from(all.blobs[0]!.bytes)).toEqual([9, 8])
})

test('readAll returns only the requested document rows', async () => {
  const db = await openLiveDb(factory)
  await db.commit('d1', { putRecords: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }], deleteRecords: [], putBlobs: [{ id: 'i1', bytes: new Uint8Array([1]) }], deleteBlobs: [], meta: meta('d1') })
  await db.commit('d1x', { putRecords: [{ key: 'a', value: 99 }], deleteRecords: [], putBlobs: [{ id: 'i1', bytes: new Uint8Array([2]) }], deleteBlobs: [], meta: meta('d1x') })
  const all = await db.readAll('d1')
  expect(all.records.map((r) => [r.key, r.value]).sort()).toEqual([['a', 1], ['b', 2]])
  expect(all.blobs.map((b) => b.id)).toEqual(['i1'])
  expect(Array.from(all.blobs[0]!.bytes)).toEqual([1])
})

test('commit applies puts, deletes and meta together; a later commit overwrites and deletes', async () => {
  const db = await openLiveDb(factory)
  await db.commit('d', { putRecords: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }], deleteRecords: [], putBlobs: [{ id: 'x', bytes: new Uint8Array([1]) }], deleteBlobs: [], meta: meta('d') })
  await db.commit('d', { putRecords: [{ key: 'a', value: 10 }], deleteRecords: ['b'], putBlobs: [], deleteBlobs: ['x'], meta: meta('d', { unwrittenChanges: true }) })
  const all = await db.readAll('d')
  expect(all.records).toEqual([{ key: 'a', value: 10 }])
  expect(all.blobs).toEqual([])
  expect((await db.getMeta('d'))!.unwrittenChanges).toBe(true)
})

test('a commit without meta leaves the stored meta alone', async () => {
  const db = await openLiveDb(factory)
  await db.commit('d', { ...empty, meta: meta('d', { fileName: 'keep.tmv' }) })
  await db.commit('d', { ...empty, putRecords: [{ key: 'a', value: 1 }] })
  expect((await db.getMeta('d'))!.fileName).toBe('keep.tmv')
})

test('deleteDoc removes meta, records and blobs of that document only', async () => {
  const db = await openLiveDb(factory)
  for (const id of ['d1', 'd2']) {
    await db.commit(id, { putRecords: [{ key: 'a', value: id }], deleteRecords: [], putBlobs: [{ id: 'i', bytes: new Uint8Array([1]) }], deleteBlobs: [], meta: meta(id) })
  }
  await db.deleteDoc('d1')
  expect(await db.getMeta('d1')).toBeUndefined()
  expect(await db.readAll('d1')).toEqual({ records: [], blobs: [] })
  expect((await db.readAll('d2')).records).toEqual([{ key: 'a', value: 'd2' }])
  expect(await db.getMeta('d2')).toBeDefined()
})

type Fn = (...x: unknown[]) => unknown
const bound = (t: object, p: string | symbol): unknown => {
  const v = Reflect.get(t, p) as unknown
  return typeof v === 'function' ? (v as Fn).bind(t) : v
}
const assign = <T extends object>(t: T, p: string | symbol, v: unknown): boolean => { (t as Record<string | symbol, unknown>)[p] = v; return true }

/** Wraps an IDBFactory so every `put` into `failStore` throws once armed, to simulate a mid-transaction failure. */
function failingFactory(base: IDBFactory, failStore: string, error: () => Error): { factory: IDBFactory; arm(): void } {
  let armed = false
  const wrapStore = (store: IDBObjectStore, name: string): IDBObjectStore => new Proxy(store, {
    get(t, p) {
      if (p === 'put' && name === failStore) return (...a: unknown[]) => { if (armed) throw error(); return (t.put as Fn).apply(t, a) }
      return bound(t, p)
    },
  })
  const wrapTx = (tx: IDBTransaction): IDBTransaction => new Proxy(tx, {
    get(t, p) { return p === 'objectStore' ? (n: string) => wrapStore(t.objectStore(n), n) : bound(t, p) },
    set: assign,
  })
  const wrapDb = (db: IDBDatabase): IDBDatabase => new Proxy(db, {
    get(t, p) { return p === 'transaction' ? (...a: Parameters<IDBDatabase['transaction']>) => wrapTx(t.transaction(...a)) : bound(t, p) },
    set: assign,
  })
  const wrapped = {
    open(name: string, version?: number): IDBOpenDBRequest {
      const req = base.open(name, version)
      return new Proxy(req, {
        get(t, p) { return p === 'result' ? wrapDb(t.result) : (Reflect.get(t, p) as unknown) },
        set: assign,
      })
    },
  } as unknown as IDBFactory
  return { factory: wrapped, arm: () => { armed = true } }
}

test('a failure after some puts rolls the whole commit back and keeps prior data', async () => {
  const f = failingFactory(factory, 'blobs', () => new DOMException('full', 'QuotaExceededError'))
  const db = await openLiveDb(f.factory)
  await db.commit('d', { ...empty, putRecords: [{ key: 'old', value: 1 }], meta: meta('d', { fileName: 'before.tmv' }) })
  f.arm()
  const err = await db.commit('d', {
    putRecords: [{ key: 'old', value: 2 }, { key: 'new', value: 3 }], deleteRecords: [],
    putBlobs: [{ id: 'x', bytes: new Uint8Array([1]) }], deleteBlobs: [], meta: meta('d', { fileName: 'after.tmv' }),
  }).catch((e: unknown) => e)
  expect((err as Error).name).toBe('QuotaExceededError')
  const all = await db.readAll('d')
  expect(all.records).toEqual([{ key: 'old', value: 1 }])
  expect(all.blobs).toEqual([])
  expect((await db.getMeta('d'))!.fileName).toBe('before.tmv')
})

test('after a failed commit the connection still works', async () => {
  const f = failingFactory(factory, 'records', () => new Error('boom'))
  const db = await openLiveDb(f.factory)
  f.arm()
  await expect(db.commit('d', { ...empty, putRecords: [{ key: 'a', value: 1 }] })).rejects.toThrow('boom')
  await expect(db.getMeta('d')).resolves.toBeUndefined()
})

test('openLiveDb rejects instead of hanging when IndexedDB does not exist', async () => {
  const saved = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB
  try {
    await expect(openLiveDb()).rejects.toThrow(/IndexedDB/)
  } finally {
    if (saved) (globalThis as { indexedDB?: IDBFactory }).indexedDB = saved
  }
})

test('a connection the browser closed (site data cleared in another tab) is reopened on the next call', async () => {
  const db = await openLiveDb(factory)
  await db.commit('d', { ...empty, putRecords: [{ key: 'a', value: 1 }], meta: meta('d') })
  // Deleting the database fires versionchange on every open connection, as "clear site data" does.
  const del = factory.deleteDatabase('team-tracker-live')
  await new Promise<void>((resolve, reject) => { del.onsuccess = () => resolve(); del.onerror = () => reject(del.error ?? new Error('delete failed')) })
  expect(await db.readAll('d')).toEqual({ records: [], blobs: [] })
  await db.commit('d', { ...empty, putRecords: [{ key: 'b', value: 2 }], meta: meta('d') })
  expect((await db.readAll('d')).records).toEqual([{ key: 'b', value: 2 }])
})

test('close() makes later calls reject', async () => {
  const db: LiveDb = await openLiveDb(factory)
  db.close()
  await expect(db.getMeta('d')).rejects.toThrow()
})

describe('sharedLiveDb', () => {
  afterEach(() => { resetSharedLiveDb() })

  test('opens the database once and hands every caller the same connection', async () => {
    vi.stubGlobal('indexedDB', factory)
    const a = await sharedLiveDb()
    const b = await sharedLiveDb()
    expect(a).not.toBeNull()
    expect(b).toBe(a)
  })

  test('resolves null (not a rejection) when IndexedDB is unavailable, and tries again next time', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB
    expect(await sharedLiveDb()).toBeNull()
    vi.stubGlobal('indexedDB', factory)
    expect(await sharedLiveDb()).not.toBeNull()
    spy.mockRestore()
    if (saved) (globalThis as { indexedDB?: IDBFactory }).indexedDB = saved
  })
})
