import { createImageHost } from '../src/ui/image-host'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createImageStore } from '../src/core/image-store'

const ID = 'a'.repeat(32)

function setup() {
  const doc = createEmptyDocument('en-US')
  doc.images[ID] = { mime: 'image/png', w: 4, h: 3, bytes: 3 }
  const images = createImageStore(null)
  images.putPlain(ID, new Uint8Array([1, 2, 3]))
  const store = createStore(doc, images)
  const getPlain = vi.spyOn(images, 'getPlain')
  return { store, images, getPlain, host: createImageHost(store) }
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
    expect(await createImageHost(setup().store).getDataUri('e'.repeat(32))).toBeNull()
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
