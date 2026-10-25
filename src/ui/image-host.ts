// src/ui/image-host.ts — what one editor needs to show and add images.
// Bytes live in the Store's ImageStore; the editor displays them as `data:`
// URIs (no object URLs to revoke, and a copy or drag carries real pixels).
// One host per editor bundle: it caches the URIs it has built so re-hydrating
// a note does not re-encode them, drops them when the editor goes away, and
// owns the whole "files in, document updated, user told" import step.
import type { Store } from '../core/store'
import type { ImageMeta } from '../core/types'
import { t, type Locale } from '../core/i18n'
import { IMAGE_LIMITS, importImages, type ImageCodec, type ImportRefusal, type ImportResult } from '../core/image-import'
import { browserImageCodec } from './image-codec'
import { toast } from './modal'

/** Dispatched on `document` when the user asks to see image usage (the cap toast's action); main.ts opens Preferences on the Data tab. */
export const OPEN_DATA_PREFS_EVENT = 'tt-open-data-prefs'

export interface ImageHost {
  /** The image as a `data:` URI, or null when its bytes are unknown or unreadable (a damaged file). */
  getDataUri(id: string): Promise<string | null>
  /** Size and type from the document, for laying the block out before the pixels arrive. */
  getMeta(id: string): ImageMeta | undefined
  /**
   * Imports the files (shrinking them under the caps), records the new ones in the document in a single update,
   * and tells the user what happened with one toast. The answer lines up with `files`: an entry is null for a file
   * that was not added. The caller inserts the blocks; nothing here touches an editor.
   */
  importFiles(files: File[]): Promise<({ id: string; alt: string } | null)[]>
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

const MB = 1024 * 1024
const REASON_KEYS = {
  too_large: 'img_reason_too_large',
  unsupported: 'img_reason_unsupported',
  corrupt: 'img_reason_corrupt',
  cap_reached: 'img_reason_cap_reached',
} as const satisfies Record<ImportRefusal, string>

const showUsageDefault = (): void => { document.dispatchEvent(new CustomEvent(OPEN_DATA_PREFS_EVENT)) }

export function createImageHost(
  store: Store,
  locale: Locale,
  codec: ImageCodec = browserImageCodec,
  onShowUsage: () => void = showUsageDefault,
): ImageHost {
  const cache = new Map<string, Promise<string | null>>()

  /** One toast per batch: how many went in, and why the others did not. */
  function report(results: ImportResult[], crossedWarn: boolean, totalBytes: number): void {
    const added = results.filter((r) => r.ok).length
    const refused = results.flatMap((r) => (r.ok ? [] : [r.reason]))
    if (refused.includes('cap_reached')) {
      const lead = added > 0 ? `${t(locale, 'img_added', { n: String(added) })}. ` : ''
      toast(lead + t(locale, 'img_cap_toast'), { kind: 'warn',
        key: 'image-import',
        duration: 10_000,
        action: { label: t(locale, 'img_show_usage'), onClick: onShowUsage },
      })
      return
    }
    if (refused.length === 0) {
      toast(t(locale, 'img_added', { n: String(added) }), { kind: 'success', key: 'image-import' })
    } else if (added === 0 && refused.every((r) => r === 'unsupported')) {
      toast(t(locale, 'img_only_images'), { kind: 'warn', key: 'image-import' })
    } else {
      const why = [...new Set(refused)].map((r) => t(locale, REASON_KEYS[r])).join('; ')
      toast(t(locale, 'img_added_partial', { n: String(added), m: String(refused.length), why }), { kind: 'warn', key: 'image-import' })
    }
    if (crossedWarn) {
      toast(t(locale, 'img_warn_toast', {
        used: `${(totalBytes / MB).toFixed(1)} MB`,
        cap: `${(IMAGE_LIMITS.totalCapBytes / MB).toFixed(0)} MB`,
      }), { kind: 'warn', key: 'image-warn' })
    }
  }

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

    async importFiles(files) {
      const results: (ImportResult | null)[] = files.map(() => null)
      const inputs: { bytes: Uint8Array; name: string }[] = []
      const slots: number[] = []
      for (const [i, file] of files.entries()) {
        // Judged by size before reading: dropping a video must not pull it into memory.
        if (file.size > IMAGE_LIMITS.maxSourceBytes) { results[i] = { ok: false, reason: 'too_large', name: file.name }; continue }
        inputs.push({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name })
        slots.push(i)
      }
      const batch = await importImages(inputs, { codec, images: store.images, doc: store.doc })
      batch.results.forEach((r, k) => { results[slots[k]!] = r })

      const done = results.filter((r): r is ImportResult => r !== null)
      const fresh = done.flatMap((r) => (r.ok && r.isNew ? [r] : []))
      if (fresh.length > 0) {
        // Images are only ever referenced from notes, so 'notes' is the section that changed; no editor watches it.
        store.update((d) => { for (const r of fresh) d.images[r.id] ??= r.meta }, { sections: ['notes'] })
      }
      report(done, batch.crossedWarn, batch.totalBytes)
      return results.map((r) => (r?.ok ? { id: r.id, alt: r.alt } : null))
    },

    dispose() {
      cache.clear()
    },
  }
}
