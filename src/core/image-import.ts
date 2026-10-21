// src/core/image-import.ts — the pure half of getting a picture into a note:
// decide whether bytes are an image we accept, shrink them under the caps,
// give them their content id, and keep the document inside its total budget.
// The browser (decode, canvas re-encode) is injected as an `ImageCodec`, so
// everything here runs, and is tested, without one.
import type { Doc, ImageMeta } from './types'
import type { ImageStore } from './image-store'
import { collectImageRefs } from './image-ref'

const MB = 1024 * 1024

/** Every size rule in one place (spec: "Limits and how they are reported"). */
export const IMAGE_LIMITS = {
  /** Per image, after processing. */
  maxBytes: 1 * MB,
  /** Long edge, pixels. */
  maxEdge: 1600,
  /** The scale-down fallback never goes below this long edge. */
  minEdge: 800,
  /** WebP quality ladder, tried in order before shrinking the picture. */
  qualities: [0.85, 0.7, 0.55] as readonly number[],
  /** Each shrink step multiplies the long edge by this. */
  scaleStep: 0.75,
  /** Total of the images the document references. */
  totalCapBytes: 150 * MB,
  warnBytes: 100 * MB,
} as const

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'bmp'

const MIME: Record<ImageKind, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
}

const ascii = (bytes: Uint8Array, at: number, len: number): string => String.fromCharCode(...bytes.subarray(at, at + len))
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0

/** APNG: an `acTL` chunk ahead of the first `IDAT`. */
function pngAnimated(b: Uint8Array): boolean {
  let at = 8
  while (at + 8 <= b.length) {
    const type = ascii(b, at + 4, 4)
    if (type === 'acTL') return true
    if (type === 'IDAT') return false
    at += 12 + u32be(b, at)
  }
  return false
}

/** Skips a run of GIF data sub-blocks (each led by its size byte, ended by a zero size). */
function skipSubBlocks(b: Uint8Array, at: number): number {
  while (at < b.length && b[at] !== 0) at += b[at]! + 1
  return at + 1
}

/** More than one image descriptor means frames. */
function gifAnimated(b: Uint8Array): boolean {
  if (b.length < 13) return false
  let at = 13
  if (b[10]! & 0x80) at += 3 * 2 ** ((b[10]! & 7) + 1)
  let frames = 0
  while (at < b.length) {
    const block = b[at]!
    if (block === 0x21) at = skipSubBlocks(b, at + 2)
    else if (block === 0x2c) {
      frames++
      if (frames > 1) return true
      const flags = b[at + 9] ?? 0
      at += 10
      if (flags & 0x80) at += 3 * 2 ** ((flags & 7) + 1)
      at = skipSubBlocks(b, at + 1)
    } else break
  }
  return false
}

/** Animated WebP: a VP8X header with the animation flag, or an `ANIM` chunk. */
function webpAnimated(b: Uint8Array): boolean {
  let at = 12
  while (at + 8 <= b.length) {
    const type = ascii(b, at, 4)
    if (type === 'ANIM') return true
    if (type === 'VP8X' && ((b[at + 8] ?? 0) & 0x02)) return true
    if (type === 'VP8 ' || type === 'VP8L') return false
    at += 8 + u32le(b, at + 4) + (u32le(b, at + 4) & 1)
  }
  return false
}

/** Brands listed in an ISO-BMFF `ftyp` box (major brand first). */
function ftypBrands(b: Uint8Array): string[] {
  const size = Math.min(u32be(b, 0), b.length)
  const brands = [ascii(b, 8, 4)]
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(b, at, 4))
  return brands
}

/**
 * Judges bytes by their magic numbers, never by file extension or declared
 * MIME. Null means "not one of the accepted formats" (SVG, HEIC, TIFF, JPEG XL,
 * ICO and non-images all land here).
 */
export function sniffImage(b: Uint8Array): { kind: ImageKind; animated: boolean } | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { kind: 'png', animated: pngAnimated(b) }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'jpeg', animated: false }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { kind: 'webp', animated: webpAnimated(b) }
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { kind: 'gif', animated: gifAnimated(b) }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brands = ftypBrands(b)
    if (brands.includes('avif') || brands.includes('avis')) return { kind: 'avif', animated: brands.includes('avis') }
    return null
  }
  if (b.length >= 6 && b[0] === 0x42 && b[1] === 0x4d) return { kind: 'bmp', animated: false }
  return null
}

/** Content id: the first 32 hex chars of the SHA-256 of the bytes that will be stored. */
export async function imageId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return Array.from(digest.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('')
}

/** The browser half, injected (ui/image-codec.ts). */
export interface ImageCodec {
  /** Rejects when the browser cannot decode the bytes. */
  decode(bytes: Uint8Array): Promise<{ w: number; h: number }>
  /** Re-encodes (WebP, with the browser's own fallback) scaled so the long edge is at most `maxEdge`; never upscales. */
  encode(bytes: Uint8Array, opts: { maxEdge: number; quality: number }): Promise<{ bytes: Uint8Array; mime: string; w: number; h: number }>
}

export type ImportRefusal = 'too_large' | 'unsupported' | 'corrupt' | 'cap_reached'
export type ImportResult =
  | { ok: true; id: string; meta: ImageMeta; alt: string; isNew: boolean }
  | { ok: false; reason: ImportRefusal; name: string }

export interface ImportContext { codec: ImageCodec; images: ImageStore; doc: Doc }

/** Alt text is the file name without its extension; bracket characters would break the reference line. */
function altFromName(name: string): string {
  return name.replace(/\.[^./\\]*$/, '').replace(/[[\]()\\\r\n]/g, '').trim()
}

interface Prepared { id: string; stored: Uint8Array; meta: ImageMeta; alt: string }

/** Edges to try, largest first: the cap, then ×0.75 steps, ending on the floor. A picture already smaller than the floor is never scaled. */
function edgeLadder(longEdge: number): number[] {
  const edges: number[] = []
  let edge = Math.min(IMAGE_LIMITS.maxEdge, longEdge)
  if (edge <= IMAGE_LIMITS.minEdge) return [edge]
  for (;;) {
    edges.push(edge)
    if (edge === IMAGE_LIMITS.minEdge) return edges
    edge = Math.max(IMAGE_LIMITS.minEdge, Math.floor(edge * IMAGE_LIMITS.scaleStep))
  }
}

/** Decides what would be stored for `input`, without touching the store or the document. */
async function prepare(input: { bytes: Uint8Array; name: string }, ctx: ImportContext): Promise<Prepared | { refusal: ImportRefusal }> {
  const sniffed = sniffImage(input.bytes)
  if (!sniffed) return { refusal: 'unsupported' }
  let decoded: { w: number; h: number }
  try {
    decoded = await ctx.codec.decode(input.bytes)
  } catch {
    return { refusal: 'corrupt' }
  }
  const alt = altFromName(input.name)
  const original = async (): Promise<Prepared> => ({
    id: await imageId(input.bytes),
    stored: input.bytes,
    meta: { mime: MIME[sniffed.kind], w: decoded.w, h: decoded.h, bytes: input.bytes.length },
    alt,
  })
  const fits = input.bytes.length <= IMAGE_LIMITS.maxBytes
  // Frames would be lost by a canvas: keep the original or refuse.
  if (sniffed.animated) return fits ? original() : { refusal: 'too_large' }

  const longEdge = Math.max(decoded.w, decoded.h)
  const originalFits = fits && longEdge <= IMAGE_LIMITS.maxEdge
  // Our own output (and any small WebP) is stored untouched, so pasting it
  // again lands on the same id and dedupes.
  if (sniffed.kind === 'webp' && originalFits) return original()

  for (const edge of edgeLadder(longEdge)) {
    for (const quality of IMAGE_LIMITS.qualities) {
      const out = await ctx.codec.encode(input.bytes, { maxEdge: edge, quality })
      if (out.bytes.length > IMAGE_LIMITS.maxBytes) continue
      if (originalFits && out.bytes.length >= input.bytes.length) return original()
      return { id: await imageId(out.bytes), stored: out.bytes, meta: { mime: out.mime, w: out.w, h: out.h, bytes: out.bytes.length }, alt }
    }
  }
  return { refusal: 'too_large' }
}

function commit(p: Prepared, ctx: ImportContext): void {
  if (!ctx.images.has(p.id)) ctx.images.putPlain(p.id, p.stored)
}

/**
 * Imports one image into the store. When the result is new to the document
 * (`isNew`), the caller adds `doc.images[id] = meta` inside its own
 * `store.update` — this function never touches the document.
 */
export async function importImage(input: { bytes: Uint8Array; name: string }, ctx: ImportContext): Promise<ImportResult> {
  const p = await prepare(input, ctx)
  if ('refusal' in p) return { ok: false, reason: p.refusal, name: input.name }
  commit(p, ctx)
  return { ok: true, id: p.id, meta: p.meta, alt: p.alt, isNew: !(p.id in ctx.doc.images) }
}

/**
 * Imports a batch in order. The total cap is measured on what the document
 * references plus what this batch has accepted so far (unreferenced leftovers
 * are not written, so they do not count). The first image that would cross it
 * is refused with `cap_reached`, and so is every image after it, unprocessed.
 */
export async function importImages(
  inputs: { bytes: Uint8Array; name: string }[],
  ctx: ImportContext,
): Promise<{ results: ImportResult[]; crossedWarn: boolean }> {
  const counted = collectImageRefs(ctx.doc)
  let before = 0
  for (const id of counted) before += ctx.doc.images[id]?.bytes ?? 0
  let total = before
  const results: ImportResult[] = []
  let capped = false
  for (const input of inputs) {
    if (capped) { results.push({ ok: false, reason: 'cap_reached', name: input.name }); continue }
    const p = await prepare(input, ctx)
    if ('refusal' in p) { results.push({ ok: false, reason: p.refusal, name: input.name }); continue }
    const added = counted.has(p.id) ? 0 : p.meta.bytes
    if (total + added > IMAGE_LIMITS.totalCapBytes) {
      capped = true
      results.push({ ok: false, reason: 'cap_reached', name: input.name })
      continue
    }
    commit(p, ctx)
    results.push({ ok: true, id: p.id, meta: p.meta, alt: p.alt, isNew: !counted.has(p.id) && !(p.id in ctx.doc.images) })
    counted.add(p.id)
    total += added
  }
  return { results, crossedWarn: before < IMAGE_LIMITS.warnBytes && total >= IMAGE_LIMITS.warnBytes }
}
