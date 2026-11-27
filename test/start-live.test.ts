// start.ts against the real reconcile step and a real (fake-indexeddb) browser database: what a user sees
// when opening or creating a file while the browser may already hold a copy of the document.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { showStartScreen } from '../src/ui/start'
import type { OpenedDocument } from '../src/ui/open-document'
import { openLiveDb, type LiveDb } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { serializePlain, parsePlainWithVersion } from '../src/core/crypto'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { joinDoc } from '../src/core/doc-records'
import { newStamp } from '../src/core/file-stamp'
import { OpenCancelled } from '../src/core/live-open'
import type { FileSession } from '../src/core/fs'
import type { Doc } from '../src/core/types'

const fsMocks = vi.hoisted(() => ({
  FilePermissionError: class FilePermissionError extends Error {},
  FileMissingError: class FileMissingError extends Error {},
  PermissionNeedsClickError: class PermissionNeedsClickError extends Error { constructor(readonly fileName: string) { super() } },
  supportsFsApi: true,
  pickOpen: vi.fn(),
  pickCreate: vi.fn(),
  reopenLast: vi.fn(),
  writeFile: vi.fn(async (_s: unknown, _b: Uint8Array) => {}),
  downloadFallback: vi.fn(),
  openFromHandle: vi.fn(),
  hasReadWriteAccess: vi.fn(async (_handle: unknown) => false),
}))
vi.mock('../src/core/fs', () => fsMocks)
// A working key/value store: core/file-identity.ts keeps its file registry there, so one file keeps one id across opens.
const idbData = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../src/core/idb', () => ({ idbGet: vi.fn(async (k: string) => idbData.get(k)), idbSet: vi.fn(async (k: string, v: unknown) => { idbData.set(k, v) }) }))
const dialogs = vi.hoisted(() => ({ askOlderFile: vi.fn(), askBothChanged: vi.fn(), askOtherFile: vi.fn() }))
vi.mock('../src/ui/reconcile-dialogs', () => dialogs)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const handle = { isSameEntry: async (other: unknown) => other === handle } as unknown as FileSystemFileHandle
const session: FileSession = { handle, name: 'team.tmv', lastModified: 1 }

let db: LiveDb
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  idbData.clear()
  document.body.innerHTML = '<div id="app"></div>'
  db = await openLiveDb(new IDBFactory())
  fsMocks.pickOpen.mockReset()
  fsMocks.pickCreate.mockReset()
  fsMocks.writeFile.mockClear()
  fsMocks.hasReadWriteAccess.mockReset().mockResolvedValue(false)
  dialogs.askOlderFile.mockReset().mockResolvedValue('browser')
  dialogs.askBothChanged.mockReset().mockResolvedValue('browser')
})
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

function docWith(note: string, docId?: string): Doc {
  const doc = createEmptyDocument('en-US')
  if (docId) doc.docId = docId
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.dailyNotes['2026-07-01'] = note
  doc.teams.push(team)
  return doc
}

async function openFile(doc: Doc, stamp = newStamp()): Promise<{ opened: Promise<OpenedDocument | null>; stamp: ReturnType<typeof newStamp> }> {
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: await serializePlain(doc, undefined, undefined, stamp) })
  let resolve!: (o: OpenedDocument | null) => void
  const opened = new Promise<OpenedDocument | null>((r) => { resolve = r })
  showStartScreen('en-US', (o) => resolve(o), { liveDb: async () => db })
  await flush()
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Open file…')!.click()
  // a cancelled question never calls onOpen: settle the promise with null after the flow has had time to finish
  setTimeout(() => resolve(null), 200)
  return { opened, stamp }
}

const storedDoc = async (docId: string): Promise<Doc> => joinDoc((await createLiveStore(db, docId, null).load()).records)

test('opening a file with no browser copy imports it: the app gets a handle whose store follows the document', async () => {
  const doc = docWith('from file')
  const { opened, stamp } = await openFile(doc)
  const o = (await opened)!
  expect(o.session).toBe(session)
  expect(o.handle).not.toBeNull()
  expect(o.needsFileWrite).toBe(false)
  expect(o.stamp).toEqual(stamp)
  expect(await storedDoc(doc.docId)).toEqual(o.doc)
  expect((await db.getMeta(doc.docId))!.lastWriteId).toBe(stamp.writeId)
  o.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'typed' })
  await o.handle!.persister.flush()
  expect((await storedDoc(doc.docId)).teams[0]!.dailyNotes['2026-07-01']).toBe('typed')
})

test('opening a file whose browser copy has unwritten edits loads the copy and asks for the file to be rewritten', async () => {
  const doc = docWith('old')
  const first = (await (await openFile(doc)).opened)!
  first.store.update((d) => { d.teams[0]!.dailyNotes['2026-07-01'] = 'newer in browser' })
  await first.handle!.persister.flush()
  first.handle!.persister.dispose()
  const stamp = first.stamp!
  document.body.innerHTML = '<div id="app"></div>'

  const second = (await (await openFile(doc, stamp)).opened)!
  expect(second.needsFileWrite).toBe(true)
  expect(second.store.dirty).toBe(true)
  expect(second.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('newer in browser')
})

test('a file changed elsewhere while the browser holds unwritten edits asks; cancelling leaves the start screen', async () => {
  const doc = docWith('base')
  const first = (await (await openFile(doc)).opened)!
  first.store.update((d) => { d.nav.split = true })
  await first.handle!.persister.flush()
  first.handle!.persister.dispose()
  document.body.innerHTML = '<div id="app"></div>'

  dialogs.askBothChanged.mockRejectedValue(new OpenCancelled())
  const result = await (await openFile(docWith('elsewhere', doc.docId))).opened
  expect(dialogs.askBothChanged).toHaveBeenCalledWith('en-US')
  expect(result).toBeNull()
  expect(document.querySelector('.tt-start-screen')).not.toBeNull()
  expect(document.querySelector('.tt-start-opening')!.textContent).toBe('')
})

test('creating a file writes a stamped file and registers the document in the browser store', async () => {
  fsMocks.pickCreate.mockResolvedValue(session)
  let resolve!: (o: OpenedDocument) => void
  const opened = new Promise<OpenedDocument>((r) => { resolve = r })
  showStartScreen('en-US', (o) => resolve(o), { liveDb: async () => db })
  await flush()
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Create new…')!.click()
  await flush()
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Create without password')!.click()
  const o = await opened

  const written = fsMocks.writeFile.mock.calls[0]![1]
  const parsed = parsePlainWithVersion(written)!
  expect(parsed.stamp).not.toBeNull()
  expect(o.stamp).toEqual(parsed.stamp)
  expect(parsed.doc.docId).toBe(o.doc.docId)
  const meta = (await db.getMeta(o.doc.docId))!
  expect(meta.lastWriteId).toBe(parsed.stamp!.writeId)
  expect(meta.unwrittenChanges).toBe(false)
})

test('without browser storage the file still opens, from the file alone', async () => {
  const doc = docWith('x')
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: await serializePlain(doc) })
  let resolve!: (o: OpenedDocument | null) => void
  const opened = new Promise<OpenedDocument | null>((r) => { resolve = r })
  showStartScreen('en-US', (o) => resolve(o), { liveDb: async () => null })
  await flush()
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Open file…')!.click()
  const o = (await opened)!
  expect(o.handle).toBeNull()
  expect(o.doc.teams[0]!.dailyNotes['2026-07-01']).toBe('x')
})

test('while the browser storage is answering, the start screen says which file is opening', async () => {
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: await serializePlain(docWith('base')) })
  let answer!: (d: LiveDb) => void
  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen, { liveDb: () => new Promise<LiveDb>((r) => { answer = r }) })
  const status = document.querySelector('.tt-start-opening')!
  expect(status.getAttribute('role')).toBe('status')
  expect(status.textContent).toBe('')
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Open file…')!.click()
  await flush()
  expect(status.textContent).toBe('Opening team.tmv…')
  answer(db)
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalled())
  expect(status.textContent).toBe('')
})

describe('overlapping opens', () => {
  const sessionB: FileSession = { handle: { isSameEntry: async () => false } as unknown as FileSystemFileHandle, name: 'other.tmv', lastModified: 1 }
  const openBtn = (): HTMLButtonElement => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Open file…')!

  test('the file chosen last opens, even when the one chosen first finishes later; the reconciles run one at a time', async () => {
    fsMocks.pickOpen
      .mockResolvedValueOnce({ session, bytes: await serializePlain(docWith('first')) })
      .mockResolvedValueOnce({ session: sessionB, bytes: await serializePlain(docWith('second')) })
    // The first open's browser storage stalls; the second one's answers at once.
    let answerFirst!: (d: LiveDb) => void
    const liveDb = vi.fn()
      .mockImplementationOnce(() => new Promise<LiveDb>((r) => { answerFirst = r }))
      .mockImplementation(async () => db)
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen, { liveDb })
    const status = document.querySelector('.tt-start-opening')!
    openBtn().click()
    await flush()
    openBtn().click()
    await flush()
    expect(status.textContent).toBe('Opening other.tmv…')
    // The second waits for the first's reconcile instead of running beside it.
    expect(liveDb).toHaveBeenCalledTimes(1)
    answerFirst(db)
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled())
    await flush()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0]![0] as OpenedDocument).session).toBe(sessionB)
    expect(status.textContent).toBe('')
  })

  test('a picker the user cancels takes nothing from the open already under way', async () => {
    fsMocks.pickOpen
      .mockResolvedValueOnce({ session, bytes: await serializePlain(docWith('first')) })
      .mockResolvedValueOnce(null)
    let answer!: (d: LiveDb) => void
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen, { liveDb: () => new Promise<LiveDb>((r) => { answer = r }) })
    openBtn().click()
    await flush()
    openBtn().click()
    await flush()
    answer(db)
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect((onOpen.mock.calls[0]![0] as OpenedDocument).session).toBe(session)
  })
})
