// src/ui/image-host.ts — what one editor needs to show the document's images.
// Bytes live in the Store's ImageStore; the editor displays them as `data:`
// URIs (no object URLs to revoke, and a copy or drag carries real pixels).
// One host per editor bundle: it caches the URIs it has built so re-hydrating
// a note does not re-encode them, and drops them when the editor goes away.
import type { Store } from '../core/store'
import type { ImageMeta } from '../core/types'

export interface ImageHost {
  /** The image as a `data:` URI, or null when its bytes are unknown or unreadable (a damaged file). */
  getDataUri(id: string): Promise<string | null>
  /** Size and type from the document, for laying the block out before the pixels arrive. */
  getMeta(id: string): ImageMeta | undefined
  /** Releases the URI cache. Idempotent. */
  dispose(): void
}

/** btoa over a large array in slices: String.fromCharCode(...bytes) overflows the argument limit on a megabyte. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const SLICE = 0x8000
  for (let i = 0; i < bytes.length; i += SLICE) binary += String.fromCharCode(...bytes.subarray(i, i + SLICE))
  return btoa(binary)
}

export function createImageHost(store: Store): ImageHost {
  const cache = new Map<string, Promise<string | null>>()

  return {
    getDataUri(id) {
      let uri = cache.get(id)
      if (!uri) {
        uri = (async () => {
          const bytes = await store.images.getPlain(id)
          const meta = store.doc.images[id]
          return bytes && meta ? `data:${meta.mime};base64,${toBase64(bytes)}` : null
        })()
        cache.set(id, uri)
        // A miss is not remembered: the bytes may arrive later (an import, or an undo that restores the note).
        void uri.then((v) => { if (v === null && cache.get(id) === uri) cache.delete(id) })
      }
      return uri
    },

    getMeta(id) {
      return store.doc.images[id]
    },

    dispose() {
      cache.clear()
    },
  }
}
