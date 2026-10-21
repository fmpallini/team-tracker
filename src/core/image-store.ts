/**
 * In-memory home of the document's image bytes. `Doc.images` carries only
 * metadata; the bytes live here and are never JSON-serialized.
 *
 * Two forms per image: `plain` (what the browser renders) and `stored` (what
 * the file holds: AES-GCM sealed, or the same bytes when the file has no
 * password). An image read from a file is adopted in stored form and opened
 * lazily; an imported one arrives plain and is sealed on first save. Both
 * forms are cached for the life of the session and never evicted — that is
 * what lets "delete a note, save, undo, save" bring the image back (the save
 * sweep drops unreferenced images from the FILE, not from here).
 */
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
    if (!codec) { e.plain = e.stored; return e.plain }
    try {
      e.plain = await codec.open(id, e.stored)
      return e.plain
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
      return e.stored
    },

    async rekey(next) {
      for (const [id, e] of entries) {
        if (!(await plainOf(id, e))) { e.stored = null; continue }
      }
      codec = next
      for (const e of entries.values()) e.stored = null
    },
  }
}
