import { createChangePassword, type ChangePasswordDeps } from '../src/core/change-password'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { FileSession } from '../src/core/fs'
import type { Shell } from '../src/ui/shell'
import { t } from '../src/core/i18n'

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  downloadFallback: vi.fn(),
}))
vi.mock('../src/core/fs', () => fsMocks)

const cryptoMocks = vi.hoisted(() => ({
  encryptDocument: vi.fn(async () => new Uint8Array([1, 2, 3])),
  serializePlain: vi.fn(() => new Uint8Array([7, 7, 7])),
  blobCodec: vi.fn(async () => ({ seal: async () => new Uint8Array(), open: async () => new Uint8Array() })),
}))
vi.mock('../src/core/crypto', () => cryptoMocks)

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

const idbMocks = vi.hoisted(() => ({ idbGet: vi.fn(async () => undefined as unknown), idbSet: vi.fn(async () => {}) }))
vi.mock('../src/core/idb', () => idbMocks)

function makeSession(withHandle = true): FileSession {
  return { handle: withHandle ? ({} as unknown as FileSystemFileHandle) : null, name: 'team.tmv', lastModified: 1 }
}

function makeShell(): Shell {
  return { setTitle: vi.fn() } as unknown as Shell
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
  const setPassword = vi.fn()
  const snapshot = { fileWritten: vi.fn() }
  const changePassword = createChangePassword({
    store, session, shell, snapshot, runExclusive: (fn) => fn(), getPassword: () => null, setPassword,
  })

  await changePassword('newpw')

  expect(cryptoMocks.encryptDocument).toHaveBeenCalledWith(store.doc, 'newpw', store.images, [], expect.objectContaining({ writeId: expect.any(String) }))
  expect(cryptoMocks.serializePlain).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, new Uint8Array([1, 2, 3]))
  expect(setPassword).toHaveBeenCalledWith('newpw')
  expect(store.dirty).toBe(false)
  expect(snapshot.fileWritten).toHaveBeenCalledTimes(1)
  expect(shell.setTitle).toHaveBeenCalledWith(session.name)
})

test('the new file write is committed to the persister with its stamp', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const markFileWritten = vi.fn(async () => {})
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), persister: { markFileWritten } as never,
    runExclusive: (fn) => fn(), getPassword: () => null, setPassword: vi.fn(),
  })

  await changePassword('newpw')

  const stampWritten = (cryptoMocks.encryptDocument.mock.calls[0] as unknown[])[4]
  expect(markFileWritten).toHaveBeenCalledWith(stampWritten, store.rev)
})

test('a failed file write is not committed to the persister', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'))
  const markFileWritten = vi.fn(async () => {})
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), persister: { markFileWritten } as never,
    runExclusive: (fn) => fn(), getPassword: () => null, setPassword: vi.fn(),
  })

  await expect(changePassword('newpw')).rejects.toThrow('disk full')
  expect(markFileWritten).not.toHaveBeenCalled()
})

test('migrating to password-less (newPw null) uses serializePlain, never encryptDocument', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession()
  const changePassword = createChangePassword({
    store, session, shell: makeShell(), runExclusive: (fn) => fn(), getPassword: () => null, setPassword: vi.fn(),
  })

  await changePassword(null)

  expect(cryptoMocks.serializePlain).toHaveBeenCalledWith(store.doc, store.images, [], expect.objectContaining({ writeId: expect.any(String) }))
  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, new Uint8Array([7, 7, 7]))
})

test('fallback mode (no FS handle) downloads instead of writing, and toasts a non-sticky notice', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const session = makeSession(false)
  const changePassword = createChangePassword({
    store, session, shell: makeShell(), runExclusive: (fn) => fn(), getPassword: () => null, setPassword: vi.fn(),
  })

  await changePassword('newpw')

  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(fsMocks.downloadFallback).toHaveBeenCalledWith(session.name, new Uint8Array([1, 2, 3]))
  expect(modalMocks.toast).toHaveBeenCalledWith(t('en-US', 'fallback_notice'))
})

test('a read-only store rejects before ever encrypting, writing, or flipping the password', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.setReadOnly(true)
  const setPassword = vi.fn()
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), runExclusive: (fn) => fn(), getPassword: () => null, setPassword,
  })

  await expect(changePassword('newpw')).rejects.toThrow('read-only')

  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(setPassword).not.toHaveBeenCalled()
})

test('runs the whole write+bookkeeping sequence inside runExclusive', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const calls: unknown[] = []
  const runExclusive: ChangePasswordDeps['runExclusive'] = (fn) => {
    calls.push(fn)
    return fn()
  }
  const changePassword = createChangePassword({
    store, session: makeSession(), shell: makeShell(), runExclusive, getPassword: () => null, setPassword: vi.fn(),
  })

  await changePassword('newpw')

  expect(calls).toHaveLength(1)
})
