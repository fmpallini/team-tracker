import { IMAGE_LIMITS, sniffImage, imageId, importImage, importImages, type ImageCodec } from '../src/core/image-import'
import { createImageStore } from '../src/core/image-store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { imageRefLine } from '../src/core/image-ref'
import type { Doc } from '../src/core/types'

const MB = 1024 * 1024

// --- byte builders: just enough structure for the sniffer ---
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]

const grow = (base: number[], pad = 0): Uint8Array => { const out = new Uint8Array(base.length + pad); out.set(base); return out }

function pngChunk(type: string, data: number[] = []) { return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0] }
// `pad` appends zero bytes after the image data, which the sniffer never reads: it only sets the file size.
function png(opts: { animated?: boolean; pad?: number } = {}): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk('IHDR', new Array(13).fill(0))]
  if (opts.animated) out.push(...pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]))
  out.push(...pngChunk('IDAT', [1, 1, 1, 1]), ...pngChunk('IEND'))
  return grow(out, opts.pad)
}
function gif(frames: number, pad = 0): Uint8Array {
  const out = [...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0]
  for (let i = 0; i < frames; i++) out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0)
  out.push(0x3b)
  return grow(out, pad)
}
function webp(opts: { animated?: boolean; pad?: number } = {}): Uint8Array {
  const body = [...ascii('WEBP'), ...ascii('VP8X'), ...u32le(10), opts.animated ? 0x02 : 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if (opts.animated) body.push(...ascii('ANIM'), ...u32le(6), 0, 0, 0, 0, 0, 0)
  body.push(...ascii('VP8L'), ...u32le(4), 3, 3, 3, 3)
  return grow([...ascii('RIFF'), ...u32le(body.length), ...body], opts.pad)
}
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const avif = () => new Uint8Array([0, 0, 0, 16, ...ascii('ftyp'), ...ascii('avif'), 0, 0, 0, 0])
const bmp = () => new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0])

// --- fake codec ---
interface Fake extends ImageCodec { encodeCalls: { maxEdge: number; quality: number }[] }
function fakeCodec(opts: { w?: number; h?: number; hasAlpha?: boolean; decodeFails?: boolean; sizeFor?: (maxEdge: number, quality: number) => number } = {}): Fake {
  const w = opts.w ?? 3000, h = opts.h ?? 2000
  const calls: { maxEdge: number; quality: number }[] = []
  return {
    encodeCalls: calls,
    async decode() { if (opts.decodeFails) throw new Error('bad image'); return { w, h, hasAlpha: opts.hasAlpha ?? false } },
    async encode(input, o) {
      calls.push(o)
      const size = opts.sizeFor ? opts.sizeFor(o.maxEdge, o.quality) : 1000
      const scale = Math.min(1, o.maxEdge / Math.max(w, h))
      const out = new Uint8Array(size)
      out.set([0x52, 0x49, 0x46, 0x46]); out[8] = o.maxEdge & 255; out[9] = Math.round(o.quality * 100); out[10] = input.length & 255; out[11] = (input.length >> 8) & 255
      return { bytes: out, mime: 'image/webp', w: Math.round(w * scale), h: Math.round(h * scale) }
    },
  }
}

function ctxFor(codec: ImageCodec, doc: Doc = createEmptyDocument('en-US')) {
  return { codec, images: createImageStore(null), doc }
}

describe('sniffImage', () => {
  it('recognises each accepted format by magic bytes', () => {
    expect(sniffImage(png())?.kind).toBe('png')
    expect(sniffImage(jpeg())?.kind).toBe('jpeg')
    expect(sniffImage(webp())?.kind).toBe('webp')
    expect(sniffImage(gif(1))?.kind).toBe('gif')
    expect(sniffImage(avif())?.kind).toBe('avif')
    expect(sniffImage(bmp())?.kind).toBe('bmp')
  })

  it('refuses SVG, text, HEIC and random bytes', () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(sniffImage(new Uint8Array([0, 0, 0, 24, ...ascii('ftyp'), ...ascii('heic')]))).toBeNull()
    expect(sniffImage(new Uint8Array(64).fill(7))).toBeNull()
    expect(sniffImage(new Uint8Array(0))).toBeNull()
  })

  it('flags animated GIF, APNG and animated WebP, and not their still forms', () => {
    expect(sniffImage(gif(3))?.animated).toBe(true)
    expect(sniffImage(gif(1))?.animated).toBe(false)
    expect(sniffImage(png({ animated: true }))?.animated).toBe(true)
    expect(sniffImage(png())?.animated).toBe(false)
    expect(sniffImage(webp({ animated: true }))?.animated).toBe(true)
    expect(sniffImage(webp())?.animated).toBe(false)
  })
})

describe('imageId', () => {
  it('is the first 32 hex chars of the SHA-256', async () => {
    const id = await imageId(new TextEncoder().encode('abc'))
    expect(id).toBe('ba7816bf8f01cfea414140de5dae2223')
  })
})

describe('importImage', () => {
  it('limits are the values the spec fixes', () => {
    expect(IMAGE_LIMITS).toMatchObject({ maxBytes: 1 * MB, maxEdge: 1600, minEdge: 800, totalCapBytes: 150 * MB, warnBytes: 100 * MB })
    expect([...IMAGE_LIMITS.qualities]).toEqual([0.85, 0.7, 0.55])
  })

  it('re-encodes a large PNG to WebP at the long-edge cap and stores it under its content id', async () => {
    const codec = fakeCodec()
    const ctx = ctxFor(codec)
    const r = await importImage({ bytes: png({ pad: 5000 }), name: 'screen shot.png' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(codec.encodeCalls[0]).toEqual({ maxEdge: 1600, quality: 0.85 })
    expect(r.meta).toMatchObject({ mime: 'image/webp', w: 1600, h: 1067 })
    expect(r.alt).toBe('screen shot')
    expect(r.isNew).toBe(true)
    const stored = (await ctx.images.getPlain(r.id))!
    expect(r.id).toBe(await imageId(stored))
    expect(r.meta.bytes).toBe(stored.length)
  })

  it('steps the quality down, then the size, until the result fits 1 MB', async () => {
    const codec = fakeCodec({ sizeFor: (edge, q) => (edge === 1600 ? 2 * MB : q < 0.8 ? 0.9 * MB : 2 * MB) })
    const r = await importImage({ bytes: png({ pad: 5000 }), name: 'a.png' }, ctxFor(codec))
    expect(r.ok).toBe(true)
    expect(codec.encodeCalls.map((c) => c.quality).slice(0, 3)).toEqual([0.85, 0.7, 0.55])
    expect(codec.encodeCalls.some((c) => c.maxEdge < 1600)).toBe(true)
  })

  it('refuses as too_large when nothing shrinks, and never asks for less than 800 px', async () => {
    const codec = fakeCodec({ sizeFor: () => 2 * MB })
    const r = await importImage({ bytes: png({ pad: 5000 }), name: 'a.png' }, ctxFor(codec))
    expect(r).toMatchObject({ ok: false, reason: 'too_large', name: 'a.png' })
    expect(Math.min(...codec.encodeCalls.map((c) => c.maxEdge))).toBeGreaterThanOrEqual(800)
  })

  it('keeps a small WebP byte for byte, so pasting our own output dedupes to one blob', async () => {
    const codec = fakeCodec({ w: 1200, h: 800 })
    const ctx = ctxFor(codec)
    const bytes = webp({ pad: 3000 })
    const first = await importImage({ bytes, name: 'x.webp' }, ctx)
    expect(first.ok && first.isNew).toBe(true)
    if (!first.ok) return
    ctx.doc.images[first.id] = first.meta
    const second = await importImage({ bytes, name: 'again.webp' }, ctx)
    expect(second.ok && second.id).toBe(first.id)
    expect(second.ok && second.isNew).toBe(false)
    expect(codec.encodeCalls).toHaveLength(0)
    expect([...(await ctx.images.getPlain(first.id))!]).toEqual([...bytes])
  })

  it('stores an animated GIF as its original bytes when it fits, and refuses one over 1 MB', async () => {
    const small = gif(3, 100)
    const codec = fakeCodec({ w: 200, h: 100 })
    const ctx = ctxFor(codec)
    const ok = await importImage({ bytes: small, name: 'anim.gif' }, ctx)
    expect(ok.ok && ok.meta.mime).toBe('image/gif')
    expect(codec.encodeCalls).toHaveLength(0)
    const big = await importImage({ bytes: gif(3, MB + 10), name: 'big.gif' }, ctxFor(fakeCodec()))
    expect(big).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('treats APNG and animated WebP the same way', async () => {
    const ctx = ctxFor(fakeCodec({ w: 100, h: 100 }))
    expect((await importImage({ bytes: png({ animated: true }), name: 'a.png' }, ctx)).ok).toBe(true)
    expect((await importImage({ bytes: webp({ animated: true }), name: 'a.webp' }, ctx)).ok).toBe(true)
    const bigApng = await importImage({ bytes: png({ animated: true, pad: MB + 10 }), name: 'b.png' }, ctx)
    expect(bigApng).toMatchObject({ ok: false, reason: 'too_large' })
    const bigWebp = await importImage({ bytes: webp({ animated: true, pad: MB + 10 }), name: 'b.webp' }, ctx)
    expect(bigWebp).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('refuses random bytes as unsupported and a truncated image as corrupt', async () => {
    expect(await importImage({ bytes: new Uint8Array(40).fill(9), name: 'x.bin' }, ctxFor(fakeCodec())))
      .toMatchObject({ ok: false, reason: 'unsupported' })
    expect(await importImage({ bytes: png(), name: 'cut.png' }, ctxFor(fakeCodec({ decodeFails: true }))))
      .toMatchObject({ ok: false, reason: 'corrupt' })
  })

  it('builds the alt from the file name without extension and without bracket characters', async () => {
    const codec = fakeCodec({ w: 100, h: 100 })
    const a = await importImage({ bytes: png({ pad: 10 }), name: 'my[photo](1).final.png' }, ctxFor(codec))
    expect(a.ok && a.alt).toBe('myphoto1.final')
    const b = await importImage({ bytes: png({ pad: 11 }), name: '' }, ctxFor(codec))
    expect(b.ok && b.alt).toBe('')
  })

  it('keeps the original when re-encoding would make it bigger and the original already fits', async () => {
    const original = png({ pad: 500 })
    const codec = fakeCodec({ w: 400, h: 300, sizeFor: () => 5000 })
    const ctx = ctxFor(codec)
    const r = await importImage({ bytes: original, name: 'a.png' }, ctx)
    expect(r.ok && r.meta.mime).toBe('image/png')
    if (r.ok) expect([...(await ctx.images.getPlain(r.id))!]).toEqual([...original])
  })

  it('picks up the right mime for a kept original of each kind', async () => {
    const ctx = ctxFor(fakeCodec({ w: 50, h: 50, sizeFor: () => 99999 }))
    const jp = await importImage({ bytes: jpeg(), name: 'a.jpg' }, ctx)
    expect(jp.ok && jp.meta.mime).toBe('image/jpeg')
    const bm = await importImage({ bytes: bmp(), name: 'a.bmp' }, ctx)
    expect(bm.ok && bm.meta.mime).toBe('image/bmp')
    const av = await importImage({ bytes: avif(), name: 'a.avif' }, ctx)
    expect(av.ok && av.meta.mime).toBe('image/avif')
  })
})

describe('importImages', () => {
  function docWithBytes(referenced: number): Doc {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('T1', 'T', '', 'en-US')
    const id = 'f'.repeat(32)
    team.generalNotes = imageRefLine(id, '')
    doc.teams.push(team)
    doc.images[id] = { mime: 'image/webp', w: 1, h: 1, bytes: referenced }
    return doc
  }
  const input = (n: number) => ({ bytes: png({ pad: 100 + n }), name: `${n}.png` })

  it('stops at the first image that would cross the 150 MB cap and refuses it and the rest', async () => {
    const codec = fakeCodec({ sizeFor: () => 700 })
    const doc = docWithBytes(150 * MB - 1500)
    const { results } = await importImages([input(1), input(2), input(3)], ctxFor(codec, doc))
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['ok', 'ok', 'cap_reached'])
    expect(codec.encodeCalls).toHaveLength(3)
  })

  it('does not even process the images after the first cap refusal', async () => {
    const codec = fakeCodec({ sizeFor: () => 700 })
    const doc = docWithBytes(150 * MB - 100)
    const { results } = await importImages([input(1), input(2)], ctxFor(codec, doc))
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['cap_reached', 'cap_reached'])
    expect(codec.encodeCalls).toHaveLength(1)
  })

  it('flags a batch that pushes referenced bytes past 100 MB', async () => {
    const codec = fakeCodec({ sizeFor: () => 700 })
    expect((await importImages([input(1)], ctxFor(codec, docWithBytes(100 * MB - 100)))).crossedWarn).toBe(true)
    expect((await importImages([input(1)], ctxFor(codec, docWithBytes(10 * MB)))).crossedWarn).toBe(false)
    expect((await importImages([input(1)], ctxFor(codec, docWithBytes(120 * MB)))).crossedWarn).toBe(false)
  })

  it('counts the cap on referenced bytes, not on leftovers nobody references', async () => {
    const codec = fakeCodec({ sizeFor: () => 700 })
    const doc = createEmptyDocument('en-US')
    doc.images['e'.repeat(32)] = { mime: 'image/webp', w: 1, h: 1, bytes: 200 * MB }
    const { results } = await importImages([input(1)], ctxFor(codec, doc))
    expect(results[0]!.ok).toBe(true)
  })

  it('the same picture twice in one batch is stored once and counted once', async () => {
    const codec = fakeCodec({ sizeFor: () => 700 })
    const ctx = ctxFor(codec)
    const same = { bytes: png({ pad: 300 }), name: 'a.png' }
    const { results } = await importImages([same, { ...same, name: 'b.png' }], ctx)
    const [a, b] = results
    expect(a!.ok && b!.ok && a!.id === b!.id).toBe(true)
    expect(b!.ok && b!.isNew).toBe(false)
  })
})
