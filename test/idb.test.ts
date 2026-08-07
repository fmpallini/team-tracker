// jsdom has no IndexedDB implementation (verified: `typeof window.indexedDB
// === 'undefined'`), so every other test file that touches core/idb.ts mocks
// it out entirely (`vi.mock('../src/core/idb', ...)`). That leaves idb.ts's
// own logic — connection caching, the "failed open doesn't poison future
// calls" retry behavior, the actual get/set/del wrappers — completely
// unexercised. fake-indexeddb (dev-only) closes that gap.
import 'fake-indexeddb/auto'

// Each test dynamically re-imports the module after `vi.resetModules()` so
// its module-scoped `dbPromise` cache starts fresh — otherwise the first
// test to run would permanently decide whether later tests see a cached
// connection or a fresh `indexedDB.open()` call.
async function freshIdb() {
  vi.resetModules()
  return import('../src/core/idb')
}

test('set then get round-trips the value', async () => {
  const { idbSet, idbGet } = await freshIdb()
  await idbSet('k1', { hello: 'world' })
  await expect(idbGet('k1')).resolves.toEqual({ hello: 'world' })
})

test('get on a missing key resolves undefined, not an error', async () => {
  const { idbGet } = await freshIdb()
  await expect(idbGet('does-not-exist')).resolves.toBeUndefined()
})

test('set overwrites an existing value for the same key', async () => {
  const { idbSet, idbGet } = await freshIdb()
  await idbSet('k2', 'first')
  await idbSet('k2', 'second')
  await expect(idbGet('k2')).resolves.toBe('second')
})

test('del removes the key', async () => {
  const { idbSet, idbGet, idbDel } = await freshIdb()
  await idbSet('k3', 'value')
  await idbDel('k3')
  await expect(idbGet('k3')).resolves.toBeUndefined()
})

test('stores non-string values (e.g. a FileSystemFileHandle-shaped object) intact', async () => {
  const { idbSet, idbGet } = await freshIdb()
  const handle = { kind: 'file', name: 'team.tmv' }
  await idbSet('k4', handle)
  await expect(idbGet('k4')).resolves.toEqual(handle)
})

test('reuses a single cached connection across multiple calls instead of reopening every time', async () => {
  const { idbSet, idbGet, idbDel } = await freshIdb()
  const openSpy = vi.spyOn(indexedDB, 'open')
  await idbSet('k5', 'a')
  await idbGet('k5')
  await idbDel('k5')
  expect(openSpy).toHaveBeenCalledTimes(1)
  openSpy.mockRestore()
})

// Matches the source comment: "a failed open must not poison future calls
// with a rejected cache entry" — openDb() resets its cached promise to null
// on error specifically so the next call gets a fresh attempt instead of
// replaying the same rejection forever.
test('a failed open does not poison the cache — the next call gets a fresh, working attempt', async () => {
  const { idbGet } = await freshIdb()
  const openSpy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
    const req = {} as IDBOpenDBRequest
    queueMicrotask(() => {
      Object.defineProperty(req, 'error', { value: new Error('boom'), configurable: true })
      req.onerror?.(new Event('error'))
    })
    return req
  })

  await expect(idbGet('k6')).rejects.toThrow('boom')
  openSpy.mockRestore()

  // Real indexedDB.open() again — no lingering rejected promise.
  await expect(idbGet('k6')).resolves.toBeUndefined()
})
