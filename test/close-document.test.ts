import { closeDocument, createBeforeUnloadHandler, type CloseDocumentDeps } from '../src/core/close-document'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { parsePlainWithVersion } from '../src/core/crypto'
import type { FileSnapshot, WriteResult } from '../src/core/file-snapshot'
import type { LivePersister } from '../src/core/live-persist'

const fsMocks = vi.hoisted(() => ({ downloadFallback: vi.fn() }))
vi.mock('../src/core/fs', () => fsMocks)
const modal = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../src/ui/modal', () => modal)

type Ask = CloseDocumentDeps['ask']

function rig(over: { writes?: WriteResult[]; ask?: Ask; flushError?: unknown; conflictOpen?: boolean; readOnly?: boolean } = {}) {
  const store: Store = createStore(createEmptyDocument('en-US'))
  store.update((d) => { d.nav.split = true })
  if (over.readOnly) store.setReadOnly(true)
  const order: string[] = []
  const writes = [...(over.writes ?? [{ ok: true } as WriteResult])]
  const snapshot = {
    writeNow: vi.fn(async (reason: string) => { order.push(`write:${reason}`); return writes.length > 1 ? writes.shift()! : writes[0]! }),
    flush: vi.fn(async () => {}),
    resolveGrants: vi.fn(async () => true),
  } as unknown as FileSnapshot & { writeNow: ReturnType<typeof vi.fn>; resolveGrants: ReturnType<typeof vi.fn> }
  const persister = {
    flush: vi.fn(async () => { order.push('persister') }),
    get lastError() { return over.flushError ?? null },
  } as unknown as LivePersister & { flush: ReturnType<typeof vi.fn> }
  const ask = (over.ask ?? vi.fn(async () => 'cancelled')) as Ask & ReturnType<typeof vi.fn>
  const teardown = vi.fn(() => { order.push('teardown') })
  const deps: CloseDocumentDeps = {
    store, persister, snapshot, session: { handle: {} as unknown as FileSystemFileHandle, name: 'f.tmv', lastModified: 1 },
    getPassword: () => null,
    flushEditors: () => { order.push('editors') },
    ask, teardown, isConflictOpen: () => over.conflictOpen ?? false,
  }
  return { store, deps, order, snapshot, persister, ask, teardown }
}

beforeEach(() => { fsMocks.downloadFallback.mockReset(); modal.toast.mockReset() })

describe('closeDocument', () => {
  test('flushes the editors and the browser copy, writes the file, then tears down — in that order', async () => {
    const r = rig()
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(r.order).toEqual(['editors', 'persister', 'write:close', 'persister', 'teardown'])
    expect(r.ask).not.toHaveBeenCalled()
  })

  test('a lost permission asks, offering re-grant; once it is re-granted the write is retried and the document closes', async () => {
    const ask: Ask = vi.fn(async (o) => { await o.onRegrant(); return 'resolved' as const })
    const r = rig({ writes: [{ ok: false, reason: 'permission' }, { ok: true }], ask })
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ reason: 'permission', canRegrant: true }))
    expect(r.snapshot.resolveGrants).toHaveBeenCalledTimes(1)
    expect(r.snapshot.writeNow).toHaveBeenCalledTimes(2)
    expect(r.teardown).toHaveBeenCalledTimes(1)
  })

  test('if the problem is still there after the user said it was fixed, it asks again', async () => {
    const ask = vi.fn(async () => 'resolved') as unknown as Ask
    const r = rig({ writes: [{ ok: false, reason: 'error' }, { ok: false, reason: 'error' }, { ok: true }], ask })
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  test('the dialog can download a copy that decodes back to the same document', async () => {
    const ask: Ask = vi.fn(async (o) => { o.onDownload(); return 'cancelled' as const })
    const r = rig({ writes: [{ ok: false, reason: 'error' }], ask })
    await closeDocument(r.deps)
    await vi.waitFor(() => expect(fsMocks.downloadFallback).toHaveBeenCalledTimes(1))
    const [name, bytes] = fsMocks.downloadFallback.mock.calls[0]!
    expect(name).toBe('f.tmv')
    const copy = parsePlainWithVersion(bytes as Uint8Array)!
    expect(copy.doc.docId).toBe(r.store.doc.docId)
    expect(copy.doc.nav.split).toBe(true)
  })

  test('the dialog retry runs a fresh close write and reports whether it worked', async () => {
    const ask: Ask = vi.fn(async (o) => ((await o.onRetry()) ? 'resolved' as const : 'cancelled' as const))
    const r = rig({ writes: [{ ok: false, reason: 'error' }, { ok: true }], ask })
    expect(await closeDocument(r.deps)).toBe('closed')
  })

  test('"close anyway" tears down, leaves the file behind, and still hands the browser copy every edit', async () => {
    const ask = vi.fn(async () => 'closed-anyway' as const) as unknown as Ask
    const r = rig({ writes: [{ ok: false, reason: 'error' }], ask })
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(r.store.dirty).toBe(true)
    expect(r.order.at(-2)).toBe('persister')
    expect(r.order.at(-1)).toBe('teardown')
  })

  test('cancel keeps the document open and tears nothing down', async () => {
    const r = rig({ writes: [{ ok: false, reason: 'permission' }] })
    expect(await closeDocument(r.deps)).toBe('kept-open')
    expect(r.teardown).not.toHaveBeenCalled()
  })

  test('an external change is the conflict modal\'s business: no second dialog, the document stays open', async () => {
    const r = rig({ writes: [{ ok: false, reason: 'conflict' }] })
    expect(await closeDocument(r.deps)).toBe('kept-open')
    expect(r.ask).not.toHaveBeenCalled()
    expect(r.teardown).not.toHaveBeenCalled()
  })

  test('a read-only tab closes without a dialog', async () => {
    const r = rig({ writes: [{ ok: false, reason: 'readonly' }], readOnly: true })
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(r.ask).not.toHaveBeenCalled()
  })

  test('a session with no file handle has nothing to write and closes', async () => {
    const r = rig({ writes: [{ ok: false, reason: 'nohandle' }] })
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(r.ask).not.toHaveBeenCalled()
  })

  test('a failed browser flush with a good file write still closes, but says so', async () => {
    const r = rig({ flushError: new Error('quota') })
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(modal.toast).toHaveBeenCalledTimes(1)
  })

  test('without browser storage the file write is all there is', async () => {
    const r = rig()
    r.deps.persister = null
    expect(await closeDocument(r.deps)).toBe('closed')
    expect(r.order).toEqual(['editors', 'write:close', 'teardown'])
  })
})

describe('the window-close handler', () => {
  function handler(overdue: boolean) {
    const flushEditors = vi.fn()
    const flush = vi.fn(async () => {})
    const h = createBeforeUnloadHandler({ flushEditors, persister: { flush } as unknown as LivePersister, snapshot: { isOverdue: () => overdue } })
    const ev = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    h(ev)
    return { ev, flushEditors, flush }
  }

  test('does not prompt when the file is not overdue, but still gets the editors and the browser copy flushed', () => {
    const { ev, flushEditors, flush } = handler(false)
    expect(ev.defaultPrevented).toBe(false)
    expect(flushEditors).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('prompts only when the file is overdue', () => {
    const { ev, flushEditors, flush } = handler(true)
    expect(ev.defaultPrevented).toBe(true)
    expect(flushEditors).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('works without browser storage', () => {
    const h = createBeforeUnloadHandler({ flushEditors: vi.fn(), persister: null, snapshot: { isOverdue: () => false } })
    expect(() => h(new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent)).not.toThrow()
  })
})
