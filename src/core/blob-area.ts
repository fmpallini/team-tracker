/** `[offset, length]` of one blob inside the blob area. */
export type BlobRange = [number, number]

/** Lays blobs end to end. The index maps each id to where its bytes sit in `area`. */
export function packBlobs(blobs: { id: string; stored: Uint8Array }[]): { area: Uint8Array; index: Record<string, BlobRange> } {
  const total = blobs.reduce((n, b) => n + b.stored.length, 0)
  const area = new Uint8Array(total)
  const index: Record<string, BlobRange> = {}
  let at = 0
  for (const b of blobs) {
    area.set(b.stored, at)
    index[b.id] = [at, b.stored.length]
    at += b.stored.length
  }
  return { area, index }
}

/** The blob for `id`, or null when it is not indexed or its range does not fit in `area` (truncated or tampered file). */
export function sliceBlob(area: Uint8Array, index: Record<string, BlobRange>, id: string): Uint8Array | null {
  const range = Object.prototype.hasOwnProperty.call(index, id) ? index[id] : undefined
  if (!Array.isArray(range) || range.length !== 2) return null
  const [off, len] = range
  if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len < 0 || off + len > area.length) return null
  return area.subarray(off, off + len)
}
