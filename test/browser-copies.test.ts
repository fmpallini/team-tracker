import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveDb, type LiveMeta } from '../src/core/live-db'
import { createBrowserCopies, holdDocument, STALE_COPY_MS } from '../src/core/browser-copies'

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

test('lists the other documents newest first and never the open one', async () => {
  await put('open'); await put('old', { modifiedAt: NOW - 5 * DAY }); await put('new', { modifiedAt: NOW - DAY, unwrittenChanges: true })
  const list = await createBrowserCopies(db, 'open', undefined).list()
  expect(list.map((c) => c.docId)).toEqual(['new', 'old'])
  expect(list[0]).toMatchObject({ fileName: 'new.tmv', unwritten: true })
})

test('remove deletes the rows of that document only, and refuses the open one', async () => {
  await put('open'); await put('other')
  const copies = createBrowserCopies(db, 'open', undefined)
  expect(await copies.remove('open')).toBe(false)
  expect(await copies.remove('other')).toBe(true)
  expect(await ids()).toEqual(['open'])
  expect((await db.stat('other')).records).toBe(0)
  expect((await db.stat('open')).records).toBe(1)
})

test('remove refuses a document another tab holds open', async () => {
  await put('open'); await put('busy')
  const { locks } = fakeLocks(['tmv-doc:busy'])
  expect(await createBrowserCopies(db, 'open', locks).remove('busy')).toBe(false)
  expect(await ids()).toEqual(['busy', 'open'])
})

describe('pruneStale', () => {
  test('removes only clean copies older than the limit that no tab holds', async () => {
    await put('open', { modifiedAt: NOW - 400 * DAY })
    await put('stale', { modifiedAt: NOW - STALE_COPY_MS - DAY })
    await put('recent', { modifiedAt: NOW - STALE_COPY_MS + DAY })
    await put('stale-unsaved', { modifiedAt: NOW - 400 * DAY, unwrittenChanges: true })
    await put('stale-held', { modifiedAt: NOW - 400 * DAY })
    const { locks } = fakeLocks(['tmv-doc:stale-held'])
    expect(await createBrowserCopies(db, 'open', locks).pruneStale(NOW)).toBe(1)
    expect(await ids()).toEqual(['open', 'recent', 'stale-held', 'stale-unsaved'])
  })

  test('removes nothing where Web Locks are missing, since another tab cannot be ruled out', async () => {
    await put('open'); await put('stale', { modifiedAt: NOW - 400 * DAY })
    expect(await createBrowserCopies(db, 'open', undefined).pruneStale(NOW)).toBe(0)
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
