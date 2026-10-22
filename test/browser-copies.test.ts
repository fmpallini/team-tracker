import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveDb, type LiveMeta } from '../src/core/live-db'
import { holdDocument, pruneStaleCopies, STALE_COPY_MS } from '../src/core/browser-copies'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

let db: LiveDb
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  db = await openLiveDb(new IDBFactory())
})
afterEach(() => { vi.unstubAllGlobals() })

function meta(docId: string, over: Partial<LiveMeta> = {}): LiveMeta {
  return {
    docId, encrypted: false, salt: null, check: null, keySecret: new Uint8Array(16),
    lastWriteId: null, knownWriteIds: [], unwrittenChanges: false, schemaVersion: 18,
    fileName: `${docId}.tmv`, modifiedAt: NOW, lastFileWriteAt: null, ...over,
  }
}
const put = (docId: string, over: Partial<LiveMeta> = {}) =>
  db.commit(docId, { putRecords: [{ key: 'k', value: { t: '{}' } }], deleteRecords: [], putBlobs: [], deleteBlobs: [], meta: meta(docId, over) })
const ids = async () => (await db.listMeta()).map((m) => m.docId).sort()

/** A Web Locks stand-in that only knows which names are held. */
function fakeLocks(held: string[] = []) {
  const names = new Set(held)
  const locks = {
    query: async () => ({ held: [...names].map((name) => ({ name, mode: 'shared' })), pending: [] }),
    request: (name: string, _o: unknown, cb: () => Promise<void>) => { names.add(name); return cb().finally(() => names.delete(name)) },
  } as unknown as LockManager
  return { locks, names }
}

describe('pruneStaleCopies', () => {
  test('removes only clean copies older than the limit that no tab holds', async () => {
    await put('open', { modifiedAt: NOW - 400 * DAY })
    await put('stale', { modifiedAt: NOW - STALE_COPY_MS - DAY })
    await put('recent', { modifiedAt: NOW - STALE_COPY_MS + DAY })
    await put('stale-unsaved', { modifiedAt: NOW - 400 * DAY, unwrittenChanges: true })
    await put('stale-held', { modifiedAt: NOW - 400 * DAY })
    const { locks } = fakeLocks(['tmv-doc:stale-held'])
    expect(await pruneStaleCopies(db, 'open', locks, NOW)).toBe(1)
    expect(await ids()).toEqual(['open', 'recent', 'stale-held', 'stale-unsaved'])
  })

  test('removes nothing where Web Locks are missing, since another tab cannot be ruled out', async () => {
    await put('open'); await put('stale', { modifiedAt: NOW - 400 * DAY })
    expect(await pruneStaleCopies(db, 'open', undefined, NOW)).toBe(0)
    expect(await ids()).toEqual(['open', 'stale'])
  })
})

test('holdDocument keeps the lock until released, and does nothing without Web Locks', async () => {
  const { locks, names } = fakeLocks()
  const release = holdDocument('d1', locks)
  expect([...names]).toEqual(['tmv-doc:d1'])
  release()
  await Promise.resolve(); await Promise.resolve()
  expect([...names]).toEqual([])
  expect(() => holdDocument('d1', undefined)()).not.toThrow()
})
