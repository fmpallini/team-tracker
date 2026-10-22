import { createFileSnapshot, type FileHealth, type FileSnapshotDeps } from '../src/core/file-snapshot'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { parsePlainWithVersion } from '../src/core/crypto'
import type { FileSession } from '../src/core/fs'
import type { LivePersister } from '../src/core/live-persist'

const fsMocks = vi.hoisted(() => {
  class ExternalChangeError extends Error {}
  return {
    ExternalChangeError,
    writeFile: vi.fn(async (_s: unknown, _b: Uint8Array) => {}),
    downloadFallback: vi.fn(),
  }
})
vi.mock('../src/core/fs', () => fsMocks)

const HOUR = 60 * 60_000

function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++
      pending.set(id, { fn, ms })
      return () => { pending.delete(id) }
    },
    count: () => pending.size,
    delays: () => [...pending.values()].map((t) => t.ms),
    fire: () => { const all = [...pending.values()]; pending.clear(); all.forEach((t) => t.fn()) },
  }
}

let clock: number
const session = (withHandle = true): FileSession => ({ handle: withHandle ? ({} as unknown as FileSystemFileHandle) : null, name: 'f.tmv', lastModified: 1 })

function rig(over: Partial<FileSnapshotDeps> & { handle?: boolean; dirty?: boolean } = {}) {
  const store: Store = createStore(createEmptyDocument('en-US'))
  if (over.dirty !== false) store.update((d) => { d.nav.split = true })
  const persister = { flush: vi.fn(async () => {}), markFileWritten: vi.fn(async () => {}) } as unknown as LivePersister & { flush: ReturnType<typeof vi.fn>; markFileWritten: ReturnType<typeof vi.fn> }
  const timers = manualTimers()
  const onExternalChange = vi.fn()
  const snap = createFileSnapshot({
    store, session: session(over.handle !== false), getPassword: () => null, persister,
    onExternalChange, now: () => clock, schedule: timers.schedule, ...over,
  })
  return { store, snap, persister, timers, onExternalChange }
}

beforeEach(() => {
  clock = 1_000_000
  fsMocks.writeFile.mockReset().mockImplementation(async () => {})
  fsMocks.downloadFallback.mockReset()
})

describe('writeNow', () => {
  test('writes through the file handle, commits the stamp it wrote, and marks the document saved', async () => {
    const { store, snap, persister } = rig()
    const revBefore = store.rev

    expect(await snap.writeNow('close')).toEqual({ ok: true })

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    const bytes = fsMocks.writeFile.mock.calls[0]![1]
    const stamp = parsePlainWithVersion(bytes)!.stamp!
    expect(persister.markFileWritten).toHaveBeenCalledWith(stamp, revBefore)
    expect(store.dirty).toBe(false)
    expect(fsMocks.downloadFallback).not.toHaveBeenCalled()
  })

  test('commits pending editor input and the browser copy before it serializes', async () => {
    const order: string[] = []
    const persister = { flush: vi.fn(async () => { order.push('persister') }), markFileWritten: vi.fn(async () => {}) }
    const { snap } = rig({ flushPending: () => order.push('editors'), persister: persister as never })
    fsMocks.writeFile.mockImplementation(async () => { order.push('write') })
    await snap.writeNow('close')
    expect(order).toEqual(['editors', 'persister', 'write'])
  })

  test('a clean document is not written for the timer or for close, but is for open and export', async () => {
    const { snap } = rig({ dirty: false })
    expect(await snap.writeNow('timer')).toEqual({ ok: true })
    expect(await snap.writeNow('close')).toEqual({ ok: true })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(await snap.writeNow('open')).toEqual({ ok: true })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(await snap.writeNow('export')).toEqual({ ok: true })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  })

  test('a read-only tab never writes', async () => {
    const { store, snap } = rig()
    store.setReadOnly(true)
    expect(await snap.writeNow('close')).toEqual({ ok: false, reason: 'readonly' })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  test('an edit that lands during the write is not in the bytes, so the document stays dirty', async () => {
    const { store, snap } = rig()
    fsMocks.writeFile.mockImplementation(async () => { store.update((d) => { d.nav.split = false }) })
    expect(await snap.writeNow('timer')).toEqual({ ok: true })
    expect(store.dirty).toBe(true)
    // and no trailing write is queued: the next moment (timer, close) takes it
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  test('two calls at once share one write', async () => {
    const { snap } = rig()
    let release!: () => void
    fsMocks.writeFile.mockImplementation(() => new Promise<void>((r) => { release = r }))
    const a = snap.writeNow('timer')
    const b = snap.writeNow('timer')
    await new Promise((r) => setTimeout(r, 5))
    release()
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }])
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  test('a close that joins a write already in flight still leaves the file current: it writes again for edits made since', async () => {
    const { store, snap } = rig()
    let release!: () => void
    fsMocks.writeFile.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const timer = snap.writeNow('timer')
    await new Promise((r) => setTimeout(r, 5))
    store.update((d) => { d.nav.split = false })
    const close = snap.writeNow('close')
    release()
    await Promise.all([timer, close])
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
    expect(store.dirty).toBe(false)
  })

  test('the failure of a write the persister could not record does not turn a good file write into a failure', async () => {
    const { store, snap } = rig({ persister: { flush: vi.fn(async () => {}), markFileWritten: vi.fn(async () => { throw new Error('idb gone') }) } as never })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await snap.writeNow('close')).toEqual({ ok: true })
    expect(store.dirty).toBe(false)
    spy.mockRestore()
  })

  test('a failed browser flush before the write does not stop the file write either', async () => {
    const { snap } = rig({ persister: { flush: vi.fn(async () => { throw new Error('quota') }), markFileWritten: vi.fn(async () => {}) } as never })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await snap.writeNow('close')).toEqual({ ok: true })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test('without browser storage (no persister) it still writes', async () => {
    const { store, snap } = rig({ persister: null })
    expect(await snap.writeNow('close')).toEqual({ ok: true })
    expect(store.dirty).toBe(false)
  })
})

describe('failures', () => {
  test('a write that fails leaves the document dirty, the persister untouched, and the health on error', async () => {
    const { store, snap, persister } = rig()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsMocks.writeFile.mockRejectedValue(new Error('disk full'))
    expect(await snap.writeNow('close')).toEqual({ ok: false, reason: 'error' })
    expect(store.dirty).toBe(true)
    expect(persister.markFileWritten).not.toHaveBeenCalled()
    expect(snap.health()).toMatchObject({ kind: 'error' })
    spy.mockRestore()
  })

  test('a lapsed permission shows as such; re-granting clears it and writes what was waiting', async () => {
    const queryPermission = vi.fn(async () => 'prompt')
    const requestPermission = vi.fn(async () => 'granted')
    const handle = { queryPermission, requestPermission } as unknown as FileSystemFileHandle
    const { store, snap } = rig({ session: { handle, name: 'f.tmv', lastModified: 1 } })
    fsMocks.writeFile.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
    expect(await snap.writeNow('timer')).toEqual({ ok: false, reason: 'permission' })
    expect(snap.health()).toEqual({ kind: 'permission' })

    expect(await snap.resolveGrants()).toBe(true)
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(snap.health().kind).toBe('ok')
    expect(store.dirty).toBe(false)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
  })

  test('resolveGrants reports false when the user declines, and the health stays on permission', async () => {
    const handle = { queryPermission: vi.fn(async () => 'prompt'), requestPermission: vi.fn(async () => 'denied') } as unknown as FileSystemFileHandle
    const { snap } = rig({ session: { handle, name: 'f.tmv', lastModified: 1 } })
    fsMocks.writeFile.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
    await snap.writeNow('timer')
    expect(await snap.resolveGrants()).toBe(false)
    expect(snap.health()).toEqual({ kind: 'permission' })
  })

  test('an external change opens the conflict handler once, not again while it is up', async () => {
    let open = false
    const { snap, onExternalChange } = rig({ isConflictOpen: () => open })
    fsMocks.writeFile.mockRejectedValue(new fsMocks.ExternalChangeError())
    onExternalChange.mockImplementation(() => { open = true })
    expect(await snap.writeNow('timer')).toEqual({ ok: false, reason: 'conflict' })
    expect(onExternalChange).toHaveBeenCalledTimes(1)
    // while the modal is up a further attempt does not even touch the file
    expect(await snap.writeNow('timer')).toEqual({ ok: false, reason: 'conflict' })
    expect(onExternalChange).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  test('a later success resets the health to ok', async () => {
    const { snap } = rig()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsMocks.writeFile.mockRejectedValueOnce(new Error('x'))
    await snap.writeNow('timer')
    expect(snap.health().kind).toBe('error')
    await snap.writeNow('open')
    expect(snap.health()).toEqual({ kind: 'ok', lastWrittenAt: clock })
    spy.mockRestore()
  })
})

describe('writes made outside writeNow (the conflict overwrite, a password change)', () => {
  test('fileWritten: the health is ok again, the write counts as the last one, and a conflict failure is over', async () => {
    const { snap } = rig()
    fsMocks.writeFile.mockRejectedValueOnce(new fsMocks.ExternalChangeError())
    await snap.writeNow('close')
    expect(snap.health()).toMatchObject({ kind: 'error', message: 'conflict' })
    clock += 5000
    snap.fileWritten()
    expect(snap.health()).toEqual({ kind: 'ok', lastWrittenAt: clock })
    expect(snap.isOverdue()).toBe(false)
  })

  test('fileWritten also clears a failure that was not about a conflict: a successful write supersedes it', async () => {
    const { snap } = rig()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'))
    await snap.writeNow('close')
    snap.fileWritten()
    expect(snap.health().kind).toBe('ok')
    spy.mockRestore()
  })

  test('fileReloaded: the conflict is over but no write is claimed', async () => {
    const { snap } = rig()
    fsMocks.writeFile.mockRejectedValueOnce(new fsMocks.ExternalChangeError())
    await snap.writeNow('close')
    clock += 5000
    snap.fileReloaded()
    expect(snap.health()).toEqual({ kind: 'ok', lastWrittenAt: null })
  })

  test('fileReloaded never hides some other kind of failure', async () => {
    const { snap } = rig()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'))
    await snap.writeNow('close')
    snap.fileReloaded()
    expect(snap.health().kind).toBe('error')
    spy.mockRestore()
  })

  test('fileWriteFailed puts the health on the failure that happened', () => {
    const { snap } = rig()
    snap.fileWriteFailed('permission')
    expect(snap.health()).toEqual({ kind: 'permission' })
    snap.fileWriteFailed('error')
    expect(snap.health()).toMatchObject({ kind: 'error' })
  })
})

describe('nextWriteAt', () => {
  const prefs = (autoSaveMin: number) => ({ ...createEmptyDocument('en-US').prefs, autoSaveMin })

  test('is one interval after open, then after the last successful write', async () => {
    const { snap } = rig()
    snap.scheduleFrom(prefs(60))
    expect(snap.nextWriteAt()).toBe(clock + HOUR)
    clock += 20 * 60_000
    await snap.writeNow('close')
    expect(snap.nextWriteAt()).toBe(clock + HOUR)
  })

  test('follows the configured interval, clamped to 1..24 hours', () => {
    const { snap } = rig()
    snap.scheduleFrom(prefs(180))
    expect(snap.nextWriteAt()).toBe(clock + 3 * HOUR)
    snap.scheduleFrom(prefs(1))
    expect(snap.nextWriteAt()).toBe(clock + HOUR)
  })

  test('without a file handle it is the moment the last export turns stale', async () => {
    const { snap } = rig({ handle: false })
    expect(snap.nextWriteAt()).toBe(clock + HOUR)
    clock += 10 * 60_000
    await snap.writeNow('export')
    expect(snap.nextWriteAt()).toBe(clock + HOUR)
  })
})

describe('isOverdue', () => {
  test('is true only for a dirty document whose last write (or open) is a full interval old', () => {
    const { store, snap } = rig()
    expect(snap.isOverdue()).toBe(false)
    clock += HOUR - 1
    expect(snap.isOverdue()).toBe(false)
    clock += 1
    expect(snap.isOverdue()).toBe(true)
    store.markSaved()
    expect(snap.isOverdue()).toBe(false)
  })

  test('a write resets the clock', async () => {
    const { store, snap } = rig()
    clock += 2 * HOUR
    expect(snap.isOverdue()).toBe(true)
    await snap.writeNow('close')
    store.update((d) => { d.nav.split = false })
    expect(store.dirty).toBe(true)
    expect(snap.isOverdue()).toBe(false)
  })
})

describe('subscribe', () => {
  test('tells the subscriber the current health at once and every change after, until it unsubscribes', async () => {
    const { snap } = rig()
    const seen: FileHealth[] = []
    const off = snap.subscribe((h) => seen.push(h))
    expect(seen).toEqual([{ kind: 'ok', lastWrittenAt: null }])
    await snap.writeNow('close')
    expect(seen.map((h) => h.kind)).toEqual(['ok', 'writing', 'ok'])
    off()
    await snap.writeNow('open')
    expect(seen).toHaveLength(3)
  })
})

describe('runExclusive and flush', () => {
  test('runs the function alone: a write requested meanwhile waits for it, and nothing interleaves', async () => {
    const { snap } = rig()
    const events: string[] = []
    let release!: () => void
    const exclusive = snap.runExclusive(async () => {
      events.push('fn-start')
      await new Promise<void>((r) => { release = r })
      events.push('fn-end')
    })
    fsMocks.writeFile.mockImplementation(async () => { events.push('write') })
    const write = snap.writeNow('close')
    await new Promise((r) => setTimeout(r, 5))
    expect(events).toEqual(['fn-start'])
    release()
    await Promise.all([exclusive, write])
    expect(events).toEqual(['fn-start', 'fn-end', 'write'])
  })

  test('two exclusive callers run one after the other', async () => {
    const { snap } = rig()
    const events: string[] = []
    const run = (name: string) => snap.runExclusive(async () => {
      events.push(`${name}-start`)
      await new Promise((r) => setTimeout(r, 5))
      events.push(`${name}-end`)
    })
    await Promise.all([run('a'), run('b')])
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  test('flush resolves once the write in flight has settled', async () => {
    const { snap } = rig()
    let release!: () => void
    fsMocks.writeFile.mockImplementation(() => new Promise<void>((r) => { release = r }))
    const w = snap.writeNow('timer')
    let flushed = false
    const f = snap.flush().then(() => { flushed = true })
    await new Promise((r) => setTimeout(r, 5))
    expect(flushed).toBe(false)
    release()
    await Promise.all([w, f])
    expect(flushed).toBe(true)
  })

  test('a function that throws does not wedge the gate', async () => {
    const { snap } = rig()
    await expect(snap.runExclusive(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await snap.writeNow('close')).toEqual({ ok: true })
  })
})
