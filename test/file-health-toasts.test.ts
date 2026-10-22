import { watchFileHealth, watchStoreHealth, SAVE_PERMISSION_TOAST_KEY, SAVE_ERROR_TOAST_KEY, STORE_ERROR_TOAST_KEY } from '../src/ui/file-health-toasts'
import type { FileHealth, FileSnapshot } from '../src/core/file-snapshot'
import { t } from '../src/core/i18n'

const modal = vi.hoisted(() => ({ toast: vi.fn(), dismissToast: vi.fn() }))
vi.mock('../src/ui/modal', () => modal)

function fakeSnapshot() {
  let listener: ((h: FileHealth) => void) | null = null
  const resolveGrants = vi.fn(async () => true)
  const snap = {
    subscribe: (fn: (h: FileHealth) => void) => { listener = fn; fn({ kind: 'ok', lastWrittenAt: null }); return () => { listener = null } },
    resolveGrants,
  } as unknown as FileSnapshot
  return { snap, emit: (h: FileHealth) => listener?.(h), resolveGrants, subscribed: () => listener !== null }
}

beforeEach(() => { modal.toast.mockReset(); modal.dismissToast.mockReset() })

test('a lapsed permission raises one sticky toast whose action re-grants it', () => {
  const f = fakeSnapshot()
  watchFileHealth(f.snap, () => 'en-US')
  f.emit({ kind: 'permission' })
  f.emit({ kind: 'permission' })
  expect(modal.toast).toHaveBeenCalledTimes(1)
  const [msg, opts] = modal.toast.mock.calls[0]!
  expect(msg).toBe(t('en-US', 'save_permission_toast'))
  expect(opts).toMatchObject({ sticky: true, key: SAVE_PERMISSION_TOAST_KEY })
  opts.action.onClick()
  expect(f.resolveGrants).toHaveBeenCalledTimes(1)
  expect(opts.action.label).toBe(t('en-US', 'grant_access_ellipsis'))
})

test('a write error raises a sticky error toast, replacing a previous one rather than stacking', () => {
  const f = fakeSnapshot()
  watchFileHealth(f.snap, () => 'en-US')
  f.emit({ kind: 'error', message: 'disk full' })
  expect(modal.toast).toHaveBeenCalledWith(t('en-US', 'save_error_toast'), { sticky: true, key: SAVE_ERROR_TOAST_KEY })
})

test('an external change is the conflict modal\'s business: no toast', () => {
  const f = fakeSnapshot()
  watchFileHealth(f.snap, () => 'en-US')
  f.emit({ kind: 'error', message: 'conflict' })
  expect(modal.toast).not.toHaveBeenCalled()
})

test('a later successful write dismisses both notices, and a new lapse can toast again', () => {
  const f = fakeSnapshot()
  watchFileHealth(f.snap, () => 'pt-BR')
  f.emit({ kind: 'permission' })
  f.emit({ kind: 'writing' })
  expect(modal.dismissToast).not.toHaveBeenCalled() // still unresolved while a retry runs
  f.emit({ kind: 'ok', lastWrittenAt: 5 })
  expect(modal.dismissToast).toHaveBeenCalledWith(SAVE_PERMISSION_TOAST_KEY)
  expect(modal.dismissToast).toHaveBeenCalledWith(SAVE_ERROR_TOAST_KEY)
  f.emit({ kind: 'permission' })
  expect(modal.toast).toHaveBeenCalledTimes(2)
})

test('the export health never toasts, and unsubscribing stops everything', () => {
  const f = fakeSnapshot()
  const stop = watchFileHealth(f.snap, () => 'en-US')
  f.emit({ kind: 'export', lastExportedAt: 1 })
  expect(modal.toast).not.toHaveBeenCalled()
  stop()
  expect(f.subscribed()).toBe(false)
})

describe('watchStoreHealth', () => {
  function fakePersister(initial: unknown = null) {
    let listener: ((failed: boolean) => void) | null = null
    const persister = {
      get lastError() { return initial },
      onErrorChange: (fn: (failed: boolean) => void) => { listener = fn; return () => { listener = null } },
    } as unknown as import('../src/core/live-persist').LivePersister
    return { persister, emit: (failed: boolean) => listener?.(failed), subscribed: () => listener !== null }
  }

  test('a failing browser store raises one sticky toast (it says the edits are only in memory); recovery clears it', () => {
    const f = fakePersister()
    watchStoreHealth(f.persister, () => 'en-US')
    f.emit(true)
    expect(modal.toast).toHaveBeenCalledTimes(1)
    expect(modal.toast).toHaveBeenCalledWith(t('en-US', 'live_store_failed_toast'), { sticky: true, key: STORE_ERROR_TOAST_KEY })
    f.emit(false)
    expect(modal.dismissToast).toHaveBeenCalledWith(STORE_ERROR_TOAST_KEY)
  })

  test('a store that is already failing when watched is announced at once; the unsubscribe stops the watching', () => {
    const f = fakePersister(new Error('quota'))
    const off = watchStoreHealth(f.persister, () => 'pt-BR')
    expect(modal.toast).toHaveBeenCalledWith(t('pt-BR', 'live_store_failed_toast'), { sticky: true, key: STORE_ERROR_TOAST_KEY })
    off()
    expect(f.subscribed()).toBe(false)
  })
})
