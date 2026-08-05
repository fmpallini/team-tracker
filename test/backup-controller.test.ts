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

// Mock FileSystemFileHandle with the required methods
const fakeWritable = {
  write: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}

const fakeHandle = {
  name: 'team.bck',
  createWritable: vi.fn(async () => fakeWritable),
} as unknown as FileSystemFileHandle

beforeEach(() => {
  idbMocks.idbGet.mockReset().mockResolvedValue(fakeHandle)
  idbMocks.idbSet.mockReset()
  ;(fakeWritable.write as ReturnType<typeof vi.fn>).mockReset()
  ;(fakeWritable.close as ReturnType<typeof vi.fn>).mockReset()
  ;(fakeHandle.createWritable as ReturnType<typeof vi.fn>).mockReset().mockImplementation(async () => fakeWritable)
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
    expect(fakeHandle.createWritable as ReturnType<typeof vi.fn>).toHaveBeenCalled()
    expect(fakeWritable.write as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(bytes)
    expect(fakeWritable.close as ReturnType<typeof vi.fn>).toHaveBeenCalled()
  })

  test('writeBackupNow caches the handle: a second call does not re-fetch from IDB', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(idbMocks.idbGet).toHaveBeenCalledTimes(1)
    expect(fakeWritable.write as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
  })

  test('writeBackupNow always writes, even called twice in a row (no time gate)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(fakeWritable.write as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
  })

  test('maybeWriteBackup writes on first call (nothing written yet this session)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(fakeWritable.write as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup skips a second call within 24h of the first', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    await ctl.maybeWriteBackup(new Uint8Array([2]))
    expect(fakeWritable.write as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup writes again once >=24h have elapsed', async () => {
    vi.useFakeTimers()
    try {
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await ctl.maybeWriteBackup(new Uint8Array([1]))
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      await ctl.maybeWriteBackup(new Uint8Array([2]))
      expect(fakeWritable.write as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('maybeWriteBackup no-ops when the pref is off, regardless of elapsed time', async () => {
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(fakeWritable.write as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  test('a write failure is logged and shows one toast per session, not per failure', async () => {
    (fakeWritable.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
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
})
