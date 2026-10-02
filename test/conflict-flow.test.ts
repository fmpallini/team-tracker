import type { ConflictModalOptions } from '../src/ui/conflict'
import type { FileSession } from '../src/core/fs'
import type { Doc } from '../src/core/types'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'

const mocks = vi.hoisted(() => ({
  showConflictModal: vi.fn<(opts: ConflictModalOptions) => void>(),
  toast: vi.fn(),
  pickCreate: vi.fn<(name: string) => Promise<FileSession | null>>(),
  forceWrite: vi.fn<(s: FileSession, b: Uint8Array) => Promise<void>>(),
  docToBytes: vi.fn<(doc: Doc, pw: string | null) => Promise<Uint8Array>>(),
}))
vi.mock('../src/ui/conflict', () => ({ showConflictModal: mocks.showConflictModal }))
vi.mock('../src/ui/modal', () => ({ toast: mocks.toast }))
vi.mock('../src/core/fs', () => ({ pickCreate: mocks.pickCreate, forceWrite: mocks.forceWrite }))
vi.mock('../src/core/doc-bytes', () => ({ docToBytes: mocks.docToBytes }))

import { createConflictFlow, type ConflictFlowDeps } from '../src/core/conflict-flow'

const BYTES = new Uint8Array([1, 2, 3])

function makeSession(over: Partial<FileSession> = {}): FileSession {
  return { handle: {} as unknown as FileSystemFileHandle, name: 'team.tmv', lastModified: 1, ...over }
}

function setup(over: Partial<ConflictFlowDeps> = {}, session = makeSession()) {
  const store: Store = createStore(createEmptyDocument('en-US'))
  const shell = { setSaveState: vi.fn(), setTitle: vi.fn() }
  const deps = {
    store, session, shell,
    getPassword: vi.fn<() => string | null>(() => 'pw'),
    reloadFromDisk: vi.fn(async () => {}),
    resolveGrants: vi.fn(async () => {}),
    reopen: vi.fn(),
    ...over,
  }
  const flow = createConflictFlow(deps)
  /** Opens the modal and hands back the options it was given. */
  const open = (): ConflictModalOptions => {
    flow.onExternalChange()
    return mocks.showConflictModal.mock.calls.at(-1)![0]
  }
  return { store, shell, deps, flow, open }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.docToBytes.mockResolvedValue(BYTES)
  mocks.forceWrite.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('opening the modal', () => {
  test('opens once, in the document locale, and reports itself open', () => {
    const { flow, store } = setup()
    store.doc.prefs.locale = 'pt-BR'

    flow.onExternalChange()

    expect(mocks.showConflictModal).toHaveBeenCalledTimes(1)
    expect(mocks.showConflictModal.mock.calls[0]![0].locale).toBe('pt-BR')
    expect(flow.isOpen()).toBe(true)
  })

  test('a second external change while the modal is up never stacks another', () => {
    const { flow } = setup()
    flow.onExternalChange()
    flow.onExternalChange()
    expect(mocks.showConflictModal).toHaveBeenCalledTimes(1)
  })

  test('starts closed', () => {
    expect(setup().flow.isOpen()).toBe(false)
  })

  test('offers Fork only when the session has a file handle (fallback mode has no picker)', () => {
    expect(setup().open().onFork).toBeTypeOf('function')
    vi.clearAllMocks()
    expect(setup({}, makeSession({ handle: null })).open().onFork).toBeUndefined()
  })
})

describe('Reload', () => {
  test('re-reads the file, then lets the next conflict open the modal again', async () => {
    const { flow, deps, open } = setup()

    await open().onReload()

    expect(deps.reloadFromDisk).toHaveBeenCalledTimes(1)
    expect(flow.isOpen()).toBe(false)
    expect(mocks.toast).not.toHaveBeenCalled()
    flow.onExternalChange()
    expect(mocks.showConflictModal).toHaveBeenCalledTimes(2)
  })

  test('a failed reload surfaces a sticky error toast and still releases the guard', async () => {
    const { flow, open } = setup({ reloadFromDisk: vi.fn(async () => { throw new Error('read failed') }) })

    await open().onReload()

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('reload'), { sticky: true })
    expect(flow.isOpen()).toBe(false)
  })
})

describe('Overwrite', () => {
  test('force-writes the current document under the live password, then marks it saved', async () => {
    const { flow, store, shell, deps, open } = setup()
    store.update((d) => { d.prefs.fontSize = 'L' })
    expect(store.dirty).toBe(true)

    await open().onOverwrite()

    expect(deps.getPassword).toHaveBeenCalled()
    expect(mocks.docToBytes).toHaveBeenCalledWith(store.doc, 'pw')
    expect(mocks.forceWrite).toHaveBeenCalledWith(deps.session, BYTES)
    expect(store.dirty).toBe(false)
    expect(shell.setSaveState).toHaveBeenCalledWith('saved')
    expect(shell.setTitle).toHaveBeenCalledWith('team.tmv', false)
    expect(flow.isOpen()).toBe(false)
  })

  test('a password-less file is written under a null password', async () => {
    const { open } = setup({ getPassword: () => null })
    await open().onOverwrite()
    expect(mocks.docToBytes).toHaveBeenCalledWith(expect.anything(), null)
  })

  test('a lapsed permission shows the permission state and a toast whose action re-requests access', async () => {
    mocks.forceWrite.mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    const { flow, store, shell, deps, open } = setup()
    store.update((d) => { d.prefs.fontSize = 'L' })

    await open().onOverwrite()

    expect(shell.setSaveState).toHaveBeenCalledWith('permission')
    expect(shell.setSaveState).not.toHaveBeenCalledWith('saved')
    expect(store.dirty).toBe(true)
    const [, opts] = mocks.toast.mock.calls[0]!
    expect(opts.sticky).toBe(true)
    expect(opts.action.label).toBe('Grant access…')
    opts.action.onClick()
    expect(deps.resolveGrants).toHaveBeenCalledTimes(1)
    expect(flow.isOpen()).toBe(false)
  })

  test('any other write failure shows the error state and a sticky toast, and stays dirty', async () => {
    mocks.forceWrite.mockRejectedValue(new Error('disk full'))
    const { flow, store, shell, open } = setup()
    store.update((d) => { d.prefs.fontSize = 'L' })

    await open().onOverwrite()

    expect(shell.setSaveState).toHaveBeenCalledWith('error')
    expect(shell.setSaveState).not.toHaveBeenCalledWith('permission')
    expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), { sticky: true })
    expect(store.dirty).toBe(true)
    expect(flow.isOpen()).toBe(false)
  })

  test('a failure while serializing is handled like a failed write', async () => {
    mocks.docToBytes.mockRejectedValue(new Error('encrypt failed'))
    const { flow, shell, open } = setup()

    await open().onOverwrite()

    expect(mocks.forceWrite).not.toHaveBeenCalled()
    expect(shell.setSaveState).toHaveBeenCalledWith('error')
    expect(flow.isOpen()).toBe(false)
  })
})

describe('Fork', () => {
  const FORK: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team (copy).tmv', lastModified: 2 }

  test('suggests "<name> (copy).tmv", stripping .tmv case-insensitively', async () => {
    mocks.pickCreate.mockResolvedValue(null)

    await setup({}, makeSession({ name: 'Plan.TMV' })).open().onFork!()
    expect(mocks.pickCreate).toHaveBeenLastCalledWith('Plan (copy).tmv')

    await setup({}, makeSession({ name: 'no-extension' })).open().onFork!()
    expect(mocks.pickCreate).toHaveBeenLastCalledWith('no-extension (copy).tmv')
  })

  test('a dismissed picker changes nothing: resolves false, writes nothing, keeps the modal guard up', async () => {
    mocks.pickCreate.mockResolvedValue(null)
    const { flow, store, deps, open } = setup()
    store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'h' })

    const done = await open().onFork!()

    expect(done).toBe(false)
    expect(mocks.forceWrite).not.toHaveBeenCalled()
    expect(deps.reopen).not.toHaveBeenCalled()
    expect(store.doc.prefs.dailyBackupEnabled).toBe(true)
    expect(store.doc.prefs.backupHandleId).toBe('h')
    expect(flow.isOpen()).toBe(true)
  })

  test('detaches the backup mirror BEFORE serializing, so the fork file never points at the original\'s .bck', async () => {
    mocks.pickCreate.mockResolvedValue(FORK)
    const { store, open } = setup()
    store.update((d) => { d.prefs.dailyBackupEnabled = true; d.prefs.backupHandleId = 'h' })
    let seenAtSerialize: unknown
    mocks.docToBytes.mockImplementation(async (doc) => {
      seenAtSerialize = { on: doc.prefs.dailyBackupEnabled, id: doc.prefs.backupHandleId }
      return BYTES
    })

    await open().onFork!()

    expect(seenAtSerialize).toEqual({ on: false, id: null })
  })

  test('writes the fork under the live password, marks the document saved, and re-opens it on the fork', async () => {
    mocks.pickCreate.mockResolvedValue(FORK)
    const { flow, store, deps, open } = setup()
    store.update((d) => { d.prefs.fontSize = 'L' })

    const done = await open().onFork!()

    expect(done).toBe(true)
    expect(mocks.forceWrite).toHaveBeenCalledWith(FORK, BYTES)
    expect(mocks.forceWrite).not.toHaveBeenCalledWith(deps.session, expect.anything())
    expect(store.dirty).toBe(false)
    expect(deps.reopen).toHaveBeenCalledWith(FORK, store.doc, 'pw')
    expect(flow.isOpen()).toBe(false)
  })

  test('releases the guard BEFORE re-opening, so the new document can raise its own conflict', async () => {
    mocks.pickCreate.mockResolvedValue(FORK)
    let openDuringReopen: boolean | null = null
    const ref: { flow?: { isOpen: () => boolean } } = {}
    const { flow, open } = setup({ reopen: () => { openDuringReopen = ref.flow!.isOpen() } })
    ref.flow = flow

    await open().onFork!()

    expect(openDuringReopen).toBe(false)
  })

  test('a failed fork write rejects (the modal reopens), never re-opens the document, and keeps the guard up', async () => {
    mocks.pickCreate.mockResolvedValue(FORK)
    mocks.forceWrite.mockRejectedValue(new Error('disk full'))
    const { flow, store, deps, open } = setup()
    store.update((d) => { d.prefs.fontSize = 'L' })

    await expect(open().onFork!()).rejects.toThrow('disk full')

    expect(deps.reopen).not.toHaveBeenCalled()
    expect(store.dirty).toBe(true)
    expect(flow.isOpen()).toBe(true)
  })
})
