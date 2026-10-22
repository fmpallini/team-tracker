// src/ui/image-codec.ts — the browser half of the image import pipeline
// (core/image-import.ts injects it as an `ImageCodec`): decode with
// createImageBitmap, re-encode through a canvas. Real decoding and encoding
// can't run in jsdom; test/image-codec.test.ts stubs both, and e2e proves the
// real thing.
import type { ImageCodec } from '../core/image-import'

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

interface Surface {
  ctx: Ctx2D
  toBlob(type: string, quality: number): Promise<Blob | null>
}

/** A canvas of the given pixel size: OffscreenCanvas where it exists, a detached <canvas> otherwise. */
function makeSurface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    return {
      ctx: canvas.getContext('2d') as OffscreenCanvasRenderingContext2D,
      toBlob: (type, quality) => canvas.convertToBlob({ type, quality }).catch(() => null),
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return {
    ctx: canvas.getContext('2d') as CanvasRenderingContext2D,
    toBlob: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
  }
}

function hasTransparency(ctx: Ctx2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h)
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true
  return false
}

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

export const browserImageCodec: ImageCodec = {
  async decode(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
    try {
      return { w: bitmap.width, h: bitmap.height }
    } finally {
      bitmap.close()
    }
  },

  async encode(bytes, { maxEdge, quality }) {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const surface = makeSurface(w, h)
      surface.ctx.drawImage(bitmap, 0, 0, w, h)

      const webp = await surface.toBlob('image/webp', quality)
      if (webp && webp.type === 'image/webp') return { bytes: await toBytes(webp), mime: 'image/webp', w, h }

      // This browser cannot encode WebP (it hands back PNG instead). Keep
      // transparency in a PNG; anything opaque goes to JPEG on a white fill.
      if (hasTransparency(surface.ctx, w, h)) {
        const png = await surface.toBlob('image/png', quality)
        if (!png) throw new Error('image encode failed')
        return { bytes: await toBytes(png), mime: 'image/png', w, h }
      }
      surface.ctx.clearRect(0, 0, w, h)
      surface.ctx.fillStyle = '#fff'
      surface.ctx.fillRect(0, 0, w, h)
      surface.ctx.drawImage(bitmap, 0, 0, w, h)
      const jpeg = await surface.toBlob('image/jpeg', quality)
      if (!jpeg) throw new Error('image encode failed')
      return { bytes: await toBytes(jpeg), mime: 'image/jpeg', w, h }
    } finally {
      bitmap.close()
    }
  },
}
