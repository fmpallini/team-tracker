// A tab that takes the write lock over continues from the browser copy — whatever key the copy is under NOW, which
// the previous holder may have changed (a password added, changed or removed) since this tab last looked.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveDb } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { followLiveCopy, FollowCancelled } from '../src/core/live-follow'
import { splitDoc, serializeRecords } from '../src/core/doc-records'
import { recordCodec, blobCodec, resetSessionKey, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

let db: LiveDb
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  resetSessionKey()
  db = await openLiveDb(new IDBFactory())
})
afterEach(() => { vi.unstubAllGlobals() })

const IMG = 'a'.repeat(32)

function docWith(note: string): Doc {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.dailyNotes['2026-07-01'] = note
  doc.teams.push(team)
  return doc
}

/** The holder wrote `doc` into the copy under `password` (null: plain), with one picture. */
async function holderWrites(doc: Doc, password: string | null) {
  const blob = password === null ? null : await blobCodec(password)
  const codec = password === null ? null : await recordCodec(password, blob!.header!.salt)
  const live = createLiveStore(db, doc.docId, codec)
  const stored = blob ? await blob.seal(IMG, new Uint8Array([7, 7])) : new Uint8Array([7, 7])
  await live.write({ puts: serializeRecords(splitDoc(doc)), putBlobs: new Map([[IMG, stored]]), meta: { fileName: 'f.tmv', unwrittenChanges: true } })
  return live
}

/** This tab's live store: opened before the holder changed anything, so it still has the old codec. */
const myStore = (doc: Doc, codec: Awaited<ReturnType<typeof recordCodec>> | null) => createLiveStore(db, doc.docId, codec)

test('a copy under the same password is followed without asking', async () => {
  const doc = docWith('from the holder')
  await holderWrites(doc, 'pw')
  resetSessionKey()
  const ask = vi.fn(async () => null as string | null)
  const r = await followLiveCopy({ live: myStore(doc, await recordCodec('pw')), currentPassword: 'pw', askPassword: ask })
  expect(ask).not.toHaveBeenCalled()
  expect(r.password).toBe('pw')
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('from the holder')
  expect(r.unwritten).toBe(true)
  expect(Array.from((await r.images.getPlain(IMG))!)).toEqual([7, 7])
}, 120000)

test('a copy the holder re-keyed asks for the new password, and the tab continues under it (images included)', async () => {
  const doc = docWith('after the password change')
  const before = await recordCodec('old')
  await holderWrites(doc, 'new')
  resetSessionKey()
  const ask = vi.fn(async (wasWrong: boolean) => (wasWrong ? 'new' : 'typo'))
  const r = await followLiveCopy({ live: myStore(doc, before), currentPassword: 'old', askPassword: ask })
  expect(ask).toHaveBeenCalledTimes(2)
  expect(r.password).toBe('new')
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('after the password change')
  expect(Array.from((await r.images.getPlain(IMG))!)).toEqual([7, 7])
  expect(r.images.codec()).not.toBeNull()
}, 240000)

test('a password added in the other tab to a plain document is asked for too', async () => {
  const doc = docWith('now protected')
  await holderWrites(doc, 'added')
  resetSessionKey()
  const r = await followLiveCopy({ live: myStore(doc, null), currentPassword: null, askPassword: async () => 'added' })
  expect(r.password).toBe('added')
}, 120000)

test('a password removed in the other tab: the copy is plain, nothing is asked, and the tab becomes plain', async () => {
  const doc = docWith('no longer protected')
  await holderWrites(doc, null)
  const ask = vi.fn(async () => 'never' as string | null)
  const r = await followLiveCopy({ live: myStore(doc, await recordCodec('was')), currentPassword: 'was', askPassword: ask })
  expect(ask).not.toHaveBeenCalled()
  expect(r.password).toBeNull()
  expect(r.images.codec()).toBeNull()
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('no longer protected')
}, 120000)

test('cancelling the password prompt cancels the follow, so the tab stays as it is', async () => {
  const doc = docWith('x')
  await holderWrites(doc, 'new')
  resetSessionKey()
  await expect(followLiveCopy({ live: myStore(doc, await recordCodec('old')), currentPassword: 'old', askPassword: async () => null }))
    .rejects.toBeInstanceOf(FollowCancelled)
}, 120000)

test('a copy with no document record is unreadable, not a crash with a stray Error', async () => {
  const doc = docWith('x')
  const live = createLiveStore(db, doc.docId, null)
  await live.write({ puts: new Map([['team/T1', '{"id":"T1"}']]), meta: { fileName: 'f.tmv' } })
  await expect(followLiveCopy({ live: createLiveStore(db, doc.docId, null), currentPassword: null, askPassword: async () => null }))
    .rejects.toBeInstanceOf(CorruptFileError)
})

test('no copy at all is unreadable too', async () => {
  const doc = docWith('x')
  await expect(followLiveCopy({ live: createLiveStore(db, doc.docId, null), currentPassword: null, askPassword: async () => null }))
    .rejects.toBeInstanceOf(CorruptFileError)
})
