import { writeFile, forceWrite, openFromHandle, sameEntry, pickCreateBackup, ExternalChangeError, type FileSession } from '../src/core/fs'

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

// idb é chamado dentro de writeFile — stub global mínimo p/ jsdom.
// `idbSet` is a spy (not a bare stub) so the pickCreateBackup tests below can
// assert it never touches the 'lastHandle' key.
const idbMocks = vi.hoisted(() => ({
  idbSet: vi.fn(async (_key: string, _value: unknown) => {}),
  idbGet: vi.fn(async (_key: string) => undefined as unknown),
  idbDel: vi.fn(async (_key: string) => {}),
}))
vi.mock('../src/core/idb', () => idbMocks)

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

// --- pickCreateBackup ------------------------------------------------------
// The .bck picker is deliberately separate from pickCreate: the daily-backup
// file must never become the "reopen last" target.
function stubSaveFilePicker(result: FileSystemFileHandle | Error) {
  const picker = vi.fn(async (_options?: SaveFilePickerOptions): Promise<FileSystemFileHandle> => {
    if (result instanceof Error) throw result
    return result
  })
  window.showSaveFilePicker = picker
  return picker
}

beforeEach(() => {
  idbMocks.idbSet.mockClear()
  idbMocks.idbGet.mockClear()
})

test('pickCreateBackup never repoints lastHandle at the .bck file', async () => {
  const { handle } = mockHandle(1000)
  stubSaveFilePicker(handle)
  const session = await pickCreateBackup('team-tracker.bck')
  expect(session).not.toBeNull()
  expect(session!.handle).toBe(handle)
  // The whole point: pickCreate() ends with idbSet('lastHandle', handle), which
  // would make the next launch reopen the empty .bck and report a bogus
  // "corrupt file" error instead of opening the user's .tmv.
  expect(idbMocks.idbSet.mock.calls.filter((c) => c[0] === 'lastHandle')).toHaveLength(0)
  expect(idbMocks.idbSet).not.toHaveBeenCalled()
})

test('pickCreateBackup filters the picker on .bck, not .tmv', async () => {
  const { handle } = mockHandle(1000)
  const picker = stubSaveFilePicker(handle)
  await pickCreateBackup('team-tracker.bck')
  const opts = picker.mock.calls[0]![0]!
  expect(opts.suggestedName).toBe('team-tracker.bck')
  const extensions = Object.values(opts.types![0]!.accept).flat()
  expect(extensions).toEqual(['.bck'])
})

test('pickCreateBackup returns null when the user cancels the picker', async () => {
  const abort = new Error('cancelled')
  abort.name = 'AbortError'
  stubSaveFilePicker(abort)
  expect(await pickCreateBackup('team-tracker.bck')).toBeNull()
})

test('pickCreateBackup passes the given handle through as startIn, so the picker opens in that folder', async () => {
  const { handle } = mockHandle(1000)
  const picker = stubSaveFilePicker(handle)
  const primaryHandle = {} as unknown as FileSystemFileHandle
  await pickCreateBackup('team-tracker.bck', primaryHandle)
  const opts = picker.mock.calls[0]![0]!
  expect(opts.startIn).toBe(primaryHandle)
})

test('pickCreateBackup omits startIn when no handle is given', async () => {
  const { handle } = mockHandle(1000)
  const picker = stubSaveFilePicker(handle)
  await pickCreateBackup('team-tracker.bck')
  const opts = picker.mock.calls[0]![0]!
  expect(opts.startIn).toBeUndefined()
})
