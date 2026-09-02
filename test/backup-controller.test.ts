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
const requestPermissionMock = vi.fn(async (): Promise<PermissionState> => 'granted')
// Defaults to a non-empty file with no meaningful lastModified (0) so tests
// that don't care about the disk-seeded clock keep today's "nothing written
// yet this session" starting point (see maybeWriteBackup's own tests below
// for the cases that do care).
const getFileMock = vi.fn(async (): Promise<Pick<File, 'size' | 'lastModified'>> => ({ size: 1, lastModified: 0 }))

const fakeHandle = {
  name: 'team.bck',
  createWritable: createWritableMock,
  queryPermission: queryPermissionMock,
  requestPermission: requestPermissionMock,
  getFile: getFileMock,
} as unknown as FileSystemFileHandle

beforeEach(() => {
  idbMocks.idbGet.mockReset().mockResolvedValue(fakeHandle)
  idbMocks.idbSet.mockReset()
  writeMock.mockReset()
  closeMock.mockReset()
  createWritableMock.mockReset().mockResolvedValue(fakeWritable)
  queryPermissionMock.mockReset().mockResolvedValue('granted')
  requestPermissionMock.mockReset().mockResolvedValue('granted')
  getFileMock.mockReset().mockResolvedValue({ size: 1, lastModified: 0 })
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

  // The elapsed-time clock is seeded from the .bck file's own on-disk
  // lastModified the first time its handle is resolved each session, so the
  // interval survives a reopen instead of resetting to "never backed up" and
  // writing again on the very next save.
  test('maybeWriteBackup seeds the clock from disk: skips if the .bck was already written within the interval', async () => {
    getFileMock.mockResolvedValue({ size: 100, lastModified: Date.now() - 60 * 60 * 1000 }) // 1h ago
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).not.toHaveBeenCalled()
  })

  test('maybeWriteBackup seeds the clock from disk: writes when the .bck on disk is older than the interval', async () => {
    getFileMock.mockResolvedValue({ size: 100, lastModified: Date.now() - 25 * 60 * 60 * 1000 }) // 25h ago
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  // pickCreateBackup (fs.ts) creates the .bck file the moment it's picked,
  // before any real backup content is ever written — its lastModified at
  // that point is just the creation instant, not proof a backup happened.
  test('a freshly-picked, still-empty .bck (size 0) is not treated as already backed up', async () => {
    getFileMock.mockResolvedValue({ size: 0, lastModified: Date.now() })
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  test('the disk lastModified is read only once per session, not on every call', async () => {
    getFileMock.mockResolvedValue({ size: 100, lastModified: Date.now() - 25 * 60 * 60 * 1000 })
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    await ctl.hasMissingGrant()
    await ctl.checkOrphaned()
    expect(getFileMock).toHaveBeenCalledTimes(1)
  })

  test('a failed disk lastModified read is swallowed — falls back to "nothing written yet this session"', async () => {
    getFileMock.mockRejectedValue(new Error('permission lapsed'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.maybeWriteBackup(new Uint8Array([1]))
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
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

  // Consistent with hasMissingGrant()/writeBackupNow(): must not fire its own
  // native permission prompt for a feature the user has turned off, even
  // though a handle is still configured and its grant has genuinely lapsed —
  // this can otherwise be reached off the primary file's "Grant access…"
  // click, which has nothing to do with whether backups are currently on.
  test('regrantPermission no-ops when backups are disabled, even with a configured, lapsed handle', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await ctl.regrantPermission()
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
    expect(requestPermissionMock).not.toHaveBeenCalled()
  })

  test('regrantPermission no-ops when no backup handle id is configured', async () => {
    const store = storeWithBackup(true, null)
    const ctl = createBackupController({ store })
    await ctl.regrantPermission()
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
    expect(requestPermissionMock).not.toHaveBeenCalled()
  })

  test('regrantPermission no-ops (no native prompt fired) when the grant is already fine', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.regrantPermission()
    expect(queryPermissionMock).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(requestPermissionMock).not.toHaveBeenCalled()
  })

  test('regrantPermission re-requests permission on the same handle when the grant has lapsed', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await ctl.regrantPermission()
    expect(requestPermissionMock).toHaveBeenCalledWith({ mode: 'readwrite' })
  })

  test('regrantPermission swallows a rejecting requestPermission instead of throwing', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    requestPermissionMock.mockRejectedValue(new Error('user gesture required'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.regrantPermission()).resolves.toBeUndefined()
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  // The one-shot warning latch (see writeBackupNow's sticky-toast comment)
  // should not stay permanently spent once the underlying grant is actually
  // fixed — otherwise a later, unrelated write failure goes fully silent for
  // the rest of the session.
  test('a successful regrant clears the one-shot warning latch so a later write failure can toast again', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })

    createWritableMock.mockRejectedValueOnce(new Error('disk full'))
    await ctl.writeBackupNow(new Uint8Array([1]))
    expect(modalMocks.toast).toHaveBeenCalledTimes(1)
    modalMocks.toast.mockClear()

    // A second failure right after does NOT toast again — the latch is spent.
    createWritableMock.mockRejectedValueOnce(new Error('disk full'))
    await ctl.writeBackupNow(new Uint8Array([2]))
    expect(modalMocks.toast).not.toHaveBeenCalled()

    // The grant lapsed and gets fixed via the primary save's "Grant access…" chain.
    queryPermissionMock.mockResolvedValue('prompt')
    await ctl.regrantPermission()
    queryPermissionMock.mockResolvedValue('granted')

    // A fresh failure after the regrant can toast again.
    createWritableMock.mockRejectedValueOnce(new Error('disk full'))
    await ctl.writeBackupNow(new Uint8Array([3]))
    expect(modalMocks.toast).toHaveBeenCalledTimes(1)
  })

  test('hasMissingGrant is false when backups are off, even with a lapsed grant', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await expect(ctl.hasMissingGrant()).resolves.toBe(false)
  })

  test('hasMissingGrant is false when no backup handle is configured yet', async () => {
    const store = storeWithBackup(true, null)
    const ctl = createBackupController({ store })
    await expect(ctl.hasMissingGrant()).resolves.toBe(false)
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
  })

  test('hasMissingGrant is false when the configured handle is granted', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.hasMissingGrant()).resolves.toBe(false)
  })

  test('hasMissingGrant is true when the configured handle has lapsed, and never prompts', async () => {
    queryPermissionMock.mockResolvedValue('prompt')
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.hasMissingGrant()).resolves.toBe(true)
    expect(requestPermissionMock).not.toHaveBeenCalled()
  })

  test('checkOrphaned is false when backups are off', async () => {
    idbMocks.idbGet.mockResolvedValue(undefined)
    const store = storeWithBackup(false)
    const ctl = createBackupController({ store })
    await expect(ctl.checkOrphaned()).resolves.toBe(false)
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
  })

  test('checkOrphaned is false when no backup handle id is configured yet', async () => {
    const store = storeWithBackup(true, null)
    const ctl = createBackupController({ store })
    await expect(ctl.checkOrphaned()).resolves.toBe(false)
    expect(idbMocks.idbGet).not.toHaveBeenCalled()
  })

  test('checkOrphaned is false when the configured handle resolves fine from IDB', async () => {
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.checkOrphaned()).resolves.toBe(false)
  })

  // The moved-computer scenario: `backupHandleId` travels with the .tmv file
  // itself, but the handle it names only ever lived in the old machine's
  // IndexedDB — a fresh profile has no entry under that id at all.
  test('checkOrphaned is true when a handle id is configured but IDB has no matching entry', async () => {
    idbMocks.idbGet.mockResolvedValue(undefined)
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.checkOrphaned()).resolves.toBe(true)
  })

  // A transient IDB failure is a different, already-handled failure mode
  // (writeBackupNow's own try/catch) — not proof the reference is orphaned.
  test('checkOrphaned is false when the IDB lookup itself fails', async () => {
    idbMocks.idbGet.mockRejectedValue(new Error('IndexedDB unavailable'))
    const store = storeWithBackup(true)
    const ctl = createBackupController({ store })
    await expect(ctl.checkOrphaned()).resolves.toBe(false)
  })

  describe('getStatus', () => {
    test('returns null when backups are off', async () => {
      const store = storeWithBackup(false)
      const ctl = createBackupController({ store })
      await expect(ctl.getStatus()).resolves.toBeNull()
      expect(idbMocks.idbGet).not.toHaveBeenCalled()
    })

    test('returns null when no backup handle id is configured yet', async () => {
      const store = storeWithBackup(true, null)
      const ctl = createBackupController({ store })
      await expect(ctl.getStatus()).resolves.toBeNull()
      expect(idbMocks.idbGet).not.toHaveBeenCalled()
    })

    test('returns null when the configured handle is orphaned (no matching IDB entry)', async () => {
      idbMocks.idbGet.mockResolvedValue(undefined)
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await expect(ctl.getStatus()).resolves.toBeNull()
    })

    test('returns the file name, size, and last backup time from the resolved handle', async () => {
      getFileMock.mockResolvedValue({ size: 12345, lastModified: Date.now() - 60 * 60 * 1000 }) // 1h ago
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      const status = await ctl.getStatus()
      expect(status).not.toBeNull()
      expect(status?.fileName).toBe('team.bck')
      expect(status?.size).toBe(12345)
      expect(status?.lastBackupAt).toBeGreaterThan(0)
    })

    test('reports no "next due" time — backups piggyback on save, they are not scheduled', async () => {
      getFileMock.mockResolvedValue({ size: 100, lastModified: Date.now() - 30 * 60 * 1000 })
      const store = storeWithBackup(true)
      store.update((d) => { d.prefs.backupFrequency = 'hourly' })
      const ctl = createBackupController({ store })
      const status = await ctl.getStatus()
      expect(status).not.toBeNull()
      expect(status).not.toHaveProperty('nextDueAt')
    })

    test('lastBackupAt is 0 (never backed up) for a freshly-picked, still-empty .bck', async () => {
      getFileMock.mockResolvedValue({ size: 0, lastModified: Date.now() })
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      const status = await ctl.getStatus()
      expect(status?.lastBackupAt).toBe(0)
    })

    test('reflects a write made earlier this session', async () => {
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await ctl.writeBackupNow(new Uint8Array([1]))
      const status = await ctl.getStatus()
      expect(status?.lastBackupAt).toBeGreaterThan(0)
    })

    test('returns null when reading the handle from IDB fails', async () => {
      idbMocks.idbGet.mockRejectedValue(new Error('IndexedDB unavailable'))
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await expect(ctl.getStatus()).resolves.toBeNull()
      consoleErrorSpy.mockRestore()
    })

    test('returns null when reading the file from the handle fails', async () => {
      getFileMock.mockRejectedValue(new Error('permission lapsed'))
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = storeWithBackup(true)
      const ctl = createBackupController({ store })
      await expect(ctl.getStatus()).resolves.toBeNull()
      consoleErrorSpy.mockRestore()
    })
  })

  // Toggling backup off/on, or "Change backup location", picks a brand-new
  // handle under a brand-new random id (see prefs.ts's pickAndStoreBackupTarget)
  // and updates prefs.backupHandleId to point at it — same running
  // BackupController instance, no reload. loadHandle() must notice the id
  // changed and re-resolve from IDB instead of going on serving the handle it
  // cached under the *old* id.
  test('getStatus re-resolves from IDB after prefs.backupHandleId changes to a new id mid-session', async () => {
    const secondGetFile = vi.fn(async () => ({ size: 999, lastModified: 42 }))
    const secondHandle = { ...fakeHandle, name: 'second.bck', getFile: secondGetFile } as unknown as FileSystemFileHandle
    idbMocks.idbGet.mockImplementation(async (id?: string) => (id === 'backup-2' ? secondHandle : fakeHandle))

    const store = storeWithBackup(true, 'backup-1')
    const ctl = createBackupController({ store })

    const first = await ctl.getStatus()
    expect(first?.fileName).toBe('team.bck')

    store.update((d) => { d.prefs.backupHandleId = 'backup-2' })
    const second = await ctl.getStatus()
    expect(second?.fileName).toBe('second.bck')
    expect(secondGetFile).toHaveBeenCalled()
  })
})
