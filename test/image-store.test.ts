import { createImageStore } from '../src/core/image-store'
import type { BlobCodec } from '../src/core/image-store'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Fake codec: "seals" by prefixing a tag, so tests can tell which codec produced the bytes. */
function fakeCodec(tag: string, log: string[] = [], failOpen = false): BlobCodec & { seals: number; opens: number } {
  const c = {
    seals: 0, opens: 0,
    async seal(id: string, plain: Uint8Array) { c.seals++; log.push(`${tag}.seal(${id})`); return enc.encode(tag + ':' + dec.decode(plain)) },
    async open(id: string, sealed: Uint8Array) {
      c.opens++; log.push(`${tag}.open(${id})`)
      if (failOpen) throw new Error('bad')
      const s = dec.decode(sealed)
      if (!s.startsWith(tag + ':')) throw new Error('wrong tag')
      return enc.encode(s.slice(tag.length + 1))
    },
  }
  return c
}

describe('image store', () => {
  it('getPlain after putPlain returns the bytes without touching the codec', async () => {
    const codec = fakeCodec('k')
    const store = createImageStore(codec)
    store.putPlain('a', enc.encode('hello'))
    expect(dec.decode((await store.getPlain('a'))!)).toBe('hello')
    expect(codec.opens).toBe(0)
    expect(store.has('a')).toBe(true)
  })

  it('discard forgets an image in both forms', async () => {
    const store = createImageStore(fakeCodec('k'))
    store.putPlain('a', enc.encode('hello'))
    await store.getStored('a')
    store.discard('a')
    expect(store.has('a')).toBe(false)
    expect(await store.getPlain('a')).toBeNull()
    expect(await store.getStored('a')).toBeNull()
  })

  it('opens an adopted blob for each reader and does not keep a second, plain copy of it', async () => {
    const codec = fakeCodec('k')
    const store = createImageStore(codec)
    store.adoptStored('a', enc.encode('k:hello'))
    expect(dec.decode((await store.getPlain('a'))!)).toBe('hello')
    expect(dec.decode((await store.getPlain('a'))!)).toBe('hello')
    expect(codec.opens).toBe(2)
  })

  it('once an imported image is sealed only the sealed form is kept; reading it opens it again', async () => {
    const codec = fakeCodec('k')
    const store = createImageStore(codec)
    store.putPlain('a', enc.encode('hello'))
    expect(codec.opens).toBe(0)
    await store.getStored('a')
    expect(dec.decode((await store.getPlain('a'))!)).toBe('hello')
    expect(codec.opens).toBe(1)
    expect(codec.seals).toBe(1)
    // and a later write reuses the sealed bytes instead of sealing the re-opened copy again
    await store.getStored('a')
    expect(codec.seals).toBe(1)
  })

  it('returns null for a blob the codec cannot open, and still reports it as present', async () => {
    const store = createImageStore(fakeCodec('k', [], true))
    store.adoptStored('a', enc.encode('junk'))
    expect(await store.getPlain('a')).toBeNull()
    expect(store.has('a')).toBe(true)
  })

  it('getPlain of an unknown id is null', async () => {
    expect(await createImageStore(null).getPlain('nope')).toBeNull()
  })

  it('seals once and reuses the sealed bytes', async () => {
    const codec = fakeCodec('k')
    const store = createImageStore(codec)
    store.putPlain('a', enc.encode('hello'))
    const first = await store.getStored('a')
    const second = await store.getStored('a')
    expect(dec.decode(first!)).toBe('k:hello')
    expect(second).toBe(first)
    expect(codec.seals).toBe(1)
  })

  it('an adopted blob is written back as the very same sealed bytes (no re-seal)', async () => {
    const codec = fakeCodec('k')
    const store = createImageStore(codec)
    const sealed = enc.encode('k:hello')
    store.adoptStored('a', sealed)
    expect(await store.getStored('a')).toBe(sealed)
    expect(codec.seals).toBe(0)
    expect(codec.opens).toBe(0)
  })

  it('with a null codec the stored bytes are the plain bytes', async () => {
    const store = createImageStore(null)
    store.putPlain('a', enc.encode('raw'))
    expect(dec.decode((await store.getStored('a'))!)).toBe('raw')
    store.adoptStored('b', enc.encode('raw2'))
    expect(dec.decode((await store.getPlain('b'))!)).toBe('raw2')
  })

  it('rekey loads plain bytes with the OLD codec, then seals with the NEW one', async () => {
    const log: string[] = []
    const oldCodec = fakeCodec('old', log)
    const newCodec = fakeCodec('new', log)
    const store = createImageStore(oldCodec)
    store.adoptStored('a', enc.encode('old:one'))
    store.putPlain('b', enc.encode('two'))
    await store.rekey(newCodec)
    expect(dec.decode((await store.getStored('a'))!)).toBe('new:one')
    expect(dec.decode((await store.getStored('b'))!)).toBe('new:two')
    expect(log.indexOf('old.open(a)')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('old.open(a)')).toBeLessThan(log.indexOf('new.seal(a)'))
  })

  it('rekey keeps the images readable and writable when they were already sealed (the plain form is gone)', async () => {
    const store = createImageStore(fakeCodec('old'))
    store.putPlain('a', enc.encode('one'))
    await store.getStored('a')
    const next = fakeCodec('new')
    await store.rekey(next)
    expect(dec.decode((await store.getPlain('a'))!)).toBe('one')
    expect(dec.decode((await store.getStored('a'))!)).toBe('new:one')
  })

  it('rekey to null makes stored bytes plain', async () => {
    const store = createImageStore(fakeCodec('k'))
    store.putPlain('a', enc.encode('x'))
    await store.rekey(null)
    expect(dec.decode((await store.getStored('a'))!)).toBe('x')
  })

  it('rekey leaves an unreadable blob unreadable and out of getStored', async () => {
    const store = createImageStore(fakeCodec('old', [], true))
    store.adoptStored('a', enc.encode('junk'))
    await store.rekey(fakeCodec('new'))
    expect(await store.getStored('a')).toBeNull()
  })
})
