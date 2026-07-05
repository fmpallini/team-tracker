import { createSaveController } from '../src/core/save-controller'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createShell, type Shell } from '../src/ui/shell'
import type { FileSession } from '../src/core/fs'
import type { Prefs } from '../src/core/types'

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  downloadFallback: vi.fn(),
  pickCreate: vi.fn(),
  supportsFsApi: true,
  ExternalChangeError: class ExternalChangeError extends Error {},
}))
vi.mock('../src/core/fs', () => fsMocks)

const cryptoMocks = vi.hoisted(() => ({
  encryptDocument: vi.fn(async () => new Uint8Array([1, 2, 3])),
}))
vi.mock('../src/core/crypto', () => cryptoMocks)

const modalMocks = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modalMocks)

// jsdom does not implement matchMedia; createShell() needs it to watch the OS theme preference.
function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function makeShell(): Shell {
  stubMatchMedia()
  return createShell('en-US')
}

function makeSession(withHandle = true): FileSession {
  return { handle: withHandle ? ({} as unknown as FileSystemFileHandle) : null, name: 'x.tmv', lastModified: 1 }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  fsMocks.writeFile.mockReset().mockImplementation(async () => {})
  fsMocks.downloadFallback.mockReset()
  fsMocks.pickCreate.mockReset()
  fsMocks.supportsFsApi = true
  cryptoMocks.encryptDocument.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3]))
  modalMocks.toast.mockReset()
})

test('saveNow is a no-op when the store is clean', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  await ctl.saveNow()

  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(setSaveStateSpy).not.toHaveBeenCalled()
})

test('saveNow happy path: encrypts, writes, marks saved, and updates title', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const setTitleSpy = vi.spyOn(shell, 'setTitle')
  const session = makeSession()
  const onExternalChange = vi.fn()
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange,
  })

  await ctl.saveNow()

  expect(cryptoMocks.encryptDocument).toHaveBeenCalledWith(store.doc, 'pw')
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, expect.any(Uint8Array))
  expect(store.dirty).toBe(false)
  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'saved'])
  expect(setTitleSpy).toHaveBeenCalledWith('x.tmv', false)
  expect(onExternalChange).not.toHaveBeenCalled()
})

test('fallback mode (no handle): a non-explicit saveNow() is a no-op (stays dirty, no download)', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession(false)
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  // Simulates an automatic trigger (nav change, tab hidden) — must not
  // silently kick off a file download the user never asked for.
  await ctl.saveNow()

  expect(fsMocks.downloadFallback).not.toHaveBeenCalled()
  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(store.dirty).toBe(true)
})

test('fallback mode (no handle): an explicit saveNow() downloads instead of writing, still marks saved', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession(false)
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  // Simulates Ctrl+S / a "Save as…" retry — an explicit user action.
  await ctl.saveNow({ explicit: true })

  expect(fsMocks.downloadFallback).toHaveBeenCalledWith('x.tmv', expect.any(Uint8Array))
  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(store.dirty).toBe(false)
})

test('reentrancy: saveNow called while a save is in flight queues exactly one trailing save', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()

  const encryptDeferred = deferred<Uint8Array<ArrayBuffer>>()
  cryptoMocks.encryptDocument.mockImplementationOnce(() => encryptDeferred.promise)

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  const p1 = ctl.saveNow() // starts; suspended awaiting the controlled encrypt promise
  const p2 = ctl.saveNow() // reentrant call while saving — should just queue, not run in parallel

  await p2
  expect(fsMocks.writeFile).not.toHaveBeenCalled()

  encryptDeferred.resolve(new Uint8Array([9]))
  await p1
  // let the fire-and-forget trailing round finish
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  expect(cryptoMocks.encryptDocument).toHaveBeenCalledTimes(2)
})

test('reentrancy: a second saveNow while clean-and-idle does not queue a spurious save', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  const session = makeSession()
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  await Promise.all([ctl.saveNow(), ctl.saveNow()])
  await new Promise((r) => setTimeout(r, 0))

  expect(fsMocks.writeFile).not.toHaveBeenCalled()
})

test('ExternalChangeError: onExternalChange is called, doc stays dirty, state is error', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  fsMocks.writeFile.mockImplementation(async () => { throw new fsMocks.ExternalChangeError() })
  const onExternalChange = vi.fn()

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange,
  })

  await ctl.saveNow()

  expect(onExternalChange).toHaveBeenCalledTimes(1)
  expect(store.dirty).toBe(true)
  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'error'])
  expect(modalMocks.toast).not.toHaveBeenCalled()
})

test('generic write error: sticky toast with a "Save as..." action, doc stays dirty, state is error', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  fsMocks.writeFile.mockImplementation(async () => { throw new Error('disk full') })

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  await ctl.saveNow()

  expect(store.dirty).toBe(true)
  expect(setSaveStateSpy.mock.calls.map((c) => c[0])).toEqual(['saving', 'error'])
  expect(modalMocks.toast).toHaveBeenCalledTimes(1)
  const [msg, opts] = modalMocks.toast.mock.calls[0] as [string, { sticky?: boolean; action?: { label: string; onClick: () => void } }]
  expect(msg).toBe('Failed to save — your data is still safe in memory')
  expect(opts.sticky).toBe(true)
  expect(opts.action?.label).toBe('Save as…')
})

test('"Save as..." toast action picks a new file via pickCreate, adopts the session, and saves', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()
  fsMocks.writeFile.mockImplementationOnce(async () => { throw new Error('disk full') })
  const newHandle = {} as unknown as FileSystemFileHandle
  fsMocks.pickCreate.mockResolvedValue({ handle: newHandle, name: 'new-name.tmv', lastModified: 42 })

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  await ctl.saveNow()
  const [, opts] = modalMocks.toast.mock.calls[0] as [string, { action?: { onClick: () => void } }]
  await opts.action?.onClick()
  // onClick fires an async saveAs()/saveNow() chain without the test awaiting
  // it directly — flush microtasks/timers until it settles.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  expect(fsMocks.pickCreate).toHaveBeenCalledWith('x.tmv')
  expect(session.handle).toBe(newHandle)
  expect(session.name).toBe('new-name.tmv')
  expect(fsMocks.writeFile).toHaveBeenLastCalledWith(session, expect.any(Uint8Array))
  expect(store.dirty).toBe(false)
})

test('scheduleFrom re-arms the auto-save interval from prefs.autoSaveMin', async () => {
  vi.useFakeTimers()
  try {
    const store = createStore(createEmptyDocument('en-US'))
    store.update((d) => { d.prefs.autoSaveMin = 1 })
    const shell = makeShell()
    const session = makeSession()
    const ctl = createSaveController({
      store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
    })

    ctl.scheduleFrom({ ...store.doc.prefs, autoSaveMin: 1 } as Prefs)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)

    // Re-arm with a longer interval: no fire at the old 60s mark.
    store.update((d) => { d.prefs.autoSaveMin = 5 })
    ctl.scheduleFrom({ ...store.doc.prefs, autoSaveMin: 5 } as Prefs)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)

    ctl.dispose()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test('fallback mode: scheduleFrom never arms a timer', async () => {
  vi.useFakeTimers()
  try {
    const store = createStore(createEmptyDocument('en-US'))
    store.update((d) => { d.prefs.autoSaveMin = 1 })
    const shell = makeShell()
    const session = makeSession(false)
    const ctl = createSaveController({
      store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
    })

    ctl.scheduleFrom({ ...store.doc.prefs, autoSaveMin: 1 } as Prefs)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fsMocks.downloadFallback).not.toHaveBeenCalled()
    expect(store.dirty).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test('edit landing during an in-flight save is not lost: a trailing round captures it with a fresh snapshot', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()

  // Bytes reflect whatever `autoSaveMin` was *at the moment encryptDocument
  // was called* — lets us tell round 1's (pre-edit) bytes from round 2's
  // (post-edit) bytes without any extra plumbing.
  cryptoMocks.encryptDocument.mockImplementation(async (...args: unknown[]) => {
    const doc = args[0] as { prefs: { autoSaveMin: number } }
    return new Uint8Array([doc.prefs.autoSaveMin])
  })

  const writeDeferred = deferred<void>()
  fsMocks.writeFile.mockImplementationOnce(() => writeDeferred.promise)

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  const p1 = ctl.saveNow()
  // Let doSave call encryptDocument (captures autoSaveMin=9) and suspend on
  // the still-pending write.
  await Promise.resolve()
  await Promise.resolve()

  // The edit lands after the snapshot was taken but before round 1's write
  // resolves — exactly the window where it could previously be lost.
  store.update((d) => { d.prefs.autoSaveMin = 42 })

  writeDeferred.resolve()
  await p1
  // Flush the fire-and-forget trailing round.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  expect(fsMocks.writeFile).toHaveBeenNthCalledWith(1, session, new Uint8Array([9]))
  expect(fsMocks.writeFile).toHaveBeenNthCalledWith(2, session, new Uint8Array([42]))
  expect(store.dirty).toBe(false)
})

test('read-only store: saveNow is a full no-op even when dirty', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  store.setReadOnly(true)
  const shell = makeShell()
  const setSaveStateSpy = vi.spyOn(shell, 'setSaveState')
  const session = makeSession()
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  await ctl.saveNow()
  await ctl.saveNow({ explicit: true })

  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(setSaveStateSpy).not.toHaveBeenCalled()
  expect(store.dirty).toBe(true)
})

test('runExclusive waits out an in-flight save, then serializes fn with no interleaved writes', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()

  const encryptDeferred = deferred<Uint8Array<ArrayBuffer>>()
  cryptoMocks.encryptDocument.mockImplementationOnce(() => encryptDeferred.promise)

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  const p1 = ctl.saveNow() // in flight, suspended on the controlled encrypt

  const order: string[] = []
  const exclusivePromise = ctl.runExclusive(async () => {
    order.push('fn-start')
    await Promise.resolve()
    order.push('fn-end')
    return 'done'
  })

  // fn must not run while the save is still in flight.
  await new Promise((r) => setTimeout(r, 0))
  expect(order).toEqual([])
  expect(fsMocks.writeFile).not.toHaveBeenCalled()

  encryptDeferred.resolve(new Uint8Array([1]))
  await p1
  const result = await exclusivePromise

  expect(result).toBe('done')
  expect(order).toEqual(['fn-start', 'fn-end'])
  // Only the original in-flight save wrote a file — fn itself never touches
  // writeFile, and nothing ran concurrently with it.
  expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
})

test('flush resolves only after an in-flight save and its trailing round both complete', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()

  const write1 = deferred<void>()
  const write2 = deferred<void>()
  fsMocks.writeFile.mockImplementationOnce(() => write1.promise).mockImplementationOnce(() => write2.promise)

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  const p1 = ctl.saveNow()
  // Let round 1 reach writeFile (now stalled on write1).
  await new Promise((r) => setTimeout(r, 0))
  // Force a trailing round while round 1's write is still pending.
  store.update((d) => { d.prefs.autoSaveMin = 42 })

  let flushed = false
  const flushPromise = ctl.flush().then(() => { flushed = true })

  write1.resolve()
  await p1
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  expect(fsMocks.writeFile).toHaveBeenCalledTimes(2) // round 2 reached writeFile too
  expect(flushed).toBe(false) // ...but round 2's write is still pending

  write2.resolve()
  await flushPromise
  expect(flushed).toBe(true)
})

test('a store.updateNav() mid-save forces a trailing round (guard is on onMutate, not subscribe)', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()

  const encryptDeferred = deferred<Uint8Array<ArrayBuffer>>()
  cryptoMocks.encryptDocument.mockImplementationOnce(() => encryptDeferred.promise)

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  const p1 = ctl.saveNow() // starts; suspended awaiting the controlled encrypt promise

  // A nav-only mutation lands while round 1 is in flight. Nothing else calls
  // saveNow() here — if the dirty-guard were still wired to store.subscribe()
  // (which updateNav() never notifies), this edit would be silently dropped:
  // round 1's markSaved() would clear dirty even though this change was never
  // captured in the bytes it's about to write.
  store.updateNav((d) => { d.nav.activeTeamId = 'mid-save' })

  encryptDeferred.resolve(new Uint8Array([9]))
  await p1
  // let the fire-and-forget trailing round finish
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  expect(store.dirty).toBe(false)
})

test('read-only store: a changePassword-style runExclusive guard rejects before ever writing', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.setReadOnly(true)
  const shell = makeShell()
  const session = makeSession()
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  // Mirrors main.ts's PrefsAppCtl.changePassword (Task 25 re-review item #2):
  // the read-only check is the very first line inside runExclusive's fn, so a
  // tab that lost the cross-tab write lock can't rewrite the file under a new
  // password even though runExclusive itself has no opinion about readOnly.
  const changePassword = (_newPw: string): Promise<void> =>
    ctl.runExclusive(async () => {
      if (store.readOnly) throw new Error('read-only')
      await cryptoMocks.encryptDocument()
      await fsMocks.writeFile()
    })

  await expect(changePassword('new-pw')).rejects.toThrow('read-only')
  expect(fsMocks.writeFile).not.toHaveBeenCalled()
  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
})

test('runExclusive serializes two concurrent callers: no interleaved fn execution', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  const session = makeSession()
  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US', onExternalChange: vi.fn(),
  })

  const order: string[] = []
  const firstDeferred = deferred<void>()

  function makeFn(label: string, wait?: Promise<void>): () => Promise<string> {
    return async () => {
      order.push(`${label}-start`)
      if (wait) await wait
      else await Promise.resolve()
      order.push(`${label}-end`)
      return label
    }
  }

  // Two runExclusive() calls kicked off in the same tick, with no in-flight
  // save at all — the race this hardens against doesn't require one; it's in
  // runExclusive/flush's own wake-up handshake.
  const p1 = ctl.runExclusive(makeFn('a', firstDeferred.promise))
  const p2 = ctl.runExclusive(makeFn('b'))

  // Let microtasks settle a bit — b must NOT have started while a is still
  // running (a is deliberately held open by firstDeferred).
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  expect(order).toEqual(['a-start'])

  firstDeferred.resolve()
  const [r1, r2] = await Promise.all([p1, p2])

  expect(r1).toBe('a')
  expect(r2).toBe('b')
  // Strictly serialized: a fully finishes before b starts.
  expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
})

test('conflict guard: a second ExternalChangeError does not call onExternalChange again while the first is unresolved', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.prefs.autoSaveMin = 9 })
  const shell = makeShell()
  const session = makeSession()
  fsMocks.writeFile.mockImplementation(async () => { throw new fsMocks.ExternalChangeError() })
  const onExternalChange = vi.fn()
  let conflictOpen = false

  const ctl = createSaveController({
    store, session, getPassword: () => 'pw', shell, locale: () => 'en-US',
    onExternalChange: () => {
      conflictOpen = true // mirrors main.ts opening the (single) conflict modal
      onExternalChange()
    },
    isConflictOpen: () => conflictOpen,
  })

  const encryptDeferred = deferred<Uint8Array<ArrayBuffer>>()
  cryptoMocks.encryptDocument.mockImplementationOnce(() => encryptDeferred.promise)

  const p1 = ctl.saveNow()
  // A second edit while round 1 is in flight forces a trailing round, which
  // will hit the same ExternalChangeError from the mocked writeFile again.
  store.update((d) => { d.prefs.autoSaveMin = 7 })
  encryptDeferred.resolve(new Uint8Array([1]))

  await p1
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  expect(onExternalChange).toHaveBeenCalledTimes(1)
  expect(store.dirty).toBe(true)
})
