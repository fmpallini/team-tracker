import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveBatch, type LiveDb } from '../src/core/live-db'
import { createLiveStore, type LiveStore } from '../src/core/live-store'
import { createLivePersister, type LivePersister } from '../src/core/live-persist'
import { createStore, type Store } from '../src/core/store'
import { createImageStore } from '../src/core/image-store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { joinDoc } from '../src/core/doc-records'
import { newStamp } from '../src/core/file-stamp'
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

const loadDoc = async (docId: string): Promise<Doc> => joinDoc((await createLiveStore(rawDb, docId, null).load()).records)
const putCount = (b: LiveBatch) => b.putRecords.length

test('the initial sync into an empty browser store writes every record once', async () => {
  const { store } = await rig()
  expect(commits).toHaveLength(1)
  expect(putCount(commits[0]!)).toBeGreaterThan(8)
  expect(await loadDoc(store.doc.docId)).toEqual(store.doc)
})

test('opening over an existing browser copy writes nothing', async () => {
  const doc = sampleDoc()
  await rig(doc)
  commits.length = 0
  await rig(doc)
  expect(commits).toHaveLength(0)
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
