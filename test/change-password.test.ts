import { createChangePassword, type ChangePasswordDeps } from '../src/core/change-password'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { FileSession } from '../src/core/fs'
import type { Shell } from '../src/ui/shell'
import type { BackupController } from '../src/core/backup-controller'
import { t } from '../src/core/i18n'

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  downloadFallback: vi.fn(),
}))
vi.mock('../src/core/fs', () => fsMocks)

const cryptoMocks = vi.hoisted(() => ({
  encryptDocument: vi.fn(async () => new Uint8Array([1, 2, 3])),
  serializePlain: vi.fn(() => new Uint8Array([7, 7, 7])),
}))
vi.mock('../src/core/crypto', () => cryptoMocks)

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

function makeSession(withHandle = true): FileSession {
  return { handle: withHandle ? ({} as unknown as FileSystemFileHandle) : null, name: 'team.tmv', lastModified: 1 }
}

function makeShell(): Shell {
  return { setSaveState: vi.fn(), setTitle: vi.fn() } as unknown as Shell
}

function makeBackupCtl(): BackupController {
  return { writeBackupNow: vi.fn(async () => {}), maybeWriteBackup: vi.fn(async () => {}), regrantPermission: vi.fn(async () => {}), hasMissingGrant: vi.fn(async () => false) }
}

beforeEach(() => {
  fsMocks.writeFile.mockReset().mockImplementation(async () => {})
  fsMocks.downloadFallback.mockReset()
  cryptoMocks.encryptDocument.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3]))
  cryptoMocks.serializePlain.mockReset().mockReturnValue(new Uint8Array([7, 7, 7]))
  modalMocks.toast.mockReset()
})

test('changing to a new password encrypts and writes, never touches serializePlain', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession()
  const shell = makeShell()
  const backupCtl = makeBackupCtl()
  const setPassword = vi.fn()
  const changePassword = createChangePassword({
    store, session, shell, backupCtl, runExclusive: (fn) => fn(), setPassword,
  })

  await changePassword('newpw')

  expect(cryptoMocks.encryptDocument).toHaveBeenCalledWith(store.doc, 'newpw')
  expect(cryptoMocks.serializePlain).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, new Uint8Array([1, 2, 3]))
  expect(setPassword).toHaveBeenCalledWith('newpw')
  expect(store.dirty).toBe(false)
  expect(shell.setSaveState).toHaveBeenCalledWith('saved')
  expect(shell.setTitle).toHaveBeenCalledWith(session.name, false)
})

test('migrating to password-less (newPw null) uses serializePlain, never encryptDocument', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession()
  const changePassword = createChangePassword({
    store, session, shell: makeShell(), backupCtl: makeBackupCtl(), runExclusive: (fn) => fn(), setPassword: vi.fn(),
  })

  await changePassword(null)

  expect(cryptoMocks.serializePlain).toHaveBeenCalledWith(store.doc)
  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, new Uint8Array([7, 7, 7]))
})

test('fallback mode (no FS handle) downloads instead of writing, and toasts a non-sticky notice', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession(false)
  const changePassword = createChangePassword({
    store, session, shell: makeShell(), backupCtl: makeBackupCtl(), runExclusive: (fn) => fn(), setPassword: vi.fn(),
  })

  await changePassword('newpw')

  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(fsMocks.downloadFallback).toHaveBeenCalledWith(session.name, new Uint8Array([1, 2, 3]))
  expect(modalMocks.toast).toHaveBeenCalledWith(t('en-US', 'fallback_notice'))
})

test('mirrors the just-written bytes to the backup controller', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const backupCtl = makeBackupCtl()
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), backupCtl, runExclusive: (fn) => fn(), setPassword: vi.fn(),
  })

  await changePassword('newpw')

  expect(backupCtl.writeBackupNow).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
})

// `writeBackupNow` is contractually non-throwing, but this call site can't
// rely on that alone: the primary file is already written under the new
// password by the time it's awaited, so an escaping rejection here would
// leave the in-memory password out of sync with what's on disk. Belt and
// braces (see the matching comment in core/change-password.ts).
test('a rejecting backup write is swallowed — password still flips and the doc still settles as saved', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const backupCtl: BackupController = {
    writeBackupNow: vi.fn(async () => {
      throw new Error('disk full')
    }),
    maybeWriteBackup: vi.fn(async () => {}),
    regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => false),
  }
  const setPassword = vi.fn()
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), backupCtl, runExclusive: (fn) => fn(), setPassword,
  })

  await expect(changePassword('newpw')).resolves.toBeUndefined()

  expect(consoleErrorSpy).toHaveBeenCalled()
  expect(setPassword).toHaveBeenCalledWith('newpw')
  expect(store.dirty).toBe(false)
  consoleErrorSpy.mockRestore()
})

test('a read-only store rejects before ever encrypting, writing, backing up, or flipping the password', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.setReadOnly(true)
  const backupCtl = makeBackupCtl()
  const setPassword = vi.fn()
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), backupCtl, runExclusive: (fn) => fn(), setPassword,
  })

  await expect(changePassword('newpw')).rejects.toThrow('read-only')

  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(backupCtl.writeBackupNow).not.toHaveBeenCalled()
  expect(setPassword).not.toHaveBeenCalled()
})

test('runs the whole write+backup+bookkeeping sequence inside runExclusive', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const calls: unknown[] = []
  const runExclusive: ChangePasswordDeps['runExclusive'] = (fn) => {
    calls.push(fn)
    return fn()
  }
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), backupCtl: makeBackupCtl(), runExclusive, setPassword: vi.fn(),
  })

  await changePassword('newpw')

  expect(calls).toHaveLength(1)
})
