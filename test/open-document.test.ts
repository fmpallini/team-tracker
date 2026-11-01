import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveDb } from '../src/core/live-db'
import { reconcileOpen } from '../src/ui/open-document'
import { OpenCancelled } from '../src/core/live-open'
import { createImageStore } from '../src/core/image-store'
import { createLiveStore } from '../src/core/live-store'
import { createEmptyDocument, createEmptyTeam, SCHEMA_VERSION } from '../src/core/document'
import { joinDoc } from '../src/core/doc-records'
import { newStamp } from '../src/core/file-stamp'
import { t } from '../src/core/i18n'
import type { FileSession } from '../src/core/fs'
import type { Doc } from '../src/core/types'

const dialogs = vi.hoisted(() => ({ askOlderFile: vi.fn(), askBothChanged: vi.fn(), askOtherFile: vi.fn() }))
vi.mock('../src/ui/reconcile-dialogs', () => dialogs)
// Each session's file id is its handle's `entry` (core/file-identity.ts is unit-tested on its own).
const identity = vi.hoisted(() => ({ resolveFileId: vi.fn(async (s: { handle: { entry?: string } | null }) => s.handle?.entry ?? null) }))
vi.mock('../src/core/file-identity', () => identity)
const modal = vi.hoisted(() => ({ toast: vi.fn(), promptPassword: vi.fn() }))
vi.mock('../src/ui/modal', () => modal)

let db: LiveDb
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  db = await openLiveDb(new IDBFactory())
  dialogs.askOlderFile.mockReset().mockResolvedValue('browser')
  dialogs.askBothChanged.mockReset().mockResolvedValue('browser')
  dialogs.askOtherFile.mockReset().mockResolvedValue('separate')
  modal.toast.mockReset()
  modal.promptPassword.mockReset()
})
afterEach(() => { vi.unstubAllGlobals() })

const session: FileSession = { handle: null, name: 'f.tmv', lastModified: 1 }

function docWith(note: string, docId?: string): Doc {
  const doc = createEmptyDocument('en-US')
  if (docId) doc.docId = docId
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.dailyNotes['2026-07-01'] = note
  doc.teams.push(team)
  return doc
}
const fileOf = (doc: Doc, stamp = newStamp()) => ({ doc: JSON.parse(JSON.stringify(doc)) as Doc, preSchemaVersion: SCHEMA_VERSION, images: createImageStore(null), stamp })

test('with no browser database the document opens from the file alone, and the user is told', async () => {
  const doc = docWith('x')
  const r = (await reconcileOpen({ locale: 'en-US', db: null, session, opened: fileOf(doc), password: null }))!
  expect(r.handle).toBeNull()
  expect(r.needsFileWrite).toBe(false)
  expect(r.store.doc).toBe(r.doc)
  expect(r.password).toBeNull()
  expect(modal.toast).toHaveBeenCalledWith(t('en-US', 'live_store_unavailable_toast'), expect.objectContaining({ sticky: true }))
})

test('a new document is imported: the store the app gets is the one the browser copy follows', async () => {
  const doc = docWith('imported')
  const r = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc), password: null }))!
  expect(r.handle).not.toBeNull()
  expect(r.session).toBe(session)
  r.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'edited' })
  await r.handle!.persister.flush()
  const stored = joinDoc((await createLiveStore(db, doc.docId, null).load()).records)
  expect(stored.teams[0]!.dailyNotes['2026-07-01']).toBe('edited')
})

test('an unwritten browser copy wins and the result says the file must be rewritten', async () => {
  const doc = docWith('old')
  const stamp = newStamp()
  const first = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc, stamp), password: null }))!
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'newer in browser' })
  await first.handle!.persister.flush()
  first.handle!.persister.dispose()

  const r = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc, stamp), password: null }))!
  expect(r.needsFileWrite).toBe(true)
  expect(r.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('newer in browser')
  expect(r.store.dirty).toBe(true)
})

test('the both-changed question is asked in the start-screen locale; cancelling it opens nothing', async () => {
  const doc = docWith('base')
  const first = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc), password: null }))!
  first.store.update((d) => { d.nav.split = true })
  await first.handle!.persister.flush()
  first.handle!.persister.dispose()

  dialogs.askBothChanged.mockRejectedValue(new OpenCancelled())
  const r = await reconcileOpen({ locale: 'pt-BR', db, session, opened: fileOf(docWith('elsewhere', doc.docId)), password: null })
  expect(r).toBeNull()
  expect(dialogs.askBothChanged).toHaveBeenCalledWith('pt-BR')
})

test('the older-file question is asked when the file predates a write this browser made', async () => {
  const doc = docWith('A')
  const stampA = newStamp(), stampB = newStamp()
  const first = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc, stampA), password: null }))!
  await first.handle!.persister.markFileWritten(stampB)
  first.handle!.persister.dispose()
  await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc, stampA), password: null })
  expect(dialogs.askOlderFile).toHaveBeenCalledWith('en-US')
})

test('another unexpected failure is not swallowed as a cancel', async () => {
  const doc = docWith('base')
  const first = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc), password: null }))!
  first.store.update((d) => { d.nav.split = true })
  await first.handle!.persister.flush()
  first.handle!.persister.dispose()
  dialogs.askBothChanged.mockRejectedValue(new Error('boom'))
  await expect(reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(docWith('e', doc.docId)), password: null })).rejects.toThrow('boom')
})

describe('where the Web Locks API exists, opening touches nothing until this tab holds the write lock', () => {
  beforeEach(() => { Object.defineProperty(navigator, 'locks', { value: {}, configurable: true }) })
  afterEach(() => { delete (navigator as unknown as { locks?: unknown }).locks })

  test('the store starts read-only and the browser copy of an existing document is left alone', async () => {
    const doc = docWith('first tab')
    const stamp = newStamp()
    const first = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(doc, stamp), password: null }))!
    first.store.setReadOnly(false) // the first tab got the lock
    await first.handle!.persister.flush()
    first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'edited by the lock holder' })
    await first.handle!.persister.flush()

    // A second tab opens the same file (older content, unknown stamp): it must not delete or rewrite anything.
    const second = (await reconcileOpen({ locale: 'en-US', db, session, opened: fileOf(docWith('stale file', doc.docId)), password: null }))!
    expect(second.store.readOnly).toBe(true)
    const stored = joinDoc((await createLiveStore(db, doc.docId, null).load()).records)
    expect(stored.teams[0]!.dailyNotes['2026-07-01']).toBe('edited by the lock holder')
  })
})

test('another file of the document is told apart by its file id, and the question names the copy\'s own file', async () => {
  const fileA: FileSession = { handle: { entry: 'disk/a' } as unknown as FileSystemFileHandle, name: 'team.tmv', lastModified: 1 }
  const fileB: FileSession = { handle: { entry: 'disk/b' } as unknown as FileSystemFileHandle, name: 'team (1).tmv', lastModified: 1 }
  const doc = docWith('base')
  const stamp = newStamp()
  const first = (await reconcileOpen({ locale: 'en-US', db, session: fileA, opened: fileOf(doc, stamp), password: null }))!
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'unwritten' })
  await first.handle!.persister.flush()
  first.handle!.persister.dispose()

  const r = (await reconcileOpen({ locale: 'pt-BR', db, session: fileB, opened: fileOf(doc, stamp), password: null }))!
  expect(dialogs.askOtherFile).toHaveBeenCalledWith('pt-BR', 'team.tmv')
  expect(r.doc.docId).not.toBe(doc.docId)
  expect(r.needsFileWrite).toBe(true)
  await r.handle!.persister.flush()
  expect((await db.getMeta(r.doc.docId))!.fileId).toBe('disk/b')
})
