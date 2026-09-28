import { createTabLock } from '../src/core/tab-lock'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createShell, type Shell } from '../src/ui/shell'
import type { FileSession } from '../src/core/fs'
import type { SaveController } from '../src/core/save-controller'

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
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  return shell
}

function makeSession(name = 'team.tmv'): FileSession {
  return { handle: {} as unknown as FileSystemFileHandle, name, lastModified: 1 }
}

function makeSaveCtl(overrides: Partial<SaveController> = {}): SaveController {
  return {
    saveNow: vi.fn(async () => {}),
    scheduleFrom: vi.fn(),
    runExclusive: vi.fn(async (fn) => fn()),
    flush: vi.fn(async () => {}),
    resolveGrants: vi.fn(async () => {}),
    dispose: vi.fn(),
    ...overrides,
  }
}

/**
 * Minimal Web Locks API fake: a single named lock, granted immediately when
 * free, `ifAvailable` resolves with `cb(null)` when held, otherwise queues
 * (matching `navigator.locks.request`'s real blocking-request semantics). The
 * lock is considered released exactly when the holder's own callback-returned
 * promise settles — same as the spec — so queued waiters are only granted
 * after the holder's `enterReadOnly()`/`release()` sequence actually
 * completes, which is the exact ordering Task 25 fix #4 depends on.
 */
function makeFakeLockManager() {
  type Cb = (lock: { name: string } | null) => Promise<unknown> | undefined
  let held = false
  const queue: Array<() => void> = []

  function grant(cb: Cb, resolveOuter: (v: unknown) => void): void {
    held = true
    const result = cb({ name: 'fake-lock' })
    void Promise.resolve(result).then((v) => {
      held = false
      resolveOuter(v)
      const next = queue.shift()
      if (next) next()
    })
  }

  const request = vi.fn((_name: string, opts: { ifAvailable?: boolean }, cb: Cb) => {
    return new Promise((resolve) => {
      if (!held) {
        grant(cb, resolve)
        return
      }
      if (opts.ifAvailable) {
        resolve(cb(null))
        return
      }
      queue.push(() => grant(cb, resolve))
    })
  })

  return { locks: { request } as unknown as LockManager }
}

beforeEach(() => {
  modalMocks.toast.mockReset()
})

// makeShell() appends into the real (shared-across-tests) document.body;
// without this, a banner left over from an earlier test can shadow the
// current test's querySelector lookups.
afterEach(() => {
  document.body.innerHTML = ''
})

test('neither Web Locks nor BroadcastChannel supported: fully inert, no-op release', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const release = createTabLock({
    session: makeSession(), store, shell: makeShell(), saveCtl: makeSaveCtl(),
    locks: undefined, BroadcastChannelCtor: undefined,
  })
  expect(store.readOnly).toBe(false)
  expect(() => release()).not.toThrow()
})

test('BroadcastChannel supported but Web Locks not (this repo\'s own jsdom test env): never goes read-only', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const release = createTabLock({
    session: makeSession(), store, shell: makeShell(), saveCtl: makeSaveCtl(), locks: undefined,
  })
  expect(store.readOnly).toBe(false)
  expect(document.querySelector('.tt-readonly-banner')).toBeNull()
  expect(() => release()).not.toThrow()
})

/**
 * `createTabLock` registers a `store.onBlockedUpdate` listener for the
 * read-only toast. Releasing the tab lock (main.ts's close-file path) has to
 * take it back off: the store outlives the release only briefly, but a
 * listener that closes over this shell and store is exactly what a close-file
 * → open-file cycle must not accumulate.
 */
test('releasing the tab lock unsubscribes the read-only toast listener', () => {
  const store = createStore(createEmptyDocument('en-US'))
  const release = createTabLock({
    session: makeSession(), store, shell: makeShell(), saveCtl: makeSaveCtl(), locks: undefined,
  })

  store.setReadOnly(true)
  store.update((d) => { d.prefs.autoSaveMin = 3 })
  expect(modalMocks.toast).toHaveBeenCalledTimes(1)

  release()

  // A fresh read-only session re-arms the store's one-shot warning, so this
  // would toast again if the listener were still registered.
  store.setReadOnly(false)
  store.setReadOnly(true)
  store.update((d) => { d.prefs.autoSaveMin = 4 })
  expect(modalMocks.toast).toHaveBeenCalledTimes(1)
})

test('sole tab: acquires the lock immediately, stays writable, no banner', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  const { locks } = makeFakeLockManager()
  createTabLock({ session: makeSession(), store, shell, saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()

  expect(store.readOnly).toBe(false)
  expect(document.querySelector('.tt-readonly-banner')).toBeNull()
})

test('a second tab (lock already held): enters read-only, shows the takeover banner, and blocks store.update with a toast', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  const { locks } = makeFakeLockManager()
  // First tab grabs the lock and holds it open indefinitely (never releases).
  // `held` flips synchronously inside the Promise executor, so this doesn't
  // need to be awaited — awaiting it would hang forever, since the lock is
  // deliberately never released.
  void locks.request('tmv:x', {}, () => new Promise<void>(() => {}))

  createTabLock({ session: makeSession('x'), store, shell, saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()

  expect(store.readOnly).toBe(true)
  const banner = document.querySelector('.tt-readonly-banner')
  expect(banner).not.toBeNull()
  expect(banner?.nextElementSibling).toBe(shell.root)

  store.update(() => {})
  expect(modalMocks.toast).toHaveBeenCalledTimes(1)
})

test('take-control handshake: holder saves+flushes before releasing, requester only exits read-only after that settles', async () => {
  const { locks } = makeFakeLockManager()
  const session = makeSession('shared.tmv')

  // Tab A: the current holder.
  const storeA = createStore(createEmptyDocument('en-US'))
  const shellA = makeShell()
  let resolveFlush!: () => void
  const flushCalled = vi.fn(async () => new Promise<void>((resolve) => { resolveFlush = resolve }))
  const saveCtlA = makeSaveCtl({ saveNow: vi.fn(async () => {}), flush: flushCalled })
  createTabLock({ session, store: storeA, shell: shellA, saveCtl: saveCtlA, locks })
  await Promise.resolve()
  await Promise.resolve()
  expect(storeA.readOnly).toBe(false) // A holds the lock, fully writable

  // Tab B: opens after A, sees the lock unavailable, goes read-only.
  const storeB = createStore(createEmptyDocument('en-US'))
  const shellB = makeShell()
  const saveCtlB = makeSaveCtl()
  createTabLock({ session, store: storeB, shell: shellB, saveCtl: saveCtlB, locks })
  await Promise.resolve()
  await Promise.resolve()
  expect(storeB.readOnly).toBe(true)

  // B clicks "Take control". BroadcastChannel delivery crosses a real
  // macrotask (it's backed by Node's worker_threads MessageChannel, not a
  // microtask) whose exact hop count isn't worth pinning down by hand — poll
  // instead of guessing a fixed number of ticks, which flaked under a loaded
  // test run (many files/processes contending for the event loop).
  const takeoverBtn = shellB.root.parentElement?.querySelector<HTMLButtonElement>('.tt-readonly-takeover-btn')
  expect(takeoverBtn).toBeTruthy()
  takeoverBtn!.click()
  await vi.waitFor(() => expect(flushCalled).toHaveBeenCalledTimes(1))

  // A has started its handoff (flush is in flight) but hasn't released yet —
  // B must still be blocked, proving the fix #4 ordering isn't skipped.
  expect(storeA.readOnly).toBe(false)
  expect(storeB.readOnly).toBe(true)

  // A's flush() finally settles: A becomes read-only and releases; B is
  // granted the lock and exits read-only.
  resolveFlush()
  await vi.waitFor(() => expect(storeB.readOnly).toBe(false))

  expect(storeA.readOnly).toBe(true)
})

test('releaseTabLock() lets the same file be reopened without hanging behind its own lock', async () => {
  const { locks } = makeFakeLockManager()
  const session = makeSession('reopen.tmv')
  const store1 = createStore(createEmptyDocument('en-US'))
  const release1 = createTabLock({ session, store: store1, shell: makeShell(), saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()
  expect(store1.readOnly).toBe(false)

  release1()
  await Promise.resolve()
  await Promise.resolve()

  const store2 = createStore(createEmptyDocument('en-US'))
  createTabLock({ session, store: store2, shell: makeShell(), saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()

  expect(store2.readOnly).toBe(false)
})

/**
 * A read-only tab can close its file (main.ts's closeFile). Its tab lock may
 * still have a queued "Take control" request in flight; if that is granted
 * after the release, it must hand the lock straight back instead of holding it
 * forever for a document nobody has open — and must not flip the discarded
 * store writable or resurrect the banner.
 */
test('releasing a read-only tab with a pending takeover drops the lock as soon as it is granted', async () => {
  const { locks } = makeFakeLockManager()
  const session = makeSession('closing-reader.tmv')

  const storeA = createStore(createEmptyDocument('en-US'))
  createTabLock({ session, store: storeA, shell: makeShell(), saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()
  expect(storeA.readOnly).toBe(false)

  const storeB = createStore(createEmptyDocument('en-US'))
  const shellB = makeShell()
  const releaseB = createTabLock({ session, store: storeB, shell: shellB, saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()
  expect(storeB.readOnly).toBe(true)

  // B asks for control, then closes before A's handoff completes.
  shellB.root.parentElement!.querySelector<HTMLButtonElement>('.tt-readonly-takeover-btn')!.click()
  releaseB()
  expect(document.querySelectorAll('.tt-readonly-banner')).toHaveLength(0)

  // A still hands off (the message was already sent) and goes read-only.
  await vi.waitFor(() => expect(storeA.readOnly).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 0))

  // B's late grant must neither touch its discarded store nor keep the lock.
  expect(storeB.readOnly).toBe(true)
  expect(document.querySelectorAll('.tt-readonly-banner')).toHaveLength(1) // A's own banner only

  const storeC = createStore(createEmptyDocument('en-US'))
  createTabLock({ session, store: storeC, shell: makeShell(), saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()
  expect(storeC.readOnly).toBe(false)
})

/**
 * makeFakeLockManager() above grants synchronously (its Promise executor runs
 * the callback inline), which happens to collapse the provisional-read-only
 * window to nothing — no good for testing that the window itself is covered.
 * This defers the grant by a microtask, like the real Web Locks API's actual
 * async round trip, so the gap is observable.
 */
function makeDeferredLockManager() {
  const request = vi.fn((_name: string, _opts: unknown, cb: (lock: { name: string } | null) => Promise<unknown> | undefined) => {
    return new Promise((resolve) => {
      void Promise.resolve().then(() => {
        void Promise.resolve(cb({ name: 'fake-lock' })).then(resolve)
      })
    })
  })
  return { locks: { request } as unknown as LockManager }
}

test('provisional read-only (re-review #4a): readOnly is already true the instant createTabLock returns, before the lock request settles, and never flashes the blocked toast for a solo tab', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  const { locks } = makeDeferredLockManager()

  createTabLock({ session: makeSession('provisional.tmv'), store, shell, saveCtl: makeSaveCtl(), locks })

  // Synchronous check, no await: setReadOnly(true, {silent:true}) runs before
  // requestLock() is even called, so this must already be true.
  expect(store.readOnly).toBe(true)
  // An update attempted during this provisional window is still blocked...
  store.update(() => {})
  // ...but silently: the one-shot toast must not burn here, or a normal
  // solo-tab open would flash a warning it has no business showing.
  expect(modalMocks.toast).not.toHaveBeenCalled()

  await Promise.resolve()
  await Promise.resolve()

  // Solo tab: the lock resolves in this tab's favor, so it becomes writable
  // again — and still never having shown the toast.
  expect(store.readOnly).toBe(false)
  expect(modalMocks.toast).not.toHaveBeenCalled()
})

test('a real cross-instance BroadcastChannel takeover message is ignored by a tab that isn\'t holding the lock', async () => {
  const store = createStore(createEmptyDocument('en-US'))
  const shell = makeShell()
  createTabLock({ session: makeSession('bc-only.tmv'), store, shell, saveCtl: makeSaveCtl(), locks: undefined })

  const otherTabChannel = new BroadcastChannel('tmv:bc-only.tmv')
  otherTabChannel.postMessage({ type: 'takeover' })
  await new Promise((resolve) => setTimeout(resolve, 50))

  // No lock support means this tab never held anything to hand over —
  // must not throw or flip read-only just because a takeover message arrived.
  expect(store.readOnly).toBe(false)
  otherTabChannel.close()
})

test('onReadOnlyChange reports only the visible read-only transitions — never for a sole tab', async () => {
  const { locks } = makeFakeLockManager()
  const session = makeSession('ro-change.tmv')

  const changesA: boolean[] = []
  const storeA = createStore(createEmptyDocument('en-US'))
  createTabLock({ session, store: storeA, shell: makeShell(), saveCtl: makeSaveCtl(), locks, onReadOnlyChange: (ro) => changesA.push(ro) })
  await Promise.resolve()
  await Promise.resolve()
  expect(changesA).toEqual([])

  const changesB: boolean[] = []
  const storeB = createStore(createEmptyDocument('en-US'))
  const shellB = makeShell()
  createTabLock({ session, store: storeB, shell: shellB, saveCtl: makeSaveCtl(), locks, onReadOnlyChange: (ro) => changesB.push(ro) })
  await Promise.resolve()
  await Promise.resolve()
  expect(changesB).toEqual([true])

  shellB.root.parentElement!.querySelector<HTMLButtonElement>('.tt-readonly-takeover-btn')!.click()
  await vi.waitFor(() => expect(storeB.readOnly).toBe(false))
  expect(changesB).toEqual([true, false])
  expect(changesA).toEqual([true])
})

test('taking control refreshes the document from disk BEFORE the tab becomes writable', async () => {
  // The previous holder saved on its way out; this tab's in-memory copy
  // predates that. Becoming writable first would let the next save either
  // hit a conflict or (via Overwrite) erase the other tab's edits.
  const { locks } = makeFakeLockManager()
  const session = makeSession('refresh.tmv')
  createTabLock({ session, store: createStore(createEmptyDocument('en-US')), shell: makeShell(), saveCtl: makeSaveCtl(), locks })
  await Promise.resolve()
  await Promise.resolve()

  const storeB = createStore(createEmptyDocument('en-US'))
  const shellB = makeShell()
  let finishRefresh!: () => void
  const readOnlyDuringRefresh: boolean[] = []
  const refreshBeforeWritable = vi.fn(() => {
    readOnlyDuringRefresh.push(storeB.readOnly)
    return new Promise<void>((resolve) => { finishRefresh = resolve })
  })
  createTabLock({ session, store: storeB, shell: shellB, saveCtl: makeSaveCtl(), locks, refreshBeforeWritable })
  await Promise.resolve()
  await Promise.resolve()
  expect(refreshBeforeWritable).not.toHaveBeenCalled()

  shellB.root.parentElement!.querySelector<HTMLButtonElement>('.tt-readonly-takeover-btn')!.click()
  await vi.waitFor(() => expect(refreshBeforeWritable).toHaveBeenCalledTimes(1))
  expect(readOnlyDuringRefresh).toEqual([true])
  expect(storeB.readOnly).toBe(true)

  finishRefresh()
  await vi.waitFor(() => expect(storeB.readOnly).toBe(false))
})

test('a sole tab never refreshes from disk on acquiring the lock', async () => {
  const { locks } = makeFakeLockManager()
  const refreshBeforeWritable = vi.fn(async () => {})
  const store = createStore(createEmptyDocument('en-US'))
  createTabLock({ session: makeSession('solo.tmv'), store, shell: makeShell(), saveCtl: makeSaveCtl(), locks, refreshBeforeWritable })
  await vi.waitFor(() => expect(store.readOnly).toBe(false))
  expect(refreshBeforeWritable).not.toHaveBeenCalled()
})

test('closing a visibly read-only tab reports the read-only state lifted', async () => {
  // main.ts's editor read-only flag is module-level: left set, the NEXT
  // document opened in this tab would come up with non-editable editors.
  const { locks } = makeFakeLockManager()
  void locks.request('tmv:closing.tmv', {}, () => new Promise<void>(() => {}))
  const changes: boolean[] = []
  const release = createTabLock({ session: makeSession('closing.tmv'), store: createStore(createEmptyDocument('en-US')), shell: makeShell(), saveCtl: makeSaveCtl(), locks, onReadOnlyChange: (ro) => changes.push(ro) })
  await vi.waitFor(() => expect(changes).toEqual([true]))
  release()
  expect(changes).toEqual([true, false])
})

/** One independent fake lock per name — the shared fake above ignores names. */
function makeNamedLockManager(): LockManager {
  const byName = new Map<string, LockManager>()
  return {
    request: (name: string, opts: LockOptions, cb: LockGrantedCallback<unknown>) => {
      let lm = byName.get(name)
      if (!lm) { lm = makeFakeLockManager().locks; byName.set(name, lm) }
      return lm.request(name, opts, cb)
    },
  } as unknown as LockManager
}

test('lockKey: two different files that share a name both stay writable', async () => {
  const locks = makeNamedLockManager()
  const storeA = createStore(createEmptyDocument('en-US'))
  const storeB = createStore(createEmptyDocument('en-US'))
  createTabLock({ session: makeSession('team.tmv'), store: storeA, shell: makeShell(), saveCtl: makeSaveCtl(), locks, lockKey: Promise.resolve('tmv:file-a') })
  createTabLock({ session: makeSession('team.tmv'), store: storeB, shell: makeShell(), saveCtl: makeSaveCtl(), locks, lockKey: Promise.resolve('tmv:file-b') })
  await vi.waitFor(() => expect(storeA.readOnly).toBe(false))
  await vi.waitFor(() => expect(storeB.readOnly).toBe(false))
})

test('lockKey: the same file under the same key still makes the second tab read-only, provisionally from the start', async () => {
  const locks = makeNamedLockManager()
  const storeA = createStore(createEmptyDocument('en-US'))
  createTabLock({ session: makeSession('team.tmv'), store: storeA, shell: makeShell(), saveCtl: makeSaveCtl(), locks, lockKey: Promise.resolve('tmv:same') })
  await vi.waitFor(() => expect(storeA.readOnly).toBe(false))

  let resolveKey!: (k: string) => void
  const storeB = createStore(createEmptyDocument('en-US'))
  createTabLock({ session: makeSession('team.tmv'), store: storeB, shell: makeShell(), saveCtl: makeSaveCtl(), locks, lockKey: new Promise<string>((r) => { resolveKey = r }) })
  // Still resolving the key: already (silently) read-only, so nothing can be
  // written before the lock is known to be ours.
  expect(storeB.readOnly).toBe(true)
  resolveKey('tmv:same')
  await vi.waitFor(() => expect(document.querySelectorAll('.tt-readonly-banner')).toHaveLength(1))
  expect(storeB.readOnly).toBe(true)
})
