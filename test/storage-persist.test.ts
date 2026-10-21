import { describe, it, expect, vi } from 'vitest'
import { requestPersistentStorage, getPersistStatus, ensurePersistentStorage } from '../src/core/storage-persist'

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

describe('getPersistStatus', () => {
  it('is what the browser says about persistence', async () => {
    expect(await getPersistStatus({ storage: { persisted: vi.fn().mockResolvedValue(true) } })).toBe(true)
    expect(await getPersistStatus({ storage: { persisted: vi.fn().mockResolvedValue(false) } })).toBe(false)
  })

  it('is null when the Storage API cannot say (unsupported, or it rejects)', async () => {
    expect(await getPersistStatus({})).toBeNull()
    expect(await getPersistStatus({ storage: {} })).toBeNull()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getPersistStatus({ storage: { persisted: vi.fn().mockRejectedValue(new Error('no')) } })).toBeNull()
    spy.mockRestore()
  })
})

describe('ensurePersistentStorage (once per opened document, in every build)', () => {
  it('asks, then reports the status the browser ended up with', async () => {
    const order: string[] = []
    const nav = { storage: {
      persist: vi.fn(async () => { order.push('persist'); return true }),
      persisted: vi.fn(async () => { order.push('persisted'); return true }),
    } }
    expect(await ensurePersistentStorage(nav)).toBe(true)
    expect(order).toEqual(['persist', 'persisted'])
  })

  it('reports false when the browser declined', async () => {
    const nav = { storage: { persist: vi.fn(async () => false), persisted: vi.fn(async () => false) } }
    expect(await ensurePersistentStorage(nav)).toBe(false)
  })

  it('reports null when the API is missing, without throwing', async () => {
    expect(await ensurePersistentStorage({})).toBeNull()
  })
})
