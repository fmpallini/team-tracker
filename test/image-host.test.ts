import { createImageHost } from '../src/ui/image-host'
import { IMAGE_LIMITS, type ImageCodec } from '../src/core/image-import'
import { t } from '../src/core/i18n'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createImageStore } from '../src/core/image-store'

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

const ID = 'a'.repeat(32)

function setup() {
  const doc = createEmptyDocument('en-US')
  doc.images[ID] = { mime: 'image/png', w: 4, h: 3, bytes: 3 }
  const images = createImageStore(null)
  images.putPlain(ID, new Uint8Array([1, 2, 3]))
  const store = createStore(doc, images)
  const getPlain = vi.spyOn(images, 'getPlain')
  return { store, images, getPlain, host: createImageHost(store, 'en-US') }
}

describe('ImageHost', () => {
  it('turns the stored bytes into a data URI with the recorded mime type', async () => {
    const { host } = setup()
    expect(await host.getDataUri(ID)).toBe('data:image/png;base64,AQID')
  })

  it('builds each URI once (second call is served from the cache)', async () => {
    const { host, getPlain } = setup()
    const first = await host.getDataUri(ID)
    const second = await host.getDataUri(ID)
    expect(second).toBe(first)
    expect(getPlain).toHaveBeenCalledTimes(1)
  })

  it('handles an image bigger than one base64 slice', async () => {
    const { store, images, host } = setup()
    const big = new Uint8Array(200_000).fill(7)
    store.doc.images['b'.repeat(32)] = { mime: 'image/webp', w: 1, h: 1, bytes: big.length }
    images.putPlain('b'.repeat(32), big)
    const uri = (await host.getDataUri('b'.repeat(32)))!
    expect(uri.startsWith('data:image/webp;base64,')).toBe(true)
    expect(atob(uri.split(',')[1]!).length).toBe(200_000)
  })

  it('returns null for an unknown id and for bytes that cannot be read', async () => {
    const { host, images } = setup()
    expect(await host.getDataUri('f'.repeat(32))).toBeNull()
    vi.spyOn(images, 'getPlain').mockResolvedValue(null)
    expect(await createImageHost(setup().store, 'en-US').getDataUri('e'.repeat(32))).toBeNull()
  })

  it('does not remember a miss: the bytes may show up later', async () => {
    const { host, store } = setup()
    const later = 'c'.repeat(32)
    expect(await host.getDataUri(later)).toBeNull()
    store.doc.images[later] = { mime: 'image/png', w: 1, h: 1, bytes: 1 }
    store.images.putPlain(later, new Uint8Array([9]))
    expect(await host.getDataUri(later)).toBe('data:image/png;base64,CQ==')
  })

  it('dispose empties the cache', async () => {
    const { host, getPlain } = setup()
    await host.getDataUri(ID)
    host.dispose()
    await host.getDataUri(ID)
    expect(getPlain).toHaveBeenCalledTimes(2)
  })

  it('exposes the size recorded in the document', () => {
    const { host } = setup()
    expect(host.getMeta(ID)).toEqual({ mime: 'image/png', w: 4, h: 3, bytes: 3 })
    expect(host.getMeta('f'.repeat(32))).toBeUndefined()
  })
})

describe('importFiles', () => {
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const pngFile = (name: string, pad = 0) => new File([new Uint8Array([...MAGIC, ...new Array(8 + pad).fill(1)])], name, { type: 'image/png' })
  const textFile = () => new File([new TextEncoder().encode('hello there, I am not an image')], 'notes.txt', { type: 'text/plain' })

  function fakeCodec(size = 500): ImageCodec {
    return {
      decode: async () => ({ w: 100, h: 80 }),
      encode: async (input) => { const out = new Uint8Array(size); out[0] = input.length & 255; out[1] = (input.length >> 8) & 255; return { bytes: out, mime: 'image/webp', w: 100, h: 80 } },
    }
  }
  function build(codec = fakeCodec(), onShowUsage = vi.fn()) {
    const doc = createEmptyDocument('en-US')
    const store = createStore(doc, createImageStore(null))
    const update = vi.spyOn(store, 'update')
    return { store, update, onShowUsage, host: createImageHost(store, 'en-US', codec, onShowUsage) }
  }
  beforeEach(() => modalMocks.toast.mockReset())

  it('imports the files, records them in the document in ONE update, and answers in input order', async () => {
    const { host, store, update } = build()
    const items = await host.importFiles([pngFile('one.png', 1), pngFile('two.png', 2)])
    expect(items.map((i) => i?.alt)).toEqual(['one', 'two'])
    expect(update).toHaveBeenCalledTimes(1)
    expect(Object.keys(store.doc.images)).toEqual(items.map((i) => i!.id))
    expect(store.dirty).toBe(true)
  })

  it('shows one aggregated toast per batch, replaced by key', async () => {
    const { host } = build()
    await host.importFiles([pngFile('one.png', 1), pngFile('two.png', 2)])
    expect(modalMocks.toast).toHaveBeenCalledTimes(1)
    expect(modalMocks.toast).toHaveBeenCalledWith(t('en-US', 'img_added', { n: '2' }), { kind: 'success', key: 'image-import' })
  })

  it('reports refusals next to the count, and keeps the aligned slot empty', async () => {
    const { host } = build()
    const items = await host.importFiles([pngFile('one.png', 1), textFile()])
    expect(items[0]).not.toBeNull()
    expect(items[1]).toBeNull()
    expect(modalMocks.toast).toHaveBeenCalledWith(
      t('en-US', 'img_added_partial', { n: '1', m: '1', why: t('en-US', 'img_reason_unsupported') }), { kind: 'warn', key: 'image-import' })
  })

  it('says only images can be added when nothing in the batch was an image', async () => {
    const { host, update } = build()
    expect(await host.importFiles([textFile()])).toEqual([null])
    expect(modalMocks.toast).toHaveBeenCalledWith(t('en-US', 'img_only_images'), { kind: 'warn', key: 'image-import' })
    expect(update).not.toHaveBeenCalled()
  })

  it('a codec failure on one image is reported, not thrown', async () => {
    const codec = fakeCodec()
    codec.decode = async () => { throw new Error('boom') }
    const { host } = build(codec)
    expect(await host.importFiles([pngFile('bad.png')])).toEqual([null])
    expect(modalMocks.toast).toHaveBeenCalledWith(
      t('en-US', 'img_added_partial', { n: '0', m: '1', why: t('en-US', 'img_reason_corrupt') }), { kind: 'warn', key: 'image-import' })
  })

  it('does not even read a file over the source size limit', async () => {
    const { host } = build()
    const huge = pngFile('huge.png')
    Object.defineProperty(huge, 'size', { value: IMAGE_LIMITS.maxSourceBytes + 1 })
    const read = vi.spyOn(huge, 'arrayBuffer')
    expect(await host.importFiles([huge])).toEqual([null])
    expect(read).not.toHaveBeenCalled()
    expect(modalMocks.toast).toHaveBeenCalledWith(
      t('en-US', 'img_added_partial', { n: '0', m: '1', why: t('en-US', 'img_reason_too_large') }), { kind: 'warn', key: 'image-import' })
  })

  it('the same picture twice is stored once', async () => {
    const { host, store } = build()
    const items = await host.importFiles([pngFile('a.png', 3), pngFile('b.png', 3)])
    expect(items[0]!.id).toBe(items[1]!.id)
    expect(Object.keys(store.doc.images)).toHaveLength(1)
  })

  it('at the cap: a cap toast whose action opens the usage view', async () => {
    const { host, store, onShowUsage } = build()
    store.doc.teams.push({ id: 'T', name: 'T', emoji: '', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {}, generalNotes: `![x](img:${'e'.repeat(32)})` })
    store.doc.images['e'.repeat(32)] = { mime: 'image/webp', w: 1, h: 1, bytes: IMAGE_LIMITS.totalCapBytes }
    expect(await host.importFiles([pngFile('late.png')])).toEqual([null])
    const [msg, opts] = modalMocks.toast.mock.calls.at(-1)!
    expect(msg).toBe(t('en-US', 'img_cap_toast'))
    expect(opts.key).toBe('image-import')
    expect(opts.action.label).toBe(t('en-US', 'img_show_usage'))
    opts.action.onClick()
    expect(onShowUsage).toHaveBeenCalledTimes(1)
  })

  it('crossing 100 MB adds a warning toast with the usage', async () => {
    const { host, store } = build(fakeCodec(500))
    store.doc.teams.push({ id: 'T', name: 'T', emoji: '', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {}, generalNotes: `![x](img:${'e'.repeat(32)})` })
    store.doc.images['e'.repeat(32)] = { mime: 'image/webp', w: 1, h: 1, bytes: IMAGE_LIMITS.warnBytes - 100 }
    await host.importFiles([pngFile('tip.png', 2000)])
    expect(modalMocks.toast).toHaveBeenCalledWith(t('en-US', 'img_warn_toast', { used: '100.0 MB', cap: '150 MB' }), { kind: 'warn', key: 'image-warn' })
  })
})
