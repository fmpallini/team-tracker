import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveBatch, type LiveDb, type LiveMeta } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { decideOpen, resolveOpen, OpenCancelled, type Reconciled } from '../src/core/live-open'
import { createStore } from '../src/core/store'
import { createImageStore, type ImageStore } from '../src/core/image-store'
import { blobCodec, recordCodec, resetSessionKey, type OpenedDoc } from '../src/core/crypto'
import { createEmptyDocument, createEmptyTeam, SCHEMA_VERSION } from '../src/core/document'
import { joinDoc, splitDoc } from '../src/core/doc-records'
import { newStamp, type FileStamp } from '../src/core/file-stamp'
import type { Doc } from '../src/core/types'

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

const base = (over: Partial<LiveMeta> = {}): LiveMeta => ({
  docId: 'd', encrypted: false, salt: null, check: null, keySecret: new Uint8Array(16), lastWriteId: 'W2', knownWriteIds: ['W2', 'W1'],
  unwrittenChanges: false, schemaVersion: SCHEMA_VERSION, fileName: 'f.tmv', modifiedAt: 1, lastFileWriteAt: null, ...over,
})
const file = (writeId: string | null) => ({ docId: 'd', stamp: writeId ? { writeId, savedAt: 1 } : null })

describe('decideOpen', () => {
  test('no browser copy: import', () => {
    expect(decideOpen(file('W2'), undefined)).toBe('import')
  })
  test('same write, nothing unwritten: identical', () => {
    expect(decideOpen(file('W2'), base())).toBe('identical')
  })
  test('same write, unwritten changes: the browser is newer', () => {
    expect(decideOpen(file('W2'), base({ unwrittenChanges: true }))).toBe('browser-newer')
  })
  test('a write this browser knows but is not the latest: ask about the older file', () => {
    expect(decideOpen(file('W1'), base())).toBe('ask-older-file')
    expect(decideOpen(file('W1'), base({ unwrittenChanges: true }))).toBe('ask-older-file')
  })
  test('an unknown write, nothing unwritten: the file came from elsewhere', () => {
    expect(decideOpen(file('Wx'), base())).toBe('file-from-elsewhere')
  })
  test('an unknown write with unwritten changes: both changed', () => {
    expect(decideOpen(file('Wx'), base({ unwrittenChanges: true }))).toBe('ask-both-changed')
  })
  test('a file with no stamp is an unknown write', () => {
    expect(decideOpen(file(null), base())).toBe('file-from-elsewhere')
    expect(decideOpen(file(null), base({ unwrittenChanges: true }))).toBe('ask-both-changed')
  })
  test('a copy that never saw a file write does not match a stamp-less file as identical', () => {
    expect(decideOpen(file(null), base({ lastWriteId: null, knownWriteIds: [] }))).toBe('file-from-elsewhere')
  })
})

// --- resolveOpen against a real (fake-indexeddb) store ----------------------------------------------

let rawDb: LiveDb
let db: LiveDb
let commits: LiveBatch[]
let reads: number
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  resetSessionKey()
  modalMocks.toast.mockReset()
  rawDb = await openLiveDb(new IDBFactory())
  commits = []
  reads = 0
  db = { ...rawDb, commit: (id, b) => { commits.push(b); return rawDb.commit(id, b) }, readAll: (id) => { reads++; return rawDb.readAll(id) } }
})
afterEach(() => { vi.unstubAllGlobals() })

function docWith(note: string, docId?: string): Doc {
  const doc = createEmptyDocument('en-US')
  if (docId) doc.docId = docId
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.dailyNotes['2026-07-01'] = note
  doc.teams.push(team)
  return doc
}

async function opened(doc: Doc, stamp: FileStamp | null, password: string | null = null): Promise<OpenedDoc> {
  const images = createImageStore(password === null ? null : await blobCodec(password))
  return { doc: JSON.parse(JSON.stringify(doc)) as Doc, preSchemaVersion: SCHEMA_VERSION, images, stamp }
}

interface Asks { older: ReturnType<typeof vi.fn>; both: ReturnType<typeof vi.fn>; pw: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> }
function asks(over: { older?: 'browser' | 'file'; both?: 'browser' | 'file' | 'cancel'; pw?: (string | null)[]; discard?: 'cancel' } = {}): Asks {
  const passwords = [...(over.pw ?? [])]
  return {
    older: vi.fn(async () => over.older ?? 'browser'),
    both: vi.fn(async () => { if (over.both === 'cancel') throw new OpenCancelled(); return over.both ?? 'browser' }),
    pw: vi.fn(async () => passwords.shift() ?? null),
    discard: vi.fn(async () => { if (over.discard === 'cancel') throw new OpenCancelled() }),
  }
}

function open(o: OpenedDoc, password: string | null, a: Asks): Promise<Reconciled> {
  return resolveOpen({
    db, opened: o, password, fileName: 'f.tmv',
    askOlderFile: a.older as never, askBothChanged: a.both as never, askBrowserPassword: a.pw as never, confirmDiscardCopy: a.discard as never,
    createStore: (doc, images) => createStore(doc, images),
  })
}

const stored = async (docId: string, codec = null as Awaited<ReturnType<typeof recordCodec>> | null): Promise<Doc> =>
  joinDoc((await createLiveStore(rawDb, docId, codec).load()).records)

test('a document with no browser copy is imported: the file wins and the lineage starts at its stamp', async () => {
  const doc = docWith('from file')
  const stamp = newStamp()
  const r = await open(await opened(doc, stamp), null, asks())
  expect(r.source).toBe('file')
  expect(r.needsFileWrite).toBe(false)
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('from file')
  expect(await stored(doc.docId)).toEqual(r.doc)
  expect(await rawDb.getMeta(doc.docId)).toMatchObject({ lastWriteId: stamp.writeId, unwrittenChanges: false, fileName: 'f.tmv' })
})

test('a file from before the current schema is written back at once, so the docId it was just given is not lost with the tab', async () => {
  const doc = docWith('old schema')
  const old = await opened(doc, null)
  old.preSchemaVersion = SCHEMA_VERSION - 1 // what a 3.1.x file reports: migration just minted this docId
  const r = await open(old, null, asks())
  expect(r.needsFileWrite).toBe(true)
  expect(r.store.dirty).toBe(true)
  // a file already at the current schema needs nothing
  const current = await open(await opened(docWith('current'), newStamp()), null, asks())
  expect(current.needsFileWrite).toBe(false)
  expect(current.store.dirty).toBe(false)
})

test('the returned store is the one the persister watches', async () => {
  const doc = docWith('x')
  const r = await open(await opened(doc, newStamp()), null, asks())
  r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'edited' })
  await r.handle.persister.flush()
  expect((await stored(doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('edited')
})

test('opening the same file again is identical: nothing is rewritten', async () => {
  const doc = docWith('same')
  const stamp = newStamp()
  await open(await opened(doc, stamp), null, asks())
  commits.length = 0
  const a = asks()
  const r = await open(await opened(doc, stamp), null, a)
  expect(r.source).toBe('file')
  expect(r.needsFileWrite).toBe(false)
  expect(commits.every((b) => b.putRecords.length === 0 && b.deleteRecords.length === 0)).toBe(true)
  expect(a.older).not.toHaveBeenCalled()
  expect(a.both).not.toHaveBeenCalled()
})

describe.each([['password-less', null], ['encrypted', 'correct horse']] as const)('opening a file the browser copy already matches (%s)', (_label, password) => {
  const IMG = 'a'.repeat(32)
  async function withImage(doc: Doc, stamp: FileStamp): Promise<OpenedDoc> {
    const o = await opened(doc, stamp, password)
    o.doc.images[IMG] = { mime: 'image/webp', w: 1, h: 1, bytes: 3 }
    o.doc.teams[0]!.dailyNotes['2026-07-02'] = `![p](img:${IMG})`
    o.images.putPlain(IMG, new Uint8Array([1, 2, 3]))
    return o
  }

  test('reads no stored row and no image bytes, and still writes only what is edited afterwards', async () => {
    const doc = docWith('same')
    const stamp = newStamp()
    const first = await open(await withImage(doc, stamp), password, asks())
    await first.handle.persister.flush()
    first.handle.persister.dispose()

    reads = 0
    commits.length = 0
    const r = await open(await withImage(doc, stamp), password, asks())
    expect(r.source).toBe('file')
    expect(reads).toBe(0)
    expect(modalMocks.toast).not.toHaveBeenCalled()
    await r.handle.persister.flush()
    expect(commits).toHaveLength(0)

    r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'edited' })
    await r.handle.persister.flush()
    expect(commits).toHaveLength(1)
    expect(commits[0]!.putRecords).toHaveLength(1)
    expect(commits[0]!.deleteRecords).toHaveLength(0)
    expect(commits[0]!.putBlobs).toHaveLength(0)
    expect(await stored(doc.docId, password === null ? null : await recordCodec(password, r.images.codec()!.header!.salt))).toEqual(r.doc)
  }, 60000)

  test('the swept-away image stays out and the kept one is not written again', async () => {
    const doc = docWith('same')
    const stamp = newStamp()
    const first = await open(await withImage(doc, stamp), password, asks())
    await first.handle.persister.flush()
    first.handle.persister.dispose()
    const r = await open(await withImage(doc, stamp), password, asks())
    r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-03'] = 'unrelated' })
    commits.length = 0
    await r.handle.persister.flush()
    expect(commits.flatMap((b) => b.putBlobs)).toHaveLength(0)
  }, 60000)

  test('a copy that lost a row is not trusted: the file replaces it and the user is told', async () => {
    const doc = docWith('same')
    const stamp = newStamp()
    const first = await open(await withImage(doc, stamp), password, asks())
    await first.handle.persister.flush()
    first.handle.persister.dispose()
    const row = (await rawDb.readAll(doc.docId)).records[0]!
    await rawDb.commit(doc.docId, { putRecords: [], deleteRecords: [row.key], putBlobs: [], deleteBlobs: [] })

    const o = await withImage(doc, stamp)
    const r = await open(o, password, asks())
    expect(modalMocks.toast).toHaveBeenCalled()
    await r.handle.persister.flush()
    expect((await rawDb.readAll(doc.docId)).records).toHaveLength(splitDoc(r.doc).size)
    expect(await stored(doc.docId, password === null ? null : await recordCodec(password, o.images.codec()!.header!.salt))).toEqual(r.doc)
  }, 60000)

  test('a copy from another schema version is replaced by the file without a word', async () => {
    const doc = docWith('same')
    const stamp = newStamp()
    const first = await open(await withImage(doc, stamp), password, asks())
    await first.handle.persister.flush()
    first.handle.persister.dispose()
    const meta = (await rawDb.getMeta(doc.docId))!
    await rawDb.commit(doc.docId, { putRecords: [], deleteRecords: [], putBlobs: [], deleteBlobs: [], meta: { ...meta, schemaVersion: SCHEMA_VERSION - 1 } })

    const r = await open(await withImage(doc, stamp), password, asks())
    await r.handle.persister.flush()
    expect(modalMocks.toast).not.toHaveBeenCalled()
    expect((await rawDb.getMeta(doc.docId))!.schemaVersion).toBe(SCHEMA_VERSION)
  }, 60000)

  test('a copy written by an earlier build (no key secret) is replaced by the file and the user is told', async () => {
    const doc = docWith('same')
    const stamp = newStamp()
    const first = await open(await withImage(doc, stamp), password, asks())
    await first.handle.persister.flush()
    first.handle.persister.dispose()
    const old: Partial<LiveMeta> = { ...(await rawDb.getMeta(doc.docId))! }
    delete old.keySecret
    await rawDb.commit(doc.docId, { putRecords: [], deleteRecords: [], putBlobs: [], deleteBlobs: [], meta: old as LiveMeta })

    const r = await open(await withImage(doc, stamp), password, asks())
    await r.handle.persister.flush()
    expect(modalMocks.toast).toHaveBeenCalled()
    expect((await rawDb.getMeta(doc.docId))!.keySecret).toBeDefined()
  }, 60000)
})

test('only a document opened from the browser copy starts ahead of its file', async () => {
  const doc = docWith('old')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  expect(first.store.dirty).toBe(false)
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'newer' })
  await first.handle.persister.flush()
  first.handle.persister.dispose()
  const second = await open(await opened(doc, stamp), null, asks())
  expect(second.source).toBe('browser')
  expect(second.store.dirty).toBe(true)
})

test('a browser copy with unwritten edits beats the same-stamped file and asks for the file to be rewritten', async () => {
  const doc = docWith('old')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'newer in browser' })
  await first.handle.persister.flush()
  first.handle.persister.dispose()

  const r = await open(await opened(doc, stamp), null, asks())
  expect(r.source).toBe('browser')
  expect(r.needsFileWrite).toBe(true)
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('newer in browser')
  expect(r.password).toBeNull()
})

async function twoWrites() {
  const doc = docWith('version A')
  const stampA = newStamp(), stampB = newStamp()
  const first = await open(await opened(doc, stampA), null, asks())
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'version B' })
  await first.handle.persister.flush()
  await first.handle.persister.markFileWritten(stampB, first.store.rev)
  first.handle.persister.dispose()
  return { docA: doc, stampA }
}

test('an older file than the browser produced asks; keeping the browser copy loads it and rewrites the file', async () => {
  const { docA, stampA } = await twoWrites()
  const a = asks({ older: 'browser' })
  const r = await open(await opened(docA, stampA), null, a)
  expect(a.older).toHaveBeenCalledTimes(1)
  expect(r.source).toBe('browser')
  expect(r.needsFileWrite).toBe(true)
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('version B')
})

test('an older file than the browser produced asks; choosing the file replaces the browser copy', async () => {
  const { docA, stampA } = await twoWrites()
  const r = await open(await opened(docA, stampA), null, asks({ older: 'file' }))
  expect(r.source).toBe('file')
  expect(r.needsFileWrite).toBe(false)
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('version A')
  expect((await stored(docA.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('version A')
  expect((await rawDb.getMeta(docA.docId))!.lastWriteId).toBe(stampA.writeId)
})

async function unwrittenCopy() {
  const doc = docWith('base')
  const first = await open(await opened(doc, newStamp()), null, asks())
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'browser edit' })
  await first.handle.persister.flush()
  first.handle.persister.dispose()
  const fromElsewhere = docWith('edited elsewhere', doc.docId)
  return { fromElsewhere }
}

test('an unknown file while the browser has unwritten edits asks; each answer is honoured', async () => {
  const { fromElsewhere } = await unwrittenCopy()
  const keep = asks({ both: 'browser' })
  const kept = await open(await opened(fromElsewhere, newStamp()), null, keep)
  expect(keep.both).toHaveBeenCalledTimes(1)
  expect(kept.source).toBe('browser')
  expect(kept.needsFileWrite).toBe(true)
  expect(kept.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('browser edit')
  kept.handle.persister.dispose()

  const load = await open(await opened(fromElsewhere, newStamp()), null, asks({ both: 'file' }))
  expect(load.source).toBe('file')
  expect(load.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('edited elsewhere')
  expect((await stored(fromElsewhere.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('edited elsewhere')
})

test('cancelling the both-changed question cancels the open and leaves the browser copy alone', async () => {
  const { fromElsewhere } = await unwrittenCopy()
  await expect(open(await opened(fromElsewhere, newStamp()), null, asks({ both: 'cancel' }))).rejects.toBeInstanceOf(OpenCancelled)
  expect((await stored(fromElsewhere.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('browser edit')
})

test('an unknown file with nothing unwritten simply replaces the browser copy, without asking', async () => {
  const doc = docWith('base')
  const first = await open(await opened(doc, newStamp()), null, asks())
  first.handle.persister.dispose()
  const a = asks()
  const elsewhere = docWith('restored backup', doc.docId)
  const r = await open(await opened(elsewhere, newStamp()), null, a)
  expect(r.source).toBe('file')
  expect(a.older).not.toHaveBeenCalled()
  expect(a.both).not.toHaveBeenCalled()
  expect((await stored(doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('restored backup')
})

test('a browser copy that cannot be read is replaced by the file, with a notice', async () => {
  const doc = docWith('base')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  first.store.update((d) => { d.nav.split = true })
  await first.handle.persister.flush()
  first.handle.persister.dispose()
  await rawDb.commit(doc.docId, { putRecords: [{ key: 'garbage', value: {} }], deleteRecords: [], putBlobs: [], deleteBlobs: [] })
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const r = await open(await opened(doc, stamp), null, asks())
  expect(r.source).toBe('file')
  expect(modalMocks.toast).toHaveBeenCalledWith(expect.stringContaining('could not be read'), { kind: 'warn' })
  expect(await stored(doc.docId)).toEqual(r.doc)
})

test('a browser copy written by a newer schema is never read: the file replaces it silently when nothing is unwritten', async () => {
  const doc = docWith('base')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  first.handle.persister.dispose()
  const m = (await rawDb.getMeta(doc.docId))!
  await rawDb.commit(doc.docId, { putRecords: [], deleteRecords: [], putBlobs: [], deleteBlobs: [], meta: { ...m, schemaVersion: SCHEMA_VERSION + 1 } })
  const a = asks()
  const r = await open(await opened(doc, stamp), null, a)
  expect(r.source).toBe('file')
  expect(a.both).not.toHaveBeenCalled()
  expect((await rawDb.getMeta(doc.docId))!.schemaVersion).toBe(SCHEMA_VERSION)
})

test('a newer-schema copy with unwritten edits asks first; keeping it cancels the open (this build cannot read it)', async () => {
  const doc = docWith('base')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  first.store.update((d) => { d.nav.split = true })
  await first.handle.persister.flush()
  first.handle.persister.dispose()
  const m = (await rawDb.getMeta(doc.docId))!
  await rawDb.commit(doc.docId, { putRecords: [], deleteRecords: [], putBlobs: [], deleteBlobs: [], meta: { ...m, schemaVersion: SCHEMA_VERSION + 1 } })

  await expect(open(await opened(doc, stamp), null, asks({ both: 'browser' }))).rejects.toBeInstanceOf(OpenCancelled)
  const r = await open(await opened(doc, stamp), null, asks({ both: 'file' }))
  expect(r.source).toBe('file')
})

// --- encrypted documents -------------------------------------------------------------------------

async function encryptedCopy(password: string, note = 'secret base') {
  const doc = docWith(note)
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp, password), password, asks())
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'browser only edit' })
  await first.handle.persister.flush()
  first.handle.persister.dispose()
  return { doc, stamp }
}

test('an encrypted browser copy opens with the file\'s own password', async () => {
  const { doc, stamp } = await encryptedCopy('pw1')
  const a = asks()
  resetSessionKey()
  const r = await open(await opened(doc, stamp, 'pw1'), 'pw1', a)
  expect(r.source).toBe('browser')
  expect(r.password).toBe('pw1')
  expect(a.pw).not.toHaveBeenCalled()
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('browser only edit')
}, 120000)

test("a browser copy under another password prompts until the right one is typed; the file's password still wins and the copy is moved to it", async () => {
  const { doc, stamp } = await encryptedCopy('pw1')
  resetSessionKey()
  const a = asks({ pw: ['nope', 'pw1'] })
  const file = await opened(doc, stamp, 'pw2')
  const r = await open(file, 'pw2', a)
  expect(a.pw).toHaveBeenCalledTimes(2)
  expect(r.source).toBe('browser')
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('browser only edit')
  // The file at this write is the latest one, so its password is the latest the user set: the old copy key was drift.
  // Handing the copy's password back would silently undo a password change at the next file write.
  expect(r.password).toBe('pw2')
  expect(Array.from(r.images.codec()!.header!.salt)).toEqual(Array.from(file.images.codec()!.header!.salt))
  // the move itself waits for the write lock like the initial sync (this test store is writable)
  await r.handle.persister.flush()
  const m = (await rawDb.getMeta(doc.docId))!
  const fileCodec = await recordCodec('pw2', file.images.codec()!.header!.salt)
  expect(await fileCodec.verifyCheck(m.check!)).toBe(true)
  expect((await createLiveStore(rawDb, doc.docId, fileCodec).load()).records.size).toBeGreaterThan(0)
}, 300000)

test('a read-only tab opening a drifted copy leaves it under its old key until it holds the lock', async () => {
  const { doc, stamp } = await encryptedCopy('pw1')
  resetSessionKey()
  const roStore = (d: Doc, images: ImageStore) => { const s = createStore(d, images); s.setReadOnly(true, { silent: true }); return s }
  const file = await opened(doc, stamp, 'pw2')
  const r = await resolveOpen({
    db, opened: file, password: 'pw2', fileName: 'f.tmv',
    askOlderFile: async () => 'browser', askBothChanged: async () => 'browser', askBrowserPassword: async () => 'pw1', confirmDiscardCopy: async () => {},
    createStore: roStore,
  })
  const before = (await rawDb.getMeta(doc.docId))!
  expect(await (await recordCodec('pw1', before.salt!)).verifyCheck(before.check!)).toBe(true)
  r.store.setReadOnly(false)
  await r.handle.persister.flush()
  const after = (await rawDb.getMeta(doc.docId))!
  expect(await (await recordCodec('pw2', file.images.codec()!.header!.salt)).verifyCheck(after.check!)).toBe(true)
}, 300000)

test('a copy the user chose over an OLDER file keeps its own password: the file is the stale side there', async () => {
  const { doc, stamp } = await encryptedCopy('pw1')
  const older = { ...stamp, writeId: 'e'.repeat(32) }
  const first = (await rawDb.getMeta(doc.docId))!
  await rawDb.commit(doc.docId, { putRecords: [], deleteRecords: [], putBlobs: [], deleteBlobs: [], meta: { ...first, knownWriteIds: [...first.knownWriteIds, older.writeId] } })
  resetSessionKey()
  const a = asks({ older: 'browser', pw: ['pw1'] })
  const r = await open(await opened(doc, older, 'pw2'), 'pw2', a)
  expect(r.source).toBe('browser')
  expect(r.password).toBe('pw1')
}, 300000)

test('cancelling the browser-password prompt falls back to the file', async () => {
  const { doc, stamp } = await encryptedCopy('pw1')
  resetSessionKey()
  const a = asks({ pw: [null] })
  const r = await open(await opened(doc, stamp, 'pw2'), 'pw2', a)
  // the copy held an edit the file never got: replacing it is a choice, not a side effect
  expect(a.discard).toHaveBeenCalledTimes(1)
  expect(r.source).toBe('file')
  expect(r.password).toBe('pw2')
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('secret base')
  const meta = (await rawDb.getMeta(doc.docId))!
  expect(await (await recordCodec('pw2', meta.salt!)).verifyCheck(meta.check!)).toBe(true)
}, 180000)

test('a plain browser copy is never used for a password-protected file', async () => {
  const doc = docWith('plain base')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'plain edit' })
  await first.handle.persister.flush()
  first.handle.persister.dispose()
  resetSessionKey()
  const a = asks()
  const r = await open(await opened(doc, stamp, 'pw'), 'pw', a)
  expect(r.source).toBe('file')
  expect(a.discard).toHaveBeenCalledTimes(1)
  expect(a.pw).not.toHaveBeenCalled()
  expect((await rawDb.getMeta(doc.docId))!.encrypted).toBe(true)
}, 60000)

test('declining to discard an unusable copy that holds unwritten edits cancels the open and leaves the copy untouched', async () => {
  const { doc, stamp } = await encryptedCopy('pw1')
  resetSessionKey()
  const before = await rawDb.readAll(doc.docId)
  const a = asks({ pw: [null], discard: 'cancel' })
  await expect(open(await opened(doc, stamp, 'pw2'), 'pw2', a)).rejects.toBeInstanceOf(OpenCancelled)
  const after = await rawDb.readAll(doc.docId)
  expect(after.records).toEqual(before.records)
  expect(await rawDb.getMeta(doc.docId)).toMatchObject({ unwrittenChanges: true, encrypted: true })
}, 180000)

test('an unusable copy with nothing unwritten is replaced by the file without asking', async () => {
  const doc = docWith('plain base')
  const stamp = newStamp()
  const first = await open(await opened(doc, stamp), null, asks())
  first.handle.persister.dispose()
  // identical copy, but the file now needs a password the plain copy cannot serve
  const a = asks()
  const r = await open(await opened(doc, stamp, 'pw'), 'pw', a)
  expect(r.source).toBe('file')
  expect(a.discard).not.toHaveBeenCalled()
}, 60000)

test('a copy with no document record (what a half-removed copy looks like) is unreadable, not a crash: the file opens after the usual choice', async () => {
  const doc = docWith('from file')
  const stamp = newStamp()
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await createLiveStore(rawDb, doc.docId, null).write({
    puts: new Map([['team/T1', '{"id":"T1"}']]),
    meta: { lastWriteId: stamp.writeId, knownWriteIds: [stamp.writeId], unwrittenChanges: true, fileName: 'f.tmv' },
  })
  const a = asks()
  const r = await open(await opened(doc, stamp), null, a)
  expect(r.source).toBe('file')
  expect(a.discard).toHaveBeenCalledTimes(1)
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('from file')
  spy.mockRestore()
})
