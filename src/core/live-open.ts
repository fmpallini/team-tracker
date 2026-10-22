// src/core/live-open.ts — what happens when a file is opened and the browser may
// already hold a copy of the same document. Timestamps are never compared: they
// can be wrong, restored or identical after a copy. The decision rests on
// identity (`docId`, which keys the browser copy) and lineage (`writeId`, a fresh
// value stamped on every file write, which the copy remembers).
//
//   no browser copy                                     import the file
//   file writeId = copy's last, nothing unwritten       identical
//   file writeId = copy's last, unwritten edits         the browser copy is newer: load it, rewrite the file
//   file writeId known to the copy but not its last     an older file (restored from a backup): ask
//   file writeId unknown, nothing unwritten             the file came from elsewhere: it wins
//   file writeId unknown, unwritten edits               both changed: ask
//
// A browser copy that cannot be used is never trusted blindly: one sealed under a
// different password asks for that password (or gives up and uses the file), one
// written by a newer schema is not read at all, one that fails to open counts as absent.
import type { Doc } from './types'
import type { OpenedDoc, RecordCodec } from './crypto'
import { blobCodec, recordCodec, CorruptFileError } from './crypto'
import type { FileStamp } from './file-stamp'
import type { LiveDb, LiveMeta } from './live-db'
import { createLiveStore, type LiveStore } from './live-store'
import { createLivePersister, type LivePersister } from './live-persist'
import { joinDoc, splitDoc, type DocRecords } from './doc-records'
import { migrate, validateDoc, SCHEMA_VERSION } from './document'
import { createImageStore, type ImageStore } from './image-store'
import type { Store } from './store'
import { t } from './i18n'
import { toast } from '../ui/modal'

export type OpenDecision = 'import' | 'identical' | 'browser-newer' | 'ask-older-file' | 'file-from-elsewhere' | 'ask-both-changed'

/** The user backed out of the open (the both-changed question); the caller returns to the start screen. */
export class OpenCancelled extends Error {}

export function decideOpen(file: { docId: string; stamp: FileStamp | null }, meta: LiveMeta | undefined): OpenDecision {
  if (!meta) return 'import'
  const id = file.stamp?.writeId
  if (id !== undefined && id === meta.lastWriteId) return meta.unwrittenChanges ? 'browser-newer' : 'identical'
  if (id !== undefined && meta.knownWriteIds.includes(id)) return 'ask-older-file'
  return meta.unwrittenChanges ? 'ask-both-changed' : 'file-from-elsewhere'
}

function sameBytes(a: Uint8Array | undefined | null, b: Uint8Array | undefined | null): boolean {
  if (!a || !b) return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The document the stored records describe. A damaged copy (a missing document record, an invalid document) is corrupt, not a crash. */
export function readDoc(records: DocRecords): Doc {
  let doc: Doc
  try {
    doc = migrate(joinDoc(records))
  } catch {
    throw new CorruptFileError()
  }
  const bad = validateDoc(doc)
  if (bad) throw new CorruptFileError(bad)
  return doc
}

export interface LiveHandle { live: LiveStore; persister: LivePersister }

export interface Reconciled {
  doc: Doc
  images: ImageStore
  /** The password the used side is protected with (null: none). Differs from the file's when the browser copy won under its own. */
  password: string | null
  /** The stamp of the file that was opened (not of the browser copy). */
  stamp: FileStamp | null
  source: 'file' | 'browser'
  /** The store the persister watches: the app must use this one. */
  store: Store
  handle: LiveHandle
  /** The browser copy won, so the file is behind and should be rewritten right after opening. */
  needsFileWrite: boolean
}

export interface ResolveOpenDeps {
  db: LiveDb
  opened: OpenedDoc
  /** The password the file was opened with (null: a plain file). */
  password: string | null
  fileName: string
  askOlderFile(): Promise<'browser' | 'file'>
  /** May reject with OpenCancelled. */
  askBothChanged(): Promise<'browser' | 'file'>
  /** A password for the browser copy, or null to give up on it. */
  askBrowserPassword(): Promise<string | null>
  /** The browser copy holds edits the file never got and cannot be used: the file is about to replace it. Resolves to go on; rejects with OpenCancelled to back out and leave the copy as it is. */
  confirmDiscardCopy(): Promise<void>
  createStore(doc: Doc, images: ImageStore): Store
}

export async function resolveOpen(deps: ResolveOpenDeps): Promise<Reconciled> {
  const { db, opened, fileName } = deps
  const docId = opened.doc.docId
  let meta = await db.getMeta(docId)
  const hadCopy = meta !== undefined

  if (meta && meta.schemaVersion > SCHEMA_VERSION) {
    // Written by a newer build: this one must not read it. Only unwritten edits make that a loss, so only then ask;
    // "keep the browser copy" cannot be honoured here, so it backs out of the open and leaves the copy untouched.
    if (meta.unwrittenChanges && (await deps.askBothChanged()) === 'browser') throw new OpenCancelled()
    meta = undefined
  }

  const decision = decideOpen({ docId, stamp: opened.stamp }, meta)
  let want: 'browser' | 'file' = 'file'
  if (decision === 'browser-newer') want = 'browser'
  else if (decision === 'ask-older-file') want = await deps.askOlderFile()
  else if (decision === 'ask-both-changed') want = await deps.askBothChanged()

  if (meta && want === 'browser') {
    const r = await useBrowserCopy(meta, decision === 'browser-newer')
    if (r) return r
    // Falling back to the file replaces the copy, and with it the edits only the copy holds.
    if (meta.unwrittenChanges) await deps.confirmDiscardCopy()
  } else if (meta && decision === 'identical') {
    const r = await reuseIdentical(meta)
    if (r) return r
  }
  return importFile()

  // --- the browser copy wins -----------------------------------------------------------------------

  /** The codec for the copy, prompting for its password when it differs from the file's. Null: unusable. */
  async function unlock(m: LiveMeta, mayPrompt: boolean): Promise<{ codec: RecordCodec | null; password: string | null } | null> {
    if (!m.encrypted) {
      // A plain copy of a password-protected file would strip the password at the next file write.
      return deps.password === null ? { codec: null, password: null } : null
    }
    if (!m.salt || !m.check) return null
    const attempt = async (pw: string): Promise<RecordCodec | null> => {
      const codec = await recordCodec(pw, m.salt!)
      return (await codec.verifyCheck(m.check!)) ? codec : null
    }
    if (deps.password !== null) {
      const codec = await attempt(deps.password)
      if (codec) return { codec, password: deps.password }
    }
    if (!mayPrompt) return null
    for (;;) {
      const pw = await deps.askBrowserPassword()
      if (pw === null) return null
      const codec = await attempt(pw)
      if (codec) return { codec, password: pw }
    }
  }

  /**
   * `fileIsLatest`: the file is the copy's own last file write. Every password change writes the file first, so the
   * file's password is then the newest one and a copy under another key has drifted (a re-key that failed after the
   * file write): the copy is moved to the file's key rather than the document being handed back under the old password,
   * which the next file write would turn into a silent undo of the password change. When the user instead picked the
   * copy over an older or foreign file, that file is the stale side and the copy's password stands.
   */
  async function useBrowserCopy(m: LiveMeta, fileIsLatest: boolean): Promise<Reconciled | null> {
    const key = await unlock(m, true)
    if (!key) return null
    try {
      const live = createLiveStore(db, docId, key.codec)
      const { records, blobs } = await live.load()
      const doc = readDoc(records)
      // The blobs are in the form the copy's key sealed them, so the image store must hold that very key.
      const images = createImageStore(key.password === null ? null : await blobCodec(key.password, m.salt ?? undefined))
      for (const [id, bytes] of blobs) images.adoptStored(id, bytes)
      let password = key.password
      let rekeyTo: { codec: RecordCodec | null } | undefined
      const fileSalt = opened.images.codec()?.header?.salt
      if (fileIsLatest && (deps.password !== key.password || (deps.password !== null && !sameBytes(fileSalt, m.salt)))) {
        // Moving the copy is the persister's owed initial step (it needs the write lock); the image store moves now.
        await images.rekey(deps.password === null ? null : await blobCodec(deps.password, fileSalt))
        rekeyTo = { codec: deps.password === null ? null : await recordCodec(deps.password, fileSalt) }
        password = deps.password
      }
      const store = deps.createStore(doc, images)
      const persister = await createLivePersister({ store, live, fileName, stored: { records, blobIds: blobs.keys() }, rekeyTo })
      // The file is behind this copy, so the first file write must not be skipped as "nothing changed".
      store.markDirty()
      return { doc, images, password, stamp: opened.stamp, source: 'browser', store, handle: { live, persister }, needsFileWrite: true }
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e
      unreadable(e)
      return null
    }
  }

  // --- the file is what the copy already holds -----------------------------------------------------

  /**
   * The file was just decoded and the copy is, by lineage, that very document: nothing needs reading back out of the
   * copy. The persister is seeded with the records of the file's own document, and the copy is only counted (its
   * records, and the ids of its blobs) instead of opened row by row, which for a large document with pictures was most
   * of the time an unchanged file took to open. A copy of another schema version is simply replaced by the file.
   */
  async function reuseIdentical(m: LiveMeta): Promise<Reconciled | null> {
    const key = await unlock(m, false)
    if (!key || key.password !== deps.password) return null
    if (m.schemaVersion !== SCHEMA_VERSION) return null
    try {
      const live = createLiveStore(db, docId, key.codec)
      const stat = await live.stat()
      const records = splitDoc(opened.doc)
      // A missing row would never be rewritten (the persister believes the copy holds it), so a copy that is not whole is not reused.
      if (stat.records !== records.size) throw new CorruptFileError()
      const store = deps.createStore(opened.doc, opened.images)
      const persister = await createLivePersister({ store, live, fileName, stored: { records, blobIds: stat.blobIds } })
      return { doc: opened.doc, images: opened.images, password: deps.password, stamp: opened.stamp, source: 'file', store, handle: { live, persister }, needsFileWrite: false }
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e
      unreadable(e)
      return null
    }
  }

  // --- the file wins -------------------------------------------------------------------------------

  async function importFile(): Promise<Reconciled> {
    // The old rows are not deleted here: only the tab holding the write lock may touch the browser copy, and this
    // tab may turn out to be read-only. The persister replaces them in its initial commit, once it is allowed to.
    // The same key the file was just opened with (its image store holds it), not a fresh lookup of the global cache.
    const codec = deps.password === null ? null : await recordCodec(deps.password, opened.images.codec()?.header?.salt)
    const live = createLiveStore(db, docId, codec)
    const store = deps.createStore(opened.doc, opened.images)
    const persister = await createLivePersister({ store, live, fileName, fromFile: opened.stamp, replaceStored: hadCopy })
    // A file from before this schema was just migrated, and migration minted its docId (the browser copy's key). Until the
    // file is written back, the next open mints another one and the copy of everything edited meanwhile is orphaned.
    const migrated = opened.preSchemaVersion !== null && opened.preSchemaVersion < SCHEMA_VERSION
    if (migrated) store.markDirty()
    return { doc: opened.doc, images: opened.images, password: deps.password, stamp: opened.stamp, source: 'file', store, handle: { live, persister }, needsFileWrite: migrated }
  }

  function unreadable(e: unknown): void {
    console.error(e)
    toast(t(opened.doc.prefs.locale, 'live_copy_unreadable_toast'))
  }
}
