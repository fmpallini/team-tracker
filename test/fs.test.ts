import { writeFile, forceWrite, openFromHandle, sameEntry, ExternalChangeError, type FileSession } from '../src/core/fs'

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

function mockLaunchHandle(permission: 'granted' | 'prompt' | 'denied') {
  const handle = {
    name: 'launched.tmv',
    async getFile() { return { lastModified: 42, async arrayBuffer() { return new Uint8Array([7]).buffer } } },
    async queryPermission() { return permission },
    async requestPermission() { return permission === 'prompt' ? 'granted' : permission },
  } as unknown as FileSystemFileHandle
  return handle
}

test('openFromHandle reads the file when permission is already granted', async () => {
  const handle = mockLaunchHandle('granted')
  const result = await openFromHandle(handle)
  expect(result).not.toBeNull()
  expect(result!.session).toEqual({ handle, name: 'launched.tmv', lastModified: 42 })
  expect(result!.bytes).toEqual(new Uint8Array([7]))
})

test('openFromHandle requests permission when not yet granted, then reads', async () => {
  const handle = mockLaunchHandle('prompt')
  const result = await openFromHandle(handle)
  expect(result).not.toBeNull()
  expect(result!.bytes).toEqual(new Uint8Array([7]))
})

test('openFromHandle returns null when permission is denied', async () => {
  const handle = mockLaunchHandle('denied')
  const result = await openFromHandle(handle)
  expect(result).toBeNull()
})

test('sameEntry delegates to handle.isSameEntry', async () => {
  const isSameEntry = vi.fn(async () => true)
  const handleA = { isSameEntry } as unknown as FileSystemFileHandle
  const handleB = {} as unknown as FileSystemFileHandle
  const s1: FileSession = { handle: handleA, name: 'x.tmv', lastModified: 1 }
  const s2: FileSession = { handle: handleB, name: 'x.tmv', lastModified: 1 }
  expect(await sameEntry(s1, s2)).toBe(true)
  expect(isSameEntry).toHaveBeenCalledWith(handleB)
})

test('sameEntry false when either session has no handle (fallback mode)', async () => {
  const withHandle: FileSession = { handle: mockLaunchHandle('granted'), name: 'x.tmv', lastModified: 1 }
  const fallback: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  expect(await sameEntry(withHandle, fallback)).toBe(false)
  expect(await sameEntry(fallback, fallback)).toBe(false)
})
