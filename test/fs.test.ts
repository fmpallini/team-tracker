import { writeFile, forceWrite, openFromHandle, reopenLast, peekLastFile, sameEntry, pickCreateBackup, pickCreate, pickOpen, readCurrent, downloadFallback, ExternalChangeError, type FileSession } from '../src/core/fs'

function mockHandle(initialMtime: number, permission?: PermissionState) {
  let mtime = initialMtime
  let written: Uint8Array | null = null
  const createWritable = vi.fn(async () => ({
    async write(b: Uint8Array) { written = b },
    async close() { mtime += 1000 },
  }))
  const handle = {
    name: 'x.tmv',
    async getFile() { return { lastModified: mtime, async arrayBuffer() { return (written ?? new Uint8Array()).buffer } } },
    createWritable,
    // Omitted entirely when no permission is given, so the pre-write
    // `assertWritable()` check is skipped for the pre-existing tests.
    ...(permission ? { queryPermission: vi.fn(async () => permission) } : {}),
  } as unknown as FileSystemFileHandle
  return { handle, createWritable, bump: () => { mtime += 5000 }, getWritten: () => written }
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

test('writeFile rejects with NotAllowedError before touching createWritable when the readwrite grant is missing', async () => {
  const { handle, createWritable } = mockHandle(1000, 'prompt')
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  await expect(writeFile(s, new Uint8Array([1]))).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(createWritable).not.toHaveBeenCalled()
})

test('writeFile proceeds normally when queryPermission reports the grant is live', async () => {
  const { handle, getWritten } = mockHandle(1000, 'granted')
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  await writeFile(s, new Uint8Array([5]))
  expect(getWritten()).toEqual(new Uint8Array([5]))
})

test('forceWrite also refuses, with NotAllowedError, when the readwrite grant is missing', async () => {
  const { handle, createWritable } = mockHandle(1000, 'denied')
  const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
  await expect(forceWrite(s, new Uint8Array([1]))).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(createWritable).not.toHaveBeenCalled()
})

function mockLaunchHandle(permission: 'granted' | 'prompt' | 'denied') {
  const handle = {
    name: 'launched.tmv',
    async getFile() { return { lastModified: 42, async arrayBuffer() { return new Uint8Array([7]).buffer } } },
    async queryPermission() { return permission },
    requestPermission: vi.fn(async () => (permission === 'prompt' ? 'granted' : permission)),
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

test('openFromHandle persists the handle to lastHandle by default (the File Handling API launch path)', async () => {
  idbMocks.idbSet.mockClear()
  const handle = mockLaunchHandle('granted')
  await openFromHandle(handle)
  expect(idbMocks.idbSet).toHaveBeenCalledWith('lastHandle', handle)
})

test('reopenLast opens via openFromHandle without re-persisting lastHandle (persist:false — it already came from that IDB entry)', async () => {
  idbMocks.idbSet.mockClear()
  const handle = mockLaunchHandle('granted')
  idbMocks.idbGet.mockResolvedValueOnce(handle)
  const result = await reopenLast()
  expect(result).not.toBeNull()
  expect(result!.session).toEqual({ handle, name: 'launched.tmv', lastModified: 42 })
  expect(idbMocks.idbSet).not.toHaveBeenCalled()
})

test('reopenLast returns null when there is no stored handle', async () => {
  idbMocks.idbGet.mockResolvedValueOnce(undefined)
  expect(await reopenLast()).toBeNull()
})

test('peekLastFile returns null when there is no stored handle', async () => {
  idbMocks.idbGet.mockResolvedValueOnce(undefined)
  expect(await peekLastFile()).toBeNull()
})

test('peekLastFile returns null without ever prompting when permission is not silently granted', async () => {
  const handle = mockLaunchHandle('prompt')
  idbMocks.idbGet.mockResolvedValueOnce(handle)
  const result = await peekLastFile()
  expect(result).toBeNull()
  expect(handle.requestPermission).not.toHaveBeenCalled()
})

test('peekLastFile reads session+bytes silently when permission is already granted', async () => {
  const handle = mockLaunchHandle('granted')
  idbMocks.idbGet.mockResolvedValueOnce(handle)
  const result = await peekLastFile()
  expect(result).not.toBeNull()
  expect(result!.session).toEqual({ handle, name: 'launched.tmv', lastModified: 42 })
  expect(result!.bytes).toEqual(new Uint8Array([7]))
  expect(handle.requestPermission).not.toHaveBeenCalled()
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

test('pickCreateBackup rethrows a non-cancel error (e.g. permission denied) instead of swallowing it as a cancel', async () => {
  const denied = new Error('not allowed')
  denied.name = 'NotAllowedError'
  stubSaveFilePicker(denied)
  await expect(pickCreateBackup('team-tracker.bck')).rejects.toThrow('not allowed')
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

test('pickCreate does not repoint lastHandle: the picked file is still empty until its first write', async () => {
  // Cancelling the create flow's password prompt used to leave lastHandle on a
  // 0-byte file, which "reopen last" then reported as corrupt. writeFile /
  // forceWrite set the pointer once real bytes are on disk.
  const { handle } = mockHandle(1000)
  stubSaveFilePicker(handle)
  const session = await pickCreate('team-tracker.tmv')
  expect(session!.handle).toBe(handle)
  expect(idbMocks.idbSet).not.toHaveBeenCalled()
})

test('writeFile repoints lastHandle once the bytes are written', async () => {
  const { handle } = mockHandle(1000)
  await writeFile({ handle, name: 'x.tmv', lastModified: 1000 }, new Uint8Array([1]))
  expect(idbMocks.idbSet).toHaveBeenCalledWith('lastHandle', handle)
})

describe('the lastHandle pointer is best-effort', () => {
  beforeEach(() => {
    idbMocks.idbSet.mockReset()
    idbMocks.idbSet.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    idbMocks.idbSet.mockReset()
    idbMocks.idbSet.mockResolvedValue(undefined)
    vi.restoreAllMocks()
  })

  test('writeFile still succeeds (bytes on disk, lastModified advanced) when IndexedDB rejects', async () => {
    const { handle, getWritten } = mockHandle(1000)
    const s: FileSession = { handle, name: 'x.tmv', lastModified: 1000 }
    await expect(writeFile(s, new Uint8Array([4]))).resolves.toBeUndefined()
    expect(getWritten()).toEqual(new Uint8Array([4]))
    expect(s.lastModified).toBeGreaterThan(1000)
    expect(console.error).toHaveBeenCalled()
  })

  test('forceWrite still succeeds when IndexedDB rejects', async () => {
    const { handle, getWritten } = mockHandle(1000)
    await expect(forceWrite({ handle, name: 'x.tmv', lastModified: 1 }, new Uint8Array([6]))).resolves.toBeUndefined()
    expect(getWritten()).toEqual(new Uint8Array([6]))
  })

  test('openFromHandle still returns the file when IndexedDB rejects', async () => {
    const result = await openFromHandle(mockLaunchHandle('granted'))
    expect(result!.bytes).toEqual(new Uint8Array([7]))
  })

  test('pickOpen still returns the file when IndexedDB rejects', async () => {
    const handle = mockLaunchHandle('granted')
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: vi.fn(async () => [handle]) })
    try {
      const result = await pickOpen()
      expect(result!.session.handle).toBe(handle)
      expect(result!.bytes).toEqual(new Uint8Array([7]))
    } finally {
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker
    }
  })
})

describe('external-change detection compares content when only the mtime differs', () => {
  /** A handle whose on-disk bytes and mtime the test controls independently. */
  function diskHandle(initial: Uint8Array, mtime: number) {
    let bytes = initial
    let m = mtime
    const handle = {
      name: 'x.tmv',
      async getFile() { const b = bytes; return { lastModified: m, size: b.length, async arrayBuffer() { return b.slice().buffer } } },
      async createWritable() { return { async write(b: Uint8Array) { bytes = b }, async close() { m += 1000 } } },
    } as unknown as FileSystemFileHandle
    return { handle, touch: () => { m += 5000 }, replace: (b: Uint8Array) => { bytes = b; m += 5000 }, current: () => bytes }
  }

  test('a touched-but-identical file (cloud sync, antivirus) is not a conflict', async () => {
    const disk = diskHandle(new Uint8Array([1, 2, 3]), 1000)
    const s: FileSession = { handle: disk.handle, name: 'x.tmv', lastModified: 1000 }
    await writeFile(s, new Uint8Array([1, 2, 3])) // records what is on disk
    disk.touch()
    await expect(writeFile(s, new Uint8Array([9, 9]))).resolves.toBeUndefined()
    expect(disk.current()).toEqual(new Uint8Array([9, 9]))
  })

  test('a file whose content really changed still conflicts', async () => {
    const disk = diskHandle(new Uint8Array([1, 2, 3]), 1000)
    const s: FileSession = { handle: disk.handle, name: 'x.tmv', lastModified: 1000 }
    await writeFile(s, new Uint8Array([1, 2, 3]))
    disk.replace(new Uint8Array([1, 2, 4])) // same length, different byte
    await expect(writeFile(s, new Uint8Array([9]))).rejects.toBeInstanceOf(ExternalChangeError)
    expect(disk.current()).toEqual(new Uint8Array([1, 2, 4]))
  })

  test('a changed length conflicts without needing a byte compare', async () => {
    const disk = diskHandle(new Uint8Array([1, 2, 3]), 1000)
    const s: FileSession = { handle: disk.handle, name: 'x.tmv', lastModified: 1000 }
    await writeFile(s, new Uint8Array([1, 2, 3]))
    disk.replace(new Uint8Array([1, 2, 3, 4]))
    await expect(writeFile(s, new Uint8Array([9]))).rejects.toBeInstanceOf(ExternalChangeError)
  })

  test('with no known baseline (nothing read or written yet) an mtime change still conflicts', async () => {
    const disk = diskHandle(new Uint8Array([1]), 1000)
    const s: FileSession = { handle: disk.handle, name: 'x.tmv', lastModified: 1000 }
    disk.touch()
    await expect(writeFile(s, new Uint8Array([2]))).rejects.toBeInstanceOf(ExternalChangeError)
  })

  test('the baseline follows readCurrent (a reload), so the next touch-only change is also tolerated', async () => {
    const disk = diskHandle(new Uint8Array([5, 5]), 1000)
    const s: FileSession = { handle: disk.handle, name: 'x.tmv', lastModified: 1 }
    await readCurrent(s)
    disk.touch()
    await expect(writeFile(s, new Uint8Array([6]))).resolves.toBeUndefined()
  })
})

describe('downloadFallback', () => {
  test('keeps the blob URL alive long enough for Firefox/Safari to start the download', () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    try {
      downloadFallback('a.tmv', new Uint8Array([1]))
      vi.advanceTimersByTime(1000)
      expect(revoke).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60_000)
      expect(revoke).toHaveBeenCalledWith('blob:x')
    } finally {
      vi.useRealTimers()
    }
  })
})
