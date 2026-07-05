import { writeFile, forceWrite, ExternalChangeError, type FileSession } from '../src/core/fs'

function mockHandle(initialMtime: number) {
  let mtime = initialMtime
  let written: Uint8Array | null = null
  const handle = {
    name: 'x.tmv',
    async getFile() { return { lastModified: mtime, async arrayBuffer() { return (written ?? new Uint8Array()).buffer } } },
    async createWritable() {
      return { async write(b: Uint8Array) { written = b }, async close() { mtime += 1000 } }
    },
  } as unknown as FileSystemFileHandle
  return { handle, bump: () => { mtime += 5000 }, getWritten: () => written }
}

// idb é chamado dentro de writeFile — stub global mínimo p/ jsdom
vi.mock('../src/core/idb', () => ({ idbSet: async () => {}, idbGet: async () => undefined, idbDel: async () => {} }))

test('writeFile ok updates lastModified', async () => {
  const { handle, getWritten } = mockHandle(1000)
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  await writeFile(s, new Uint8Array([1, 2]))
  expect(getWritten()).toEqual(new Uint8Array([1, 2]))
  expect(s.lastModified).toBeGreaterThan(1000)
})

test('writeFile detects external change', async () => {
  const { handle, bump } = mockHandle(1000)
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  bump()
  await expect(writeFile(s, new Uint8Array([1]))).rejects.toBeInstanceOf(ExternalChangeError)
})

test('forceWrite ignores external change', async () => {
  const { handle, bump, getWritten } = mockHandle(1000)
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  bump()
  await forceWrite(s, new Uint8Array([9]))
  expect(getWritten()).toEqual(new Uint8Array([9]))
})
