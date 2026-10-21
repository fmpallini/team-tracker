import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveBatch, type LiveDb } from '../src/core/live-db'
import { createLiveStore, type LiveStore } from '../src/core/live-store'
import { createLivePersister, type LivePersister } from '../src/core/live-persist'
import { createStore, type Store } from '../src/core/store'
import { createImageStore } from '../src/core/image-store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { joinDoc } from '../src/core/doc-records'
import { newStamp } from '../src/core/file-stamp'
import { recordCodec, blobCodec, resetSessionKey } from '../src/core/crypto'
import type { Doc } from '../src/core/types'

const IMG = 'a'.repeat(32)
const IMG2 = 'b'.repeat(32)
const meta = { mime: 'image/webp', w: 1, h: 1, bytes: 3 }

let rawDb: LiveDb
let commits: LiveBatch[]
let failNext: Error[]
let gate: Promise<void> | null
let db: LiveDb

/** A manual scheduler: timers fire only when the test says so. */
function manualTimers() {
  const pending = new Set<{ fn: () => void; ms: number }>()
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms }
      pending.add(t)
      return () => { pending.delete(t) }
    },
    count: () => pending.size,
    delays: () => [...pending].map((t) => t.ms),
    fire: () => { const all = [...pending]; pending.clear(); all.forEach((t) => t.fn()) },
  }
}

beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  rawDb = await openLiveDb(new IDBFactory())
  commits = []
  failNext = []
  gate = null
  db = {
    ...rawDb,
    async commit(id, batch) {
      commits.push(batch)
      if (gate) await gate
      const err = failNext.shift()
      if (err) throw err
      return rawDb.commit(id, batch)
    },
  }
})
afterEach(() => { vi.unstubAllGlobals() })

function sampleDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  for (const id of ['T1', 'T2']) {
    const team = createEmptyTeam(id, `Team ${id}`, '', 'en-US')
    team.dailyNotes['2026-07-01'] = `note ${id}`
    team.actionItems.push(
      { id: `${id}a1`, summary: 'one', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 0 },
      { id: `${id}a2`, summary: 'two', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 1 },
    )
    doc.teams.push(team)
  }
  doc.nav.activeTeamId = 'T1'
  return doc
}

interface Rig { store: Store; live: LiveStore; persister: LivePersister; timers: ReturnType<typeof manualTimers>; errors: unknown[]; recovered: number[] }

async function rig(doc: Doc = sampleDoc(), opts: { liveDb?: LiveDb; docId?: string } = {}): Promise<Rig> {
  const store = createStore(doc, createImageStore(null))
  const live = createLiveStore(opts.liveDb ?? db, doc.docId, null)
  const timers = manualTimers()
  const errors: unknown[] = [], recovered: number[] = []
  const persister = await createLivePersister({
    store, live, fileName: 'a.tmv', schedule: timers.schedule,
    onError: (e) => errors.push(e), onRecovered: () => recovered.push(1),
  })
  return { store, live, persister, timers, errors, recovered }
}

async function rawContains(docId: string, text: string): Promise<boolean> {
  const all = await rawDb.readAll(docId)
  const walk = (v: unknown): string => ArrayBuffer.isView(v) ? String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : Array.isArray(v) ? v.map(walk).join(' ') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => k + walk(x)).join(' ') : String(v)
  return walk(all.records).includes(text)
}

const loadDoc = async (docId: string): Promise<Doc> => joinDoc((await createLiveStore(rawDb, docId, null).load()).records)
const putCount = (b: LiveBatch) => b.putRecords.length

test('the initial sync into an empty browser store writes every record once', async () => {
  const { store } = await rig()
  expect(commits).toHaveLength(1)
  expect(putCount(commits[0]!)).toBeGreaterThan(8)
  expect(await loadDoc(store.doc.docId)).toEqual(store.doc)
})

test('importing a file writes the records and its lineage in one commit, never leaving the copy marked unwritten', async () => {
  const doc = sampleDoc()
  const stamp = newStamp()
  const store = createStore(doc, createImageStore(null))
  const live = createLiveStore(db, doc.docId, null)
  await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: stamp })
  expect(commits).toHaveLength(1)
  expect(commits[0]!.meta).toMatchObject({ lastWriteId: stamp.writeId, knownWriteIds: [stamp.writeId], unwrittenChanges: false, lastFileWriteAt: stamp.savedAt })
  expect(await loadDoc(doc.docId)).toEqual(doc)
})

test('importing a file that carries no stamp records no lineage', async () => {
  const doc = sampleDoc()
  const live = createLiveStore(db, doc.docId, null)
  await createLivePersister({ store: createStore(doc, createImageStore(null)), live, fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: null })
  expect(await live.meta()).toMatchObject({ lastWriteId: null, knownWriteIds: [], unwrittenChanges: false })
})

test('opening over an existing browser copy writes nothing', async () => {
  const doc = sampleDoc()
  await rig(doc)
  commits.length = 0
  await rig(doc)
  expect(commits).toHaveLength(0)
})

test('seeded from what the store actually holds, the first flush writes only what differs (a migration, say) without calling it unwritten', async () => {
  const doc = sampleDoc()
  const liveA = createLiveStore(db, doc.docId, null)
  await createLivePersister({ store: createStore(doc, createImageStore(null)), live: liveA, fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: newStamp() })
  const stored = await liveA.load()
  // the document the app now holds differs from the stored one in exactly one record
  doc.teams[0]!.name = 'migrated'
  commits.length = 0
  const store = createStore(doc, createImageStore(null))
  const live = createLiveStore(db, doc.docId, null)
  await live.load()
  await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule, stored: { records: stored.records, blobIds: [] } })
  expect(commits).toHaveLength(1)
  expect(commits[0]!.putRecords).toHaveLength(1)
  expect((await live.meta())!.unwrittenChanges).toBe(false)
})

test('editing one daily note commits exactly that record', async () => {
  const { store, persister } = await rig()
  commits.length = 0
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'changed' })
  await persister.flush()
  expect(commits).toHaveLength(1)
  expect(commits[0]!.putRecords).toHaveLength(1)
  expect(commits[0]!.deleteRecords).toHaveLength(0)
  expect(await loadDoc(store.doc.docId)).toEqual(store.doc)
})

test('50 edits inside one window arm one timer and commit once', async () => {
  const { store, timers } = await rig()
  commits.length = 0
  for (let i = 0; i < 50; i++) store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = `v${i}` })
  expect(timers.count()).toBe(1)
  expect(timers.delays()).toEqual([400])
  timers.fire()
  await new Promise((r) => setTimeout(r, 20))
  expect(commits).toHaveLength(1)
  expect((await loadDoc(store.doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('v49')
})

test('nav-only changes are persisted', async () => {
  const { store, persister } = await rig()
  store.updateNav((d) => { d.nav.activeTeamId = 'T2'; d.nav.sidebarCollapsed = true })
  await persister.flush()
  const back = await loadDoc(store.doc.docId)
  expect(back.nav.activeTeamId).toBe('T2')
  expect(back.nav.sidebarCollapsed).toBe(true)
})

test('replaceDoc with a different document leaves the browser copy reloadable to the new one and none of the old', async () => {
  const { store, persister } = await rig()
  const next = sampleDoc()
  next.docId = store.doc.docId
  next.teams = [next.teams[1]!]
  next.teams[0]!.name = 'only'
  store.replaceDoc(next)
  await persister.flush()
  const back = await loadDoc(store.doc.docId)
  expect(back).toEqual(next)
  expect(back.teams.map((t) => t.id)).toEqual(['T2'])
})

test('deleting a team removes its records; restoring it brings them back', async () => {
  const { store, persister } = await rig()
  const removed = store.doc.teams[0]!
  const before = (await rawDb.readAll(store.doc.docId)).records.length
  store.update((d) => { d.teams.splice(0, 1) })
  await persister.flush()
  expect((await rawDb.readAll(store.doc.docId)).records.length).toBeLessThan(before)
  expect((await loadDoc(store.doc.docId)).teams.map((t) => t.id)).toEqual(['T2'])
  store.update((d) => { d.teams.unshift(removed) })
  await persister.flush()
  expect(await loadDoc(store.doc.docId)).toEqual(store.doc)
})

test('reordering a list persists the new order', async () => {
  const { store, persister } = await rig()
  store.update((d) => { d.teams[0]!.actionItems.reverse() })
  await persister.flush()
  expect((await loadDoc(store.doc.docId)).teams[0]!.actionItems.map((a) => a.id)).toEqual(['T1a2', 'T1a1'])
})

test('a new image writes its blob once; a second flush writes nothing', async () => {
  const { store, persister } = await rig()
  commits.length = 0
  store.images.putPlain(IMG, new Uint8Array([1, 2, 3]))
  store.update((d) => { d.images[IMG] = { ...meta }; d.teams[0]!.dailyNotes['2026-07-02'] = `![x](img:${IMG})` })
  await persister.flush()
  expect(commits).toHaveLength(1)
  expect(commits[0]!.putBlobs.map((b) => b.id)).toEqual([IMG])
  await persister.flush()
  expect(commits).toHaveLength(1)
  const loaded = await createLiveStore(rawDb, store.doc.docId, null).load()
  expect(Array.from(loaded.blobs.get(IMG)!)).toEqual([1, 2, 3])
})

test('markFileWritten records the stamp, clears unwritten, caps the known list at 20 and sweeps unreferenced blobs', async () => {
  const { store, live, persister } = await rig()
  store.images.putPlain(IMG, new Uint8Array([1]))
  store.images.putPlain(IMG2, new Uint8Array([2]))
  store.update((d) => {
    d.images[IMG] = { ...meta }; d.images[IMG2] = { ...meta }
    d.teams[0]!.dailyNotes['2026-07-02'] = `![x](img:${IMG})`
  })
  await persister.flush()
  expect((await live.meta())!.unwrittenChanges).toBe(true)
  let last = newStamp(5)
  for (let i = 0; i < 25; i++) { last = newStamp(i); await persister.markFileWritten(last) }
  const m = (await live.meta())!
  expect(m.lastWriteId).toBe(last.writeId)
  expect(m.knownWriteIds).toHaveLength(20)
  expect(m.knownWriteIds[0]).toBe(last.writeId)
  expect(m.unwrittenChanges).toBe(false)
  expect(m.lastFileWriteAt).toBe(last.savedAt)
  const blobs = (await createLiveStore(rawDb, store.doc.docId, null).load()).blobs
  expect([...blobs.keys()]).toEqual([IMG])
})

test('a swept blob stays out of the store until a note references it again', async () => {
  const { store, persister } = await rig()
  store.images.putPlain(IMG, new Uint8Array([1]))
  store.update((d) => { d.images[IMG] = { ...meta }; d.teams[0]!.dailyNotes['2026-07-02'] = `![x](img:${IMG})` })
  await persister.flush()
  store.update((d) => { delete d.teams[0]!.dailyNotes['2026-07-02'] })
  await persister.markFileWritten(newStamp())
  const blobIds = async () => [...(await createLiveStore(rawDb, store.doc.docId, null).load()).blobs.keys()]
  expect(await blobIds()).toEqual([])
  await persister.flush()
  expect(await blobIds()).toEqual([]) // the sweep is not undone by the next flush
  // undo: the note comes back and the bytes (still in memory) are stored again
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-02'] = `![x](img:${IMG})` })
  await persister.flush()
  expect(await blobIds()).toEqual([IMG])
})

test('markFileWritten leaves unwrittenChanges true when an edit landed after the snapshot', async () => {
  const { store, live, persister } = await rig()
  store.update((d) => { d.nav.split = true })
  const revAtSnapshot = store.rev
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'later' })
  await persister.markFileWritten(newStamp(), revAtSnapshot)
  expect((await live.meta())!.unwrittenChanges).toBe(true)
  expect((await loadDoc(store.doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('later')
})

test('an existing unwritten flag is never cleared by an ordinary flush', async () => {
  const doc = sampleDoc()
  const first = await rig(doc)
  first.store.update((d) => { d.nav.split = true })
  await first.persister.flush()
  expect((await first.live.meta())!.unwrittenChanges).toBe(true)
  const again = await rig(doc)
  expect(again.store.dirty).toBe(false)
  await again.persister.flush()
  expect((await again.live.meta())!.unwrittenChanges).toBe(true)
})

test('adoptFileStamp after the file replaced the document records the lineage and clears unwritten', async () => {
  const { store, live, persister } = await rig()
  store.update((d) => { d.nav.split = true })
  await persister.flush()
  const fromFile = sampleDoc()
  fromFile.docId = store.doc.docId
  fromFile.teams[0]!.name = 'from the file'
  store.replaceDoc(fromFile)
  const stamp = newStamp()
  await persister.adoptFileStamp(stamp)
  const m = (await live.meta())!
  expect(m.lastWriteId).toBe(stamp.writeId)
  expect(m.unwrittenChanges).toBe(false)
  expect((await loadDoc(store.doc.docId)).teams[0]!.name).toBe('from the file')
})

test('reseed starts the diff from what the store holds now: a document reloaded from it writes nothing, and the flag follows the stored meta', async () => {
  // Two tabs on one document. Tab A (the writer) edits; tab B has been read-only with a stale cache.
  const doc = sampleDoc()
  const stamp = newStamp()
  const a = await rig(doc)
  const b = await rig(JSON.parse(JSON.stringify(doc)) as Doc)
  a.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'written by A' })
  await a.persister.flush()
  await a.persister.markFileWritten(stamp, a.store.rev)
  a.store.update((d) => { d.teams[1]!.name = 'renamed after the file write' })
  await a.persister.flush()

  commits.length = 0
  const liveB = createLiveStore(db, doc.docId, null)
  const stored = await liveB.load()
  const reloaded = joinDoc(stored.records)
  const storeB = createStore(reloaded, createImageStore(null))
  const persisterB = await createLivePersister({ store: storeB, live: liveB, fileName: 'a.tmv', schedule: manualTimers().schedule, stored: { records: stored.records, blobIds: stored.blobs.keys() } })
  commits.length = 0
  await persisterB.reseed({ records: stored.records, blobIds: stored.blobs.keys() })
  storeB.replaceDoc(JSON.parse(JSON.stringify(reloaded)) as Doc)
  await persisterB.flush()
  expect(commits).toHaveLength(0)
  expect((await liveB.meta())!.unwrittenChanges).toBe(true)
  expect((await liveB.meta())!.lastWriteId).toBe(stamp.writeId)
  b.persister.dispose()
})

describe('a tab that does not hold the write lock must not touch the browser copy', () => {
  test('a persister made on a read-only store writes nothing until the store becomes writable, then does the initial sync', async () => {
    const doc = sampleDoc()
    const store = createStore(doc, createImageStore(null))
    store.setReadOnly(true, { silent: true })
    const live = createLiveStore(db, doc.docId, null)
    const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: newStamp() })
    expect(commits).toHaveLength(0)
    expect(await live.meta()).toBeUndefined()

    store.setReadOnly(false) // nobody calls flush: gaining the lock is itself the trigger
    await vi.waitFor(() => expect(commits).toHaveLength(1))
    expect(await loadDoc(doc.docId)).toEqual(doc)
    expect((await live.meta())!.unwrittenChanges).toBe(false)
    void persister
  })

  test('replacing a stored copy with the file waits too: the old rows survive until this tab holds the lock, then go in one commit', async () => {
    const original = sampleDoc()
    await rig(original)
    const fromFile = JSON.parse(JSON.stringify(original)) as Doc
    fromFile.teams = [fromFile.teams[0]!]
    commits.length = 0

    const store = createStore(fromFile, createImageStore(null))
    store.setReadOnly(true, { silent: true })
    const live = createLiveStore(db, fromFile.docId, null)
    const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: newStamp(), replaceStored: true })
    expect(commits).toHaveLength(0)
    expect((await loadDoc(original.docId)).teams).toHaveLength(2)

    store.setReadOnly(false)
    await vi.waitFor(() => expect(commits).toHaveLength(1))
    await persister.flush()
    expect(commits).toHaveLength(1)
    expect(commits[0]!.clear).toBe(true)
    expect(await loadDoc(original.docId)).toEqual(fromFile)
    expect((await live.meta())!.unwrittenChanges).toBe(false)
  })

  test('replacing a stored copy on a writable store happens at once', async () => {
    const original = sampleDoc()
    await rig(original)
    const fromFile = JSON.parse(JSON.stringify(original)) as Doc
    fromFile.teams = [fromFile.teams[1]!]
    await createLivePersister({ store: createStore(fromFile, createImageStore(null)), live: createLiveStore(db, fromFile.docId, null), fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: newStamp(), replaceStored: true })
    expect(await loadDoc(original.docId)).toEqual(fromFile)
  })

  test('reseeding from the store while the initial sync is still waiting cancels it: the holder copy is what this tab follows', async () => {
    const original = sampleDoc()
    await rig(original)
    const stale = JSON.parse(JSON.stringify(original)) as Doc
    stale.teams[0]!.name = 'a stale idea of the file'
    commits.length = 0

    const store = createStore(stale, createImageStore(null))
    store.setReadOnly(true, { silent: true })
    const live = createLiveStore(db, stale.docId, null)
    const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: newStamp(), replaceStored: true })
    const stored = await live.load()
    await persister.reseed({ records: stored.records, blobIds: stored.blobs.keys() })
    store.replaceDoc(joinDoc(stored.records))
    store.setReadOnly(false)
    await persister.flush()
    await new Promise((r) => setTimeout(r, 20))

    expect(commits).toHaveLength(0)
    expect((await loadDoc(original.docId)).teams[0]!.name).toBe('Team T1')
  })

  test('a failed initial sync is retried as the initial sync, not as an ordinary diff', async () => {
    const original = sampleDoc()
    await rig(original)
    const fromFile = JSON.parse(JSON.stringify(original)) as Doc
    fromFile.teams = [fromFile.teams[0]!]
    failNext.push(new Error('quota'))
    const persister = await createLivePersister({ store: createStore(fromFile, createImageStore(null)), live: createLiveStore(db, fromFile.docId, null), fileName: 'a.tmv', schedule: manualTimers().schedule, fromFile: newStamp(), replaceStored: true })
    expect(persister.lastError).toBeTruthy()
    await persister.flush()
    expect(persister.lastError).toBeNull()
    expect(await loadDoc(original.docId)).toEqual(fromFile) // the stale second team is gone too
  })
})

test('a store that is read-only never commits', async () => {
  const { store, persister, timers } = await rig()
  commits.length = 0
  store.setReadOnly(true)
  store.updateNav((d) => { d.nav.split = true })
  timers.fire()
  await persister.flush()
  expect(commits).toHaveLength(0)
})

test('a failing commit keeps the edit pending, reports once, retries, then reports recovery', async () => {
  const { store, persister, errors, recovered, timers } = await rig()
  commits.length = 0
  failNext.push(new DOMException('full', 'QuotaExceededError'))
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'kept in memory' })
  await persister.flush()
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).name).toBe('QuotaExceededError')
  expect(persister.lastError).toBeTruthy()
  expect(recovered).toHaveLength(0)
  expect(timers.delays()).toContain(30_000)
  // a second failure in the same episode does not report again
  failNext.push(new Error('still full'))
  await persister.flush()
  expect(errors).toHaveLength(1)
  // the record is still unwritten, so the retry writes it
  await persister.flush()
  expect(commits.at(-1)!.putRecords).toHaveLength(1)
  expect(persister.lastError).toBeNull()
  expect(recovered).toHaveLength(1)
  expect((await loadDoc(store.doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('kept in memory')
})

test('a stamp whose commit failed is applied by the next successful commit', async () => {
  const { live, persister } = await rig()
  failNext.push(new Error('boom'))
  const stamp = newStamp()
  await persister.markFileWritten(stamp)
  expect((await live.meta())!.lastWriteId).not.toBe(stamp.writeId)
  await persister.flush()
  expect((await live.meta())!.lastWriteId).toBe(stamp.writeId)
})

test('an edit after a successful file write raises unwrittenChanges again and keeps the stamp', async () => {
  const { store, live, persister } = await rig()
  const stamp = newStamp()
  await persister.markFileWritten(stamp)
  expect((await live.meta())!.unwrittenChanges).toBe(false)
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'after the write' })
  await persister.flush()
  const m = (await live.meta())!
  expect(m.unwrittenChanges).toBe(true)
  expect(m.lastWriteId).toBe(stamp.writeId)
  expect(m.knownWriteIds).toEqual([stamp.writeId])
})

test('a stamp kept for retry still remembers which revision the file holds', async () => {
  const { store, live, persister } = await rig()
  store.update((d) => { d.nav.split = true })
  const revAtSnapshot = store.rev
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'after the snapshot' })
  failNext.push(new Error('boom'))
  await persister.markFileWritten(newStamp(), revAtSnapshot)
  await persister.flush()
  expect((await live.meta())!.unwrittenChanges).toBe(true)
})

test('flush resolves only after the commit in flight has finished', async () => {
  const { store, persister } = await rig()
  let release!: () => void
  gate = new Promise<void>((r) => { release = r })
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'slow' })
  let done = false
  const p = persister.flush().then(() => { done = true })
  await new Promise((r) => setTimeout(r, 20))
  expect(done).toBe(false)
  release()
  await p
  expect(done).toBe(true)
  expect((await loadDoc(store.doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('slow')
})

test('an edit that lands during a commit is written by the trailing flush', async () => {
  const { store, persister, timers } = await rig()
  let release!: () => void
  gate = new Promise<void>((r) => { release = r })
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'first' })
  const p = persister.flush()
  await new Promise((r) => setTimeout(r, 10))
  store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'second' })
  gate = null
  release()
  await p
  timers.fire()
  await persister.flush()
  expect((await loadDoc(store.doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('second')
})

test('dispose cancels the timer and later mutations arm nothing', async () => {
  const { store, persister, timers } = await rig()
  store.update((d) => { d.nav.split = true })
  expect(timers.count()).toBe(1)
  persister.dispose()
  expect(timers.count()).toBe(0)
  store.update((d) => { d.nav.split = false })
  expect(timers.count()).toBe(0)
})

test('dispose releases every store subscription it took (a document that is closed must not stay reachable through its store)', async () => {
  const store = createStore(sampleDoc(), createImageStore(null))
  let active = 0
  for (const name of ['onMutate', 'onDirty'] as const) {
    const original = store[name].bind(store) as (fn: never) => () => void
    vi.spyOn(store, name).mockImplementation(((fn: never) => {
      active++
      const off = original(fn)
      return () => { active--; off() }
    }) as never)
  }
  const persister = await createLivePersister({ store, live: createLiveStore(db, store.doc.docId, null), fileName: 'a.tmv', schedule: manualTimers().schedule })
  expect(active).toBe(2)
  persister.dispose()
  expect(active).toBe(0)
})

test('onErrorChange reports when a storage failure starts and when it ends, not every retry in between', async () => {
  const { store, persister } = await rig()
  const seen: boolean[] = []
  const off = persister.onErrorChange((failed) => seen.push(failed))
  failNext.push(new Error('quota'), new Error('quota again'))
  store.update((d) => { d.nav.split = true })
  await persister.flush()
  await persister.flush()
  expect(seen).toEqual([true])
  await persister.flush()
  expect(seen).toEqual([true, false])
  off()
  failNext.push(new Error('later'))
  store.update((d) => { d.nav.split = false })
  await persister.flush()
  expect(seen).toEqual([true, false])
})

describe('rekey', () => {
  test('re-seals the browser copy and every stored image under the new codec, and writes consistently afterwards', async () => {
    const doc = sampleDoc()
    const images = createImageStore(null)
    images.putPlain(IMG, new Uint8Array([1, 2, 3]))
    doc.images[IMG] = { ...meta }
    doc.teams[0]!.dailyNotes['2026-07-01'] = `![x](img:${IMG})`
    const store = createStore(doc, images)
    const oldCodec = await recordCodec('old')
    const live = createLiveStore(db, doc.docId, oldCodec)
    const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule })
    expect(await rawContains(doc.docId, 'note T1')).toBe(false)

    resetSessionKey()
    const newBlob = await blobCodec('new')
    await images.rekey(newBlob)
    const newCodec = await recordCodec('new', newBlob.header!.salt)
    await persister.rekey(newCodec)

    const m = (await live.meta())!
    expect(await newCodec.verifyCheck(m.check!)).toBe(true)
    expect(await oldCodec.verifyCheck(m.check!)).toBe(false)
    const loaded = await createLiveStore(rawDb, doc.docId, newCodec).load()
    expect(joinDoc(loaded.records)).toEqual(doc)
    // the stored image is now in the form the NEW key seals (it opens with the new image codec)
    expect(Array.from(await newBlob.open(IMG, loaded.blobs.get(IMG)!))).toEqual([1, 2, 3])

    store.update((d) => { d.teams[0]!.dailyNotes['2026-07-09'] = 'after' })
    await persister.flush()
    expect(joinDoc((await createLiveStore(rawDb, doc.docId, newCodec).load()).records).teams[0]!.dailyNotes['2026-07-09']).toBe('after')
  }, 120000)

  test('does not interleave with a flush: an edit pending during the rekey is written after it, under the new key', async () => {
    const doc = sampleDoc()
    const store = createStore(doc, createImageStore(null))
    const oldCodec = await recordCodec('old')
    const live = createLiveStore(db, doc.docId, oldCodec)
    const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule })
    resetSessionKey()
    const newCodec = await recordCodec('new')
    store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'racing edit' })
    await Promise.all([persister.rekey(newCodec), persister.flush()])
    const loaded = await createLiveStore(rawDb, doc.docId, newCodec).load()
    expect(joinDoc(loaded.records).teams[0]!.dailyNotes['2026-07-01']).toBe('racing edit')
  }, 120000)

  test('a failed rekey rejects and leaves the old codec writing', async () => {
    const doc = sampleDoc()
    const store = createStore(doc, createImageStore(null))
    const oldCodec = await recordCodec('old')
    const live = createLiveStore(db, doc.docId, oldCodec)
    const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: manualTimers().schedule })
    resetSessionKey()
    const newCodec = await recordCodec('new')
    failNext.push(new Error('quota'))
    await expect(persister.rekey(newCodec)).rejects.toThrow('quota')
    store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'still old key' })
    await persister.flush()
    expect(joinDoc((await createLiveStore(rawDb, doc.docId, oldCodec).load()).records).teams[0]!.dailyNotes['2026-07-01']).toBe('still old key')
  }, 120000)
})
