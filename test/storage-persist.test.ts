import { describe, it, expect, vi } from 'vitest'
import { requestPersistentStorage } from '../src/core/storage-persist'

describe('requestPersistentStorage', () => {
  it('asks the browser to persist storage', () => {
    const persist = vi.fn().mockResolvedValue(true)
    requestPersistentStorage({ storage: { persist } })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('does nothing when the Storage API is unsupported (e.g. jsdom, insecure context)', () => {
    expect(() => requestPersistentStorage({})).not.toThrow()
    expect(() => requestPersistentStorage({ storage: {} })).not.toThrow()
  })

  it('logs but does not throw if the browser rejects the request', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('nope'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    requestPersistentStorage({ storage: { persist } })
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
