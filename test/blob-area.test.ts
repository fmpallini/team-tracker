import { packBlobs, sliceBlob } from '../src/core/blob-area'

const bytes = (...n: number[]) => new Uint8Array(n)

describe('blob area', () => {
  it('round-trips blobs of different lengths', () => {
    const blobs = [
      { id: 'a', stored: bytes(1, 2, 3) },
      { id: 'b', stored: bytes(9) },
      { id: 'c', stored: bytes(5, 6, 7, 8, 9, 10) },
    ]
    const { area, index } = packBlobs(blobs)
    expect(area.length).toBe(10)
    for (const b of blobs) expect([...sliceBlob(area, index, b.id)!]).toEqual([...b.stored])
  })

  it('returns null for an unknown id', () => {
    const { area, index } = packBlobs([{ id: 'a', stored: bytes(1) }])
    expect(sliceBlob(area, index, 'zzz')).toBeNull()
  })

  it('returns null when an index entry points outside the area', () => {
    const { area } = packBlobs([{ id: 'a', stored: bytes(1, 2) }])
    expect(sliceBlob(area, { a: [1, 5] }, 'a')).toBeNull()
    expect(sliceBlob(area, { a: [-1, 1] }, 'a')).toBeNull()
    expect(sliceBlob(area, { a: [0.5, 1] }, 'a')).toBeNull()
  })

  it('packs nothing into an empty area', () => {
    const { area, index } = packBlobs([])
    expect(area.length).toBe(0)
    expect(index).toEqual({})
  })
})
