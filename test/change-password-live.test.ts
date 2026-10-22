// A password change against the real browser store: the file and the browser copy must end up under the same key,
// or under the same old key when something fails halfway (the 3.2.0 bug class: two things sealed under different keys).
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveDb } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { createLivePersister, type LivePersister } from '../src/core/live-persist'
import { resolveOpen } from '../src/core/live-open'
import { createChangePassword } from '../src/core/change-password'
import { createStore, type Store } from '../src/core/store'
import { createImageStore } from '../src/core/image-store'
import { blobCodec, recordCodec, decryptDocumentWithVersion, parsePlainWithVersion, resetSessionKey, type OpenedDoc } from '../src/core/crypto'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { joinDoc } from '../src/core/doc-records'
import { newStamp } from '../src/core/file-stamp'
import type { FileSession } from '../src/core/fs'
import type { Doc } from '../src/core/types'

const fsMocks = vi.hoisted(() => ({ writeFile: vi.fn(async (_s: unknown, _b: Uint8Array) => {}), downloadFallback: vi.fn() }))
vi.mock('../src/core/fs', () => fsMocks)
const modal = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modal)

const SECRET = 'a-distinctive-note-9917'
const IMG = 'a'.repeat(32)

let db: LiveDb
let written: Uint8Array
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  resetSessionKey()
  modal.toast.mockReset()
  fsMocks.writeFile.mockReset().mockImplementation(async (_s, bytes) => { written = bytes })
  db = await openLiveDb(new IDBFactory())
})
afterEach(() => { vi.unstubAllGlobals() })

function everythingReadable(v: unknown): string {
  if (ArrayBuffer.isView(v)) return String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
  if (Array.isArray(v)) return v.map(everythingReadable).join('\n')
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => k + '\n' + everythingReadable(x)).join('\n')
  return String(v)
}
const rawDump = async (docId: string): Promise<string> => {
  const all = await db.readAll(docId)
  return everythingReadable([all.records, all.blobs, await db.getMeta(docId)])
}

interface Rig { store: Store; persister: LivePersister; doc: Doc; changePassword: (pw: string | null) => Promise<void>; setPw: () => string | null }

/** An open document under `password` (null: plain), its browser copy in the real store, and the real change-password flow. */
async function rig(password: string | null): Promise<Rig> {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.dailyNotes['2026-07-01'] = SECRET
  team.generalNotes = `![x](img:${IMG})`
  doc.teams.push(team)
  doc.images[IMG] = { mime: 'image/webp', w: 1, h: 1, bytes: 4 }
  const images = createImageStore(password === null ? null : await blobCodec(password))
  images.putPlain(IMG, new Uint8Array([1, 2, 3, 4]))
  const store = createStore(doc, images)
  const codec = password === null ? null : await recordCodec(password, images.codec()?.header?.salt)
  const live = createLiveStore(db, doc.docId, codec)
  const persister = await createLivePersister({ store, live, fileName: 'f.tmv', schedule: () => () => {}, fromFile: newStamp() })
  let current = password
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'f.tmv', lastModified: 1 }
  const changePassword = createChangePassword({
    store, session, shell: { setTitle: vi.fn() } as never, persister,
    runExclusive: (fn) => fn(), getPassword: () => current, setPassword: (pw) => { current = pw },
    onBrowserCopyRekeyFailed: () => modal.toast('rekey-failed'),
  })
  return { store, persister, doc, changePassword, setPw: () => current }
}

/** Opens the file that was just written, the way the start screen does, against the browser copy. */
async function reopen(password: string | null, asks: { pw?: (string | null)[] } = {}) {
  const opened: OpenedDoc = password === null ? parsePlainWithVersion(written)! : await decryptDocumentWithVersion(written, password)
  const queue = [...(asks.pw ?? [])]
  const askBrowserPassword = vi.fn(async () => queue.shift() ?? null)
  const result = await resolveOpen({
    db, opened, password, fileName: 'f.tmv',
    askOlderFile: async () => 'browser', askBothChanged: async () => 'browser', askBrowserPassword, confirmDiscardCopy: async () => {},
    createStore: (doc, images) => createStore(doc, images),
  })
  return { result, askBrowserPassword }
}

test('after a change the browser copy opens with the new password, silently, and the old one no longer verifies', async () => {
  const r = await rig('old-pw')
  await r.changePassword('new-pw')
  expect(r.setPw()).toBe('new-pw')

  const meta = (await db.getMeta(r.doc.docId))!
  expect(await (await recordCodec('new-pw', meta.salt!)).verifyCheck(meta.check!)).toBe(true)
  expect(await (await recordCodec('old-pw', meta.salt!)).verifyCheck(meta.check!)).toBe(false)

  resetSessionKey()
  const { result, askBrowserPassword } = await reopen('new-pw')
  expect(result.source).toBe('file') // identical: nothing was unwritten after the file write
  expect(askBrowserPassword).not.toHaveBeenCalled()
  const stored = joinDoc((await createLiveStore(db, r.doc.docId, await recordCodec('new-pw', meta.salt!)).load()).records)
  expect(stored.teams[0]!.dailyNotes['2026-07-01']).toBe(SECRET)
  expect(await rawDump(r.doc.docId)).not.toContain(SECRET)
}, 240000)

test('an edit made after the change is kept under the new key and found on the next open', async () => {
  const r = await rig('old-pw')
  await r.changePassword('new-pw')
  r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-02'] = 'written after the change' })
  await r.persister.flush()

  resetSessionKey()
  const { result, askBrowserPassword } = await reopen('new-pw')
  expect(result.source).toBe('browser')
  expect(askBrowserPassword).not.toHaveBeenCalled()
  expect(result.password).toBe('new-pw')
  expect(result.doc.teams[0]!.dailyNotes['2026-07-02']).toBe('written after the change')
}, 240000)

test('the image blobs move to the new key too: the reopened browser copy shows the picture', async () => {
  const r = await rig('old-pw')
  await r.changePassword('new-pw')
  r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-03'] = 'edit' })
  await r.persister.flush()
  resetSessionKey()
  const { result } = await reopen('new-pw')
  expect(result.source).toBe('browser')
  expect(Array.from((await result.images.getPlain(IMG))!)).toEqual([1, 2, 3, 4])
}, 240000)

test('a failed file write leaves the file key AND the browser key as they were', async () => {
  const r = await rig('old-pw')
  const before = await db.getMeta(r.doc.docId)
  fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'))
  await expect(r.changePassword('new-pw')).rejects.toThrow('disk full')
  expect(r.setPw()).toBe('old-pw')

  const meta = (await db.getMeta(r.doc.docId))!
  expect(Array.from(meta.salt!)).toEqual(Array.from(before!.salt!))
  expect(await (await recordCodec('old-pw', meta.salt!)).verifyCheck(meta.check!)).toBe(true)
  // and the app still writes consistently under the old key afterwards (fork-after-reset scenario)
  resetSessionKey()
  r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-04'] = 'still old key' })
  await r.persister.flush()
  const loaded = await createLiveStore(db, r.doc.docId, await recordCodec('old-pw', meta.salt!)).load()
  expect(joinDoc(loaded.records).teams[0]!.dailyNotes['2026-07-04']).toBe('still old key')
}, 240000)

test("a browser copy that cannot be re-keyed after a good file write is reported, keeps its old key, and on the next open is read with it and moved to the file's password", async () => {
  const r = await rig('old-pw')
  // The stamp commit goes through; the re-keying commit (the one that rewrites every record) fails.
  const realCommit = db.commit.bind(db)
  db.commit = async (id, batch) => {
    if (batch.putRecords.length > 0 && batch.meta) throw new Error('quota')
    return realCommit(id, batch)
  }
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await r.changePassword('new-pw') // the file write stands: no rejection
  spy.mockRestore()
  db.commit = realCommit

  expect(r.setPw()).toBe('new-pw')
  expect(modal.toast).toHaveBeenCalledWith('rekey-failed')
  const meta = (await db.getMeta(r.doc.docId))!
  expect(await (await recordCodec('old-pw', meta.salt!)).verifyCheck(meta.check!)).toBe(true) // still the old key, consistently

  // next open: the file is under the new password; an edit made since lives only in the old-key copy, so it asks
  r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-05'] = 'under the old key' })
  await r.persister.flush()
  resetSessionKey()
  const { result, askBrowserPassword } = await reopen('new-pw', { pw: ['old-pw'] })
  expect(askBrowserPassword).toHaveBeenCalledTimes(1)
  expect(result.source).toBe('browser')
  // the file holds the newest password, so the document continues under it: handing back the old one would silently undo the change
  expect(result.password).toBe('new-pw')
  expect(result.doc.teams[0]!.dailyNotes['2026-07-05']).toBe('under the old key')
  await result.handle.persister.flush()
  const moved = (await db.getMeta(r.doc.docId))!
  expect(await (await recordCodec('new-pw', result.images.codec()!.header!.salt)).verifyCheck(moved.check!)).toBe(true)
}, 360000)

test('plain to encrypted re-seals everything; encrypted to plain makes it readable again', async () => {
  const r = await rig(null)
  expect(await rawDump(r.doc.docId)).toContain(SECRET)
  await r.changePassword('now-secret')
  expect(await rawDump(r.doc.docId)).not.toContain(SECRET)
  const meta = (await db.getMeta(r.doc.docId))!
  expect(meta.encrypted).toBe(true)
  expect(await (await recordCodec('now-secret', meta.salt!)).verifyCheck(meta.check!)).toBe(true)

  await r.changePassword(null)
  expect(await rawDump(r.doc.docId)).toContain(SECRET)
  expect(await db.getMeta(r.doc.docId)).toMatchObject({ encrypted: false, salt: null, check: null })
  resetSessionKey()
  const { result } = await reopen(null)
  expect(result.source).toBe('file')
}, 360000)
