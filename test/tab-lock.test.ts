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
