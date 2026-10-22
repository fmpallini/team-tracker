import { browserImageCodec } from '../src/ui/image-codec'

// jsdom has neither createImageBitmap nor a canvas, so both are stubbed with
// just the surface the codec uses. Real-browser behavior is proven in e2e.
interface CanvasLog { drawn: unknown[][]; fills: string[]; order: string[]; blobCalls: { type: string; quality?: number }[]; size: [number, number] | null }

let log: CanvasLog
let webpWorks = true
let alphaPixel = false
let closed = 0

beforeEach(() => {
  log = { drawn: [], fills: [], order: [], blobCalls: [], size: null }
  webpWorks = true
  alphaPixel = false
  closed = 0
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
    if (blob.size === 1) throw new Error('cannot decode')
    return { width: dims.w, height: dims.h, close: () => { closed++ } }
  }))
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w: number, h: number) { log.size = [w, h] }
    getContext() {
      return {
        fillStyle: '',
        fillRect: () => { log.order.push('fill') },
        drawImage: (...args: unknown[]) => { log.drawn.push(args); log.order.push('draw') },
        getImageData: () => ({ data: new Uint8ClampedArray(alphaPixel ? [0, 0, 0, 0, 255, 255, 255, 255] : [0, 0, 0, 255, 255, 255, 255, 255]) }),
        clearRect: () => { log.order.push('clear') },
      }
    }
    async convertToBlob(o: { type: string; quality?: number }) {
      log.blobCalls.push(o)
      const type = o.type === 'image/webp' && !webpWorks ? 'image/png' : o.type
      return new Blob([new Uint8Array([1, 2, 3])], { type })
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

const dims = { w: 3000, h: 2000 }
const input = new Uint8Array([1, 2, 3, 4])

describe('browserImageCodec.decode', () => {
  it('reads the pixel size and releases the bitmap', async () => {
    expect(await browserImageCodec.decode(input)).toEqual({ w: 3000, h: 2000 })
    expect(closed).toBe(1)
  })

  it('rejects when the browser cannot decode the bytes', async () => {
    await expect(browserImageCodec.decode(new Uint8Array([1]))).rejects.toThrow()
  })
})

describe('browserImageCodec.encode', () => {
  it('scales so the long edge is the cap, keeping the aspect ratio', async () => {
    dims.w = 3000; dims.h = 2000
    const out = await browserImageCodec.encode(input, { maxEdge: 1600, quality: 0.85 })
    expect(log.size).toEqual([1600, 1067])
    expect(log.drawn[0]!.slice(1)).toEqual([0, 0, 1600, 1067])
    expect(out).toMatchObject({ mime: 'image/webp', w: 1600, h: 1067 })
    expect([...out.bytes]).toEqual([1, 2, 3])
    expect(log.blobCalls).toEqual([{ type: 'image/webp', quality: 0.85 }])
    expect(closed).toBe(1)
  })

  it('never upscales', async () => {
    dims.w = 800; dims.h = 600
    const out = await browserImageCodec.encode(input, { maxEdge: 1600, quality: 0.7 })
    expect(out).toMatchObject({ w: 800, h: 600 })
  })

  it('falls back to PNG for a picture with transparency when the browser cannot encode WebP', async () => {
    dims.w = 100; dims.h = 100
    webpWorks = false
    alphaPixel = true
    const out = await browserImageCodec.encode(input, { maxEdge: 1600, quality: 0.85 })
    expect(out.mime).toBe('image/png')
    expect(log.blobCalls.map((c) => c.type)).toEqual(['image/webp', 'image/png'])
  })

  it('falls back to JPEG on a white fill for an opaque picture', async () => {
    dims.w = 100; dims.h = 100
    webpWorks = false
    alphaPixel = false
    const out = await browserImageCodec.encode(input, { maxEdge: 1600, quality: 0.55 })
    expect(out.mime).toBe('image/jpeg')
    expect(log.blobCalls.at(-1)).toEqual({ type: 'image/jpeg', quality: 0.55 })
    // the second pass paints white before the picture goes on top
    expect(log.order.slice(-3)).toEqual(['clear', 'fill', 'draw'].slice(0, 3))
  })
})
