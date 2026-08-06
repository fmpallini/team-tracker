import { createBackupController } from '../src/core/backup-controller'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { describe, test, expect, vi, beforeEach } from 'vitest'

const idbMocks = vi.hoisted(() => ({
  idbGet: vi.fn(async () => undefined as unknown),
  idbSet: vi.fn(async () => {}),
}))
vi.mock('../src/core/idb', () => idbMocks)

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

// Mock FileSystemFileHandle with the required methods. The mocks are hoisted
// into properly-typed consts rather than reached through a
// `ReturnType<typeof vi.fn>` cast: that cast erases the mock's return type, so
// `mockImplementation(async () => …)` reads to ESLint as an async callback in a
// void-return position (@typescript-eslint/no-misused-promises).
const writeMock = vi.fn(async (_bytes: BufferSource) => {})
const closeMock = vi.fn(async () => {})
const fakeWritable = { write: writeMock, close: closeMock }

const createWritableMock = vi.fn(async () => fakeWritable)
const queryPermissionMock = vi.fn(async (): Promise<PermissionState> => 'granted')

const fakeHandle = {
  name: 'team.bck',
  createWritable: createWritableMock,
  queryPermission: queryPermissionMock,
} as unknown as FileSystemFileHandle

beforeEach(() => {
  idbMocks.idbGet.mockReset().mockResolvedValue(fakeHandle)
  idbMocks.idbSet.mockReset()
  writeMock.mockReset()
  closeMock.mockReset()
  createWritableMock.mockReset().mockResolvedValue(fakeWritable)
  queryPermissionMock.mockReset().mockResolvedValue('granted')
  modalMocks.toast.mockReset()
})

function storeWithBackup(enabled: boolean, handleId: string | null = 'backup-1') {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => {
    d.prefs.dailyBackupEnabled = enabled
    d.prefs.backupHandleId = handleId
  })
  return store
}

describe('backup-controller', () => {
  test('writeBackupNow no-ops when the pref is off', async () => {
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
  })

  test('writeBackupNow no-ops when no handle id is set yet', async () => {
    const store = storeWithBackup(true, null)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
  })

  test('writeBackupNow fetches the handle from IDB and writes the given bytes', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    const bytes = new Uint8Array([1, 2, 3])
    await ctl.writeBackupNow(bytes)
    expect(idbMocks.idbGet).toHaveBeenCalledWith('backup-1')
    expect(createWritableMock).toHaveBeenCalled()
    expect(writeMock).toHaveBeenCalledWith(bytes)
    expect(closeMock).toHaveBeenCalled()
  })

  test('writeBackupNow caches the handle: a second call does not re-fetch from IDB', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(idbMocks.idbGet).toHaveBeenCalledTimes(1)
    expect(writeMock).toHaveBeenCalledTimes(2)
  })

  test('writeBackupNow always writes, even called twice in a row (no time gate)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(writeMock).toHaveBeenCalledTimes(2)
  })

  test('maybeWriteBackup writes on first call (nothing written yet this session)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup skips a second call within 24h of the first', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    await ctl.maybeWriteBackup(new Uint8Array([2]))
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup writes again once >=24h have elapsed', async () => {
    vi.useFakeTimers()
    try {
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await ctl.maybeWriteBackup(new Uint8Array([1]))
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      await ctl.maybeWriteBackup(new Uint8Array([2]))
      expect(writeMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('maybeWriteBackup skips a second call within 1h when backupFrequency is "hourly"', async () => {
    const store = storeWithBackup(true)
    store.update((d) => { d.prefs.backupFrequency = 'hourly' })
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    await ctl.maybeWriteBackup(new Uint8Array([2]))
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup writes again once >=1h has elapsed when backupFrequency is "hourly"', async () => {
    vi.useFakeTimers()
    try {
      const store = storeWithBackup(true)
      store.update((d) => { d.prefs.backupFrequency = 'hourly' })
      const ctl = createBackupController({ store })
      await ctl.maybeWriteBackup(new Uint8Array([1]))
      vi.advanceTimersByTime(60 * 60 * 1000)
      await ctl.maybeWriteBackup(new Uint8Array([2]))
      expect(writeMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('maybeWriteBackup with "hourly" still skips before a full hour has elapsed (30min is too soon)', async () => {
    vi.useFakeTimers()
    try {
      const store = storeWithBackup(true)
      store.update((d) => { d.prefs.backupFrequency = 'hourly' })
      const ctl = createBackupController({ store })
      await ctl.maybeWriteBackup(new Uint8Array([1]))
      vi.advanceTimersByTime(30 * 60 * 1000)
      await ctl.maybeWriteBackup(new Uint8Array([2]))
      expect(writeMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('maybeWriteBackup no-ops when the pref is off, regardless of elapsed time', async () => {
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).not.toHaveBeenCalled()
  })

  test('a write failure is logged and shows one toast per session, not per failure', async () => {
    writeMock.mockRejectedValue(new Error('disk full'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(modalMocks.toast).toHaveBeenCalledTimes(1)
  })

  test('backup writes never call idbSet with "lastHandle" key (regression test)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.maybeWriteBackup(new Uint8Array([2]))
    // Verify idbSet was never called with 'lastHandle' as the first argument
    const lastHandleSetCalls = idbMocks.idbSet.mock.calls.filter(
      (call: unknown[]) => call.length > 0 && call[0] === 'lastHandle'
    )
    expect(lastHandleSetCalls).toHaveLength(0)
  })

  // Callers (save-controller's markSaved()/setSaveState(), main.ts's
  // `app.password = newPw`) run bookkeeping right after awaiting these, so a
  // rejection escaping here would leave the doc permanently "dirty" or desync
  // the in-memory password from the one the file was just encrypted with.
  test('writeBackupNow resolves (never rejects) when the IDB handle lookup fails', async () => {
    idbMocks.idbGet.mockRejectedValue(new Error('IndexedDB unavailable'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.writeBackupNow(new Uint8Array([1]))).resolves.toBeUndefined()
    expect(writeMock).not.toHaveBeenCalled()
    expect(modalMocks.toast).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup resolves (never rejects) when the IDB handle lookup fails', async () => {
    idbMocks.idbGet.mockRejectedValue(new Error('IndexedDB unavailable'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.maybeWriteBackup(new Uint8Array([1]))).resolves.toBeUndefined()
    expect(writeMock).not.toHaveBeenCalled()
  })

  // A handle restored from IndexedDB doesn't carry its read-write grant across
  // browser sessions; without the queryPermission check the first backup write
  // of each new session would fail inside createWritable() with an opaque
  // NotAllowedError, every save, for the rest of the session.
  test('a non-granted permission on the restored handle is a clean no-op (no write attempted)', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.writeBackupNow(new Uint8Array([1]))).resolves.toBeUndefined()
    expect(queryPermissionMock).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(createWritableMock).not.toHaveBeenCalled()
    expect(writeMock).not.toHaveBeenCalled()
    // Clean no-op, not an error path: no failure toast.
    expect(modalMocks.toast).not.toHaveBeenCalled()
  })

  test('a denied permission blocks maybeWriteBackup too, and recovers once re-granted', async () => {
    queryPermissionMock.mockResolvedValue('denied')
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).not.toHaveBeenCalled()
    // The elapsed-time clock only advances on an actual write, so the next
    // attempt still runs — and succeeds once the grant is back.
    queryPermissionMock.mockResolvedValue('granted')
    await ctl.maybeWriteBackup(new Uint8Array([2]))
    expect(writeMock).toHaveBeenCalledTimes(1)
  })
})
