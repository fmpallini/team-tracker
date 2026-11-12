/**
 * In-memory home of the document's image bytes. `Doc.images` carries only
 * metadata; the bytes live here and are never JSON-serialized.
 *
 * Two forms per image: `plain` (what the browser renders) and `stored` (what
 * the file holds: AES-GCM sealed, or the same bytes when the file has no
 * password). An image read from a file is adopted in stored form and opened
 * on demand; an imported one arrives plain and is sealed on first save, after
 * which only the sealed form is kept (a password-less file has one form only).
 * Images are never evicted — that is what lets "delete a note, save, undo,
 * save" bring the image back (the save sweep drops unreferenced images from
 * the FILE, not from here).
 */
import { sniffImage } from './image-import'

export interface BlobCodec {
  seal(id: string, plain: Uint8Array): Promise<Uint8Array>
  open(id: string, sealed: Uint8Array): Promise<Uint8Array>
  /**
   * The key material this codec seals under (the file header's salt and the key derived from it).
   * `encryptDocument` writes the header from here, so the header key and the blob key are one key
   * however the module-level session-key cache moves while the document is open.
   */
  readonly header?: { salt: Uint8Array; key: CryptoKey }
}

export interface ImageStore {
  has(id: string): boolean
  /** Renderable bytes, or null when the id is unknown or its blob cannot be opened (damaged file). */
  getPlain(id: string): Promise<Uint8Array | null>
  putPlain(id: string, plain: Uint8Array): void
  /** Registers a blob exactly as the file holds it; opened on first use. */
  adoptStored(id: string, stored: Uint8Array): void
  /** Bytes to write to a file, or null when the image is unreadable. */
  getStored(id: string): Promise<Uint8Array | null>
  /** The codec blobs are sealed under now; null for a password-less file. */
  codec(): BlobCodec | null
  /** Forgets an image for good (its bytes and its sealed form). Only for a picture no note references and nothing can bring back. */
  discard(id: string): void
  /** Switches the codec (password change). Loads every plain form with the OLD codec first, then forgets sealed forms. */
  rekey(codec: BlobCodec | null): Promise<void>
}

interface Entry { plain: Uint8Array | null; stored: Uint8Array | null }

export function createImageStore(initial: BlobCodec | null): ImageStore {
  let codec = initial
  const entries = new Map<string, Entry>()

  async function plainOf(id: string, e: Entry): Promise<Uint8Array | null> {
    if (e.plain) return e.plain
    if (!e.stored) return null
    if (!codec) { e.plain = e.stored; return e.plain } // the same bytes: no second copy
    // Not kept: an image that has a sealed form is held in that one form, and opened for each reader (the editor
    // caches what it renders), so a document full of pictures does not sit in memory twice.
    try {
      return await codec.open(id, e.stored)
    } catch {
      return null
    }
  }

  return {
    has: (id) => entries.has(id),

    codec: () => codec,

    async getPlain(id) {
      const e = entries.get(id)
      return e ? plainOf(id, e) : null
    },

    putPlain(id, plain) {
      const e = entries.get(id)
      if (e) { e.plain = plain; return }
      entries.set(id, { plain, stored: null })
    },

    adoptStored(id, stored) {
      entries.set(id, { plain: null, stored })
    },

    async getStored(id) {
      const e = entries.get(id)
      if (!e) return null
      if (!codec) return e.plain ?? e.stored
      if (e.stored) return e.stored
      if (!e.plain) return null
      e.stored = await codec.seal(id, e.plain)
      e.plain = null // sealed: the sealed form is the one kept (see plainOf)
      return e.stored
    },

    discard: (id) => { entries.delete(id) },

    async rekey(next) {
      // Every image is opened with the OLD codec and held plain until the new codec seals it again.
      const alreadyNext = new Set<string>()
      for (const [id, e] of entries) {
        const plain = await plainOf(id, e)
        if (plain) e.plain = plain
        else if (e.stored && await isInForm(next, id, e.stored)) alreadyNext.add(id)
        else e.stored = null
      }
      codec = next
      for (const [id, e] of entries) if (!alreadyNext.has(id)) e.stored = null
    },
  }
}

/**
 * Whether `stored` is already what `next` would store for `id`. A browser copy whose own re-key failed after a
 * password change keeps its records under the old key while the pictures added afterwards were sealed under the
 * new one (the image store had already moved), so the next open's re-key meets blobs the old key cannot open but
 * that need no change. Under a key, AES-GCM (with the id as additional data) proves it; with no key the stored
 * form is the picture itself, which a sealed blob's random bytes never pass for.
 */
async function isInForm(next: BlobCodec | null, id: string, stored: Uint8Array): Promise<boolean> {
  if (!next) return sniffImage(stored) !== null
  try {
    await next.open(id, stored)
    return true
  } catch {
    return false
  }
}
