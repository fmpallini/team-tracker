import { createBackupController } from '../src/core/backup-controller'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { describe, test, expect, vi, beforeEach } from 'vitest'

const fsMocks = vi.hoisted(() => ({ forceWrite: vi.fn(async () => {}) }))
vi.mock('../src/core/fs', () => fsMocks)

const idbMocks = vi.hoisted(() => ({ idbGet: vi.fn(async () => undefined as unknown) }))
vi.mock('../src/core/idb', () => idbMocks)

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

const fakeHandle = { name: 'team.bck' } as unknown as FileSystemFileHandle

beforeEach(() => {
  fsMocks.forceWrite.mockReset().mockImplementation(async () => {})
  idbMocks.idbGet.mockReset().mockResolvedValue(fakeHandle)
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
    expect(fsMocks.forceWrite).not.toHaveBeenCalled()
  })

  test('writeBackupNow no-ops when no handle id is set yet', async () => {
    const store = storeWithBackup(true, null)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    expect(fsMocks.forceWrite).not.toHaveBeenCalled()
  })

  test('writeBackupNow fetches the handle from IDB and force-writes the given bytes', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    const bytes = new Uint8Array([1, 2, 3])
    await ctl.writeBackupNow(bytes)
    expect(idbMocks.idbGet).toHaveBeenCalledWith('backup-1')
    expect(fsMocks.forceWrite).toHaveBeenCalledWith(expect.objectContaining({ handle: fakeHandle }), bytes)
  })

  test('writeBackupNow caches the handle: a second call does not re-fetch from IDB', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(idbMocks.idbGet).toHaveBeenCalledTimes(1)
    expect(fsMocks.forceWrite).toHaveBeenCalledTimes(2)
  })

  test('writeBackupNow always writes, even called twice in a row (no time gate)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(fsMocks.forceWrite).toHaveBeenCalledTimes(2)
  })

  test('maybeWriteBackup writes on first call (nothing written yet this session)', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(fsMocks.forceWrite).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup skips a second call within 24h of the first', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    await ctl.maybeWriteBackup(new Uint8Array([2]))
    expect(fsMocks.forceWrite).toHaveBeenCalledTimes(1)
  })

  test('maybeWriteBackup writes again once >=24h have elapsed', async () => {
    vi.useFakeTimers()
    try {
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await ctl.maybeWriteBackup(new Uint8Array([1]))
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      await ctl.maybeWriteBackup(new Uint8Array([2]))
      expect(fsMocks.forceWrite).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('maybeWriteBackup no-ops when the pref is off, regardless of elapsed time', async () => {
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(fsMocks.forceWrite).not.toHaveBeenCalled()
  })

  test('a forceWrite failure is logged and shows one toast per session, not per failure', async () => {
    fsMocks.forceWrite.mockRejectedValue(new Error('disk full'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.writeBackupNow(new Uint8Array([1]))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(modalMocks.toast).toHaveBeenCalledTimes(1)
  })
})
