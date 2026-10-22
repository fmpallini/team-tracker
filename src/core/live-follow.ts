// src/core/live-follow.ts — a tab that takes the write lock over continues from the browser copy. The previous holder
// may have changed the document's password (set, changed or removed) since this tab last looked, so the copy is read
// under the key IT is under now — taken from its own meta — not under the key this tab happens to hold.
import type { Doc } from './types'
import { blobCodec, recordCodec, CorruptFileError } from './crypto'
import type { RecordCodec } from './crypto'
import type { LiveStore } from './live-store'
import { joinDoc } from './doc-records'
import { migrate, validateDoc } from './document'
import { createImageStore, type ImageStore } from './image-store'
import type { DocRecords } from './doc-records'

/** The user gave up entering the copy's password; the tab stays as it is. */
export class FollowCancelled extends Error {}

export interface FollowDeps {
  live: LiveStore
  /** The password this tab holds now (null: none). Tried first, so an unchanged password never prompts. */
  currentPassword: string | null
  /** The password of the browser copy, or null to give up. `wasWrong`: the previous answer did not open it. */
  askPassword(wasWrong: boolean): Promise<string | null>
}

export interface Followed {
  doc: Doc
  images: ImageStore
  /** The password the copy is protected with (null: none): the tab continues under it. */
  password: string | null
  /** The raw material the persister must be reseeded with, so it writes only what changes from here on. */
  stored: { records: DocRecords; blobs: Map<string, Uint8Array> }
  /** The copy holds edits the file does not. */
  unwritten: boolean
}

/** Rejects with CorruptFileError when the copy is missing or unreadable, with FollowCancelled when the password prompt is cancelled. */
export async function followLiveCopy(deps: FollowDeps): Promise<Followed> {
  const { live } = deps
  const meta = await live.meta()
  if (!meta) throw new CorruptFileError()

  let codec: RecordCodec | null = null
  let password: string | null = null
  if (meta.encrypted) {
    const { salt, check } = meta
    if (!salt || !check) throw new CorruptFileError()
    const attempt = async (pw: string): Promise<RecordCodec | null> => {
      const c = await recordCodec(pw, salt)
      return (await c.verifyCheck(check)) ? c : null
    }
    if (deps.currentPassword !== null) {
      codec = await attempt(deps.currentPassword)
      if (codec) password = deps.currentPassword
    }
    for (let wasWrong = false; !codec; wasWrong = true) {
      const pw = await deps.askPassword(wasWrong)
      if (pw === null) throw new FollowCancelled()
      codec = await attempt(pw)
      if (codec) password = pw
    }
  }

  live.useCodec(codec)
  const stored = await live.load()
  let doc: Doc
  try {
    doc = migrate(joinDoc(stored.records))
  } catch {
    throw new CorruptFileError()
  }
  const bad = validateDoc(doc)
  if (bad) throw new CorruptFileError(bad)
  // The blobs are in the form the copy's key sealed them, so the image store must hold that very key.
  const images = createImageStore(password === null ? null : await blobCodec(password, meta.salt ?? undefined))
  for (const [id, bytes] of stored.blobs) images.adoptStored(id, bytes)
  return { doc, images, password, stored, unwritten: meta.unwrittenChanges }
}
