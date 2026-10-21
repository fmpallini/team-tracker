import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveDb } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { recordCodec, resetSessionKey, CorruptFileError } from '../src/core/crypto'
import { SCHEMA_VERSION } from '../src/core/document'

let factory: IDBFactory
let db: LiveDb
beforeEach(async () => {
  resetSessionKey()
  factory = new IDBFactory()
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  db = await openLiveDb(factory)
})
afterEach(() => { vi.unstubAllGlobals() })

const SECRET = 'distinctive-secret-text-7731'
const DATE_PATH = 'team/t1/daily/2026-07-04'

/** Every string, object key and byte (as a latin-1 character) reachable from `v`, joined: what a disk forensics pass could read. */
function everythingReadable(v: unknown): string {
  if (v instanceof Uint8Array) return String.fromCharCode(...v)
  if (Array.isArray(v)) return v.map(everythingReadable).join('\n')
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => k + '\n' + everythingReadable(x)).join('\n')
  return String(v)
}

async function rawDump(docId: string): Promise<string> {
  const all = await db.readAll(docId)
  return everythingReadable([all.records.map((r) => [r.key, r.value]), all.blobs, await db.getMeta(docId)])
}

const puts = (o: Record<string, unknown>) => new Map(Object.entries(o))

test('plain documents round-trip through a fresh store instance', async () => {
  const a = createLiveStore(db, 'd', null)
  await a.write({ puts: puts({ doc: { x: 1 }, [DATE_PATH]: SECRET, 'team/t1': { _order: {} } }) })
  const { records } = await createLiveStore(db, 'd', null).load()
  expect(Object.fromEntries(records)).toEqual({ doc: { x: 1 }, [DATE_PATH]: SECRET, 'team/t1': { _order: {} } })
})

test('encrypted documents round-trip, and nothing readable or path-revealing reaches the database', async () => {
  const codec = await recordCodec('pw')
  const a = createLiveStore(db, 'd', codec)
  await a.write({ puts: puts({ doc: { note: SECRET }, [DATE_PATH]: SECRET }), meta: { fileName: 'file.tmv' } })
  const dump = await rawDump('d')
  expect(dump).not.toContain(SECRET)
  expect(dump).not.toContain('2026-07-04')
  expect(dump).not.toContain('daily')
  const rows = (await db.readAll('d')).records
  expect(rows).toHaveLength(2)
  for (const r of rows) expect(r.key).toMatch(/^[0-9a-f]{32}$/)
  const { records } = await createLiveStore(db, 'd', codec).load()
  expect(records.get(DATE_PATH)).toBe(SECRET)
  expect(records.get('doc')).toEqual({ note: SECRET })
}, 30000)

test('rows swapped between keys fail to open instead of yielding another record\'s content', async () => {
  const codec = await recordCodec('pw')
  await createLiveStore(db, 'd', codec).write({ puts: puts({ one: 'first', two: 'second' }) })
  const rows = (await db.readAll('d')).records
  await db.commit('d', {
    putRecords: [{ key: rows[0]!.key, value: rows[1]!.value }, { key: rows[1]!.key, value: rows[0]!.value }],
    deleteRecords: [], putBlobs: [], deleteBlobs: [],
  })
  await expect(createLiveStore(db, 'd', codec).load()).rejects.toBeInstanceOf(CorruptFileError)
}, 30000)

test('a row sealed under another document id does not open here', async () => {
  const codec = await recordCodec('pw')
  await createLiveStore(db, 'other', codec).write({ puts: puts({ doc: 'x' }) })
  const row = (await db.readAll('other')).records[0]!
  await db.commit('d', { putRecords: [row], deleteRecords: [], putBlobs: [], deleteBlobs: [] })
  await expect(createLiveStore(db, 'd', codec).load()).rejects.toBeInstanceOf(CorruptFileError)
}, 30000)

test('loading with a codec for another password rejects the whole load', async () => {
  const codec = await recordCodec('pw')
  await createLiveStore(db, 'd', codec).write({ puts: puts({ doc: 'x' }) })
  const wrong = await recordCodec('other', codec.salt)
  await expect(createLiveStore(db, 'd', wrong).load()).rejects.toBeInstanceOf(CorruptFileError)
  await expect(createLiveStore(db, 'd', null).load()).rejects.toBeInstanceOf(CorruptFileError)
}, 60000)

test('a delete removes the row; the path can be written again later', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ a: 1, b: 2 }) })
  await s.write({ deletes: ['a'] })
  expect([...(await createLiveStore(db, 'd', null).load()).records]).toEqual([['b', 2]])
  await s.write({ puts: puts({ a: 3 }) })
  expect(Object.fromEntries((await createLiveStore(db, 'd', null).load()).records)).toEqual({ a: 3, b: 2 })
})

test('updating a path reuses its row instead of adding one', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ a: 1 }) })
  await s.write({ puts: puts({ a: 2 }) })
  expect((await db.readAll('d')).records).toHaveLength(1)
  expect((await createLiveStore(db, 'd', null).load()).records.get('a')).toBe(2)
})

test('after load a new instance updates the existing rows rather than minting new ones', async () => {
  await createLiveStore(db, 'd', null).write({ puts: puts({ a: 1 }) })
  const s = createLiveStore(db, 'd', null)
  await s.load()
  await s.write({ puts: puts({ a: 2 }), deletes: [] })
  expect((await db.readAll('d')).records).toHaveLength(1)
})

test('meta is created on the first write from the codec, and later writes merge into it', async () => {
  const codec = await recordCodec('pw')
  const s = createLiveStore(db, 'd', codec)
  expect(await s.meta()).toBeUndefined()
  await s.write({ puts: puts({ a: 1 }), meta: { fileName: 'one.tmv' } })
  const first = (await s.meta())!
  expect(first).toMatchObject({
    docId: 'd', encrypted: true, fileName: 'one.tmv', schemaVersion: SCHEMA_VERSION,
    lastWriteId: null, knownWriteIds: [], unwrittenChanges: false, lastFileWriteAt: null,
  })
  expect(Array.from(first.salt!)).toEqual(Array.from(codec.salt))
  expect(await codec.verifyCheck(first.check!)).toBe(true)
  await s.write({ meta: { unwrittenChanges: true, lastWriteId: 'w1' } })
  const second = (await s.meta())!
  expect(second).toMatchObject({ fileName: 'one.tmv', unwrittenChanges: true, lastWriteId: 'w1', encrypted: true })
  expect(second.modifiedAt).toBeGreaterThanOrEqual(first.modifiedAt)
}, 30000)

test('plain meta carries no salt or check', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ a: 1 }) })
  expect(await s.meta()).toMatchObject({ encrypted: false, salt: null, check: null })
})

test('image blobs are stored byte for byte and removed on request', async () => {
  const codec = await recordCodec('pw')
  const s = createLiveStore(db, 'd', codec)
  await s.write({ putBlobs: new Map([['img1', new Uint8Array([1, 2, 3])], ['img2', new Uint8Array([4])]]) })
  const loaded = await createLiveStore(db, 'd', codec).load()
  expect(Array.from(loaded.blobs.get('img1')!)).toEqual([1, 2, 3])
  await s.write({ deleteBlobs: ['img1'] })
  expect([...(await createLiveStore(db, 'd', codec).load()).blobs.keys()]).toEqual(['img2'])
}, 30000)

test('rekey to a new password: the new codec loads, the old one no longer verifies or opens', async () => {
  const oldCodec = await recordCodec('old')
  const s = createLiveStore(db, 'd', oldCodec)
  await s.write({ puts: puts({ doc: { n: SECRET } }), putBlobs: new Map([['img1', new Uint8Array([1])]]) })
  resetSessionKey()
  const newCodec = await recordCodec('new')
  await s.rekey(newCodec, new Map([['img1', new Uint8Array([9, 9])]]))

  const loaded = await createLiveStore(db, 'd', newCodec).load()
  expect(loaded.records.get('doc')).toEqual({ n: SECRET })
  expect(Array.from(loaded.blobs.get('img1')!)).toEqual([9, 9])
  const meta = (await s.meta())!
  expect(Array.from(meta.salt!)).toEqual(Array.from(newCodec.salt))
  expect(await oldCodec.verifyCheck(meta.check!)).toBe(false)
  expect(await newCodec.verifyCheck(meta.check!)).toBe(true)
  await expect(createLiveStore(db, 'd', oldCodec).load()).rejects.toBeInstanceOf(CorruptFileError)
  expect(await rawDump('d')).not.toContain(SECRET)
  // the store itself now writes under the new codec
  await s.write({ puts: puts({ more: 'x' }) })
  expect((await createLiveStore(db, 'd', newCodec).load()).records.get('more')).toBe('x')
}, 120000)

test('rekey drops blobs that are not in the new set', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ putBlobs: new Map([['gone', new Uint8Array([1])], ['kept', new Uint8Array([2])]]) })
  await s.rekey(null, new Map([['kept', new Uint8Array([2])]]))
  expect([...(await createLiveStore(db, 'd', null).load()).blobs.keys()]).toEqual(['kept'])
})

test('a failed rekey changes nothing and the old codec stays in force', async () => {
  const oldCodec = await recordCodec('old')
  const s = createLiveStore(db, 'd', oldCodec)
  await s.write({ puts: puts({ doc: SECRET }) })
  resetSessionKey()
  const newCodec = await recordCodec('new')
  const failing: LiveDb = { ...db, commit: () => Promise.reject(new Error('disk full')) }
  const broken = createLiveStore(failing, 'd', oldCodec)
  await broken.load().catch(() => {})
  await expect(broken.rekey(newCodec, new Map())).rejects.toThrow('disk full')

  expect((await createLiveStore(db, 'd', oldCodec).load()).records.get('doc')).toBe(SECRET)
  expect(await oldCodec.verifyCheck((await s.meta())!.check!)).toBe(true)
  // the instance that failed still seals with the old codec
  const real = createLiveStore(db, 'd', oldCodec)
  await real.load()
  await real.write({ puts: puts({ doc: 'again' }) })
  expect((await createLiveStore(db, 'd', oldCodec).load()).records.get('doc')).toBe('again')
}, 120000)

test('plain to encrypted re-seals everything; encrypted to plain makes it readable again', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ doc: { n: SECRET } }) })
  expect(await rawDump('d')).toContain(SECRET)

  const codec = await recordCodec('pw')
  await s.rekey(codec, new Map())
  expect(await rawDump('d')).not.toContain(SECRET)
  expect((await s.meta())!.encrypted).toBe(true)
  expect((await createLiveStore(db, 'd', codec).load()).records.get('doc')).toEqual({ n: SECRET })

  await s.rekey(null, new Map())
  expect(await rawDump('d')).toContain(SECRET)
  expect(await s.meta()).toMatchObject({ encrypted: false, salt: null, check: null })
  expect((await createLiveStore(db, 'd', null).load()).records.get('doc')).toEqual({ n: SECRET })
}, 120000)

test('remove deletes meta, records and blobs', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ a: 1 }), putBlobs: new Map([['i', new Uint8Array([1])]]) })
  await s.remove()
  expect(await db.getMeta('d')).toBeUndefined()
  expect(await db.readAll('d')).toEqual({ records: [], blobs: [] })
})

test('a failed delete leaves its row addressable so the retry still removes it', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ a: 1, b: 2 }) })
  const failOnce: LiveDb = { ...db, commit: vi.fn().mockRejectedValueOnce(new Error('quota')).mockImplementation((id, b) => db.commit(id, b)) }
  const flaky = createLiveStore(failOnce, 'd', null)
  await flaky.load()
  await expect(flaky.write({ deletes: ['a'] })).rejects.toThrow('quota')
  await flaky.write({ deletes: ['a'] })
  expect([...(await createLiveStore(db, 'd', null).load()).records.keys()]).toEqual(['b'])
})

test('write with clear replaces every row of the document, and the paths are addressed afresh afterwards', async () => {
  const s = createLiveStore(db, 'd', null)
  await s.write({ puts: puts({ a: 1, b: 2 }), putBlobs: new Map([['img', new Uint8Array([1])]]) })
  await s.write({ puts: puts({ b: 20, c: 30 }), clear: true })
  const loaded = await createLiveStore(db, 'd', null).load()
  expect(Object.fromEntries(loaded.records)).toEqual({ b: 20, c: 30 })
  expect(loaded.blobs.size).toBe(0)
  await s.write({ puts: puts({ c: 31 }) }) // the instance still knows c's new row
  expect((await db.readAll('d')).records).toHaveLength(2)
})

test('write with clear is allowed before load on a document that already has rows (it throws away what it never read)', async () => {
  await createLiveStore(db, 'd', null).write({ puts: puts({ stale: 1 }) })
  const fresh = createLiveStore(db, 'd', null)
  await fresh.write({ puts: puts({ x: 1 }), clear: true })
  expect([...(await createLiveStore(db, 'd', null).load()).records.keys()]).toEqual(['x'])
})

test('replacing a copy sealed under another password rebuilds the meta for the new key', async () => {
  const oldCodec = await recordCodec('old')
  await createLiveStore(db, 'd', oldCodec).write({ puts: puts({ a: 'old secret' }) })
  resetSessionKey()
  const newCodec = await recordCodec('new')
  await createLiveStore(db, 'd', newCodec).write({ puts: puts({ a: 'new' }), clear: true })
  const meta = (await db.getMeta('d'))!
  expect(Array.from(meta.salt!)).toEqual(Array.from(newCodec.salt))
  expect(await newCodec.verifyCheck(meta.check!)).toBe(true)
  expect(await oldCodec.verifyCheck(meta.check!)).toBe(false)
  expect((await createLiveStore(db, 'd', newCodec).load()).records.get('a')).toBe('new')
}, 120000)
