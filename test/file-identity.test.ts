import { resolveFileLockKey, LOCK_REGISTRY_CAP } from '../src/core/file-identity'
import type { FileSession } from '../src/core/fs'

// In-memory stand-in for the IndexedDB wrapper, with a real await per call so
// unserialized concurrent resolves genuinely interleave.
const idbMocks = vi.hoisted(() => {
  const data = new Map<string, unknown>()
  return {
    data,
    idbGet: vi.fn(async (key: string) => { await Promise.resolve(); return data.get(key) }),
    idbSet: vi.fn(async (key: string, value: unknown) => { await Promise.resolve(); data.set(key, value) }),
    idbDel: vi.fn(async (key: string) => { data.delete(key) }),
  }
})
vi.mock('../src/core/idb', () => idbMocks)

/** A handle to on-disk entry `entry` — two handles with the same `entry` are the same file, as `isSameEntry` reports. */
function handle(entry: string, name = 'team.tmv'): FileSystemFileHandle {
  const h = {
    entry,
    name,
    isSameEntry: async (other: { entry?: string }) => other.entry === entry,
  }
  return h as unknown as FileSystemFileHandle
}

function session(h: FileSystemFileHandle | null, name = 'team.tmv'): FileSession {
  return { handle: h, name, lastModified: 1 }
}

/** Name-keyed exclusive lock, enough to serialize the registry update. */
function serializingLocks(): LockManager {
  const tails = new Map<string, Promise<unknown>>()
  return {
    request: (name: string, cb: () => Promise<unknown>) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => cb())
      tails.set(name, run.catch(() => {}))
      return run
    },
  } as unknown as LockManager
}

beforeEach(() => {
  idbMocks.data.clear()
})

test('the same file keeps the same key, even through a different handle object', async () => {
  const a = await resolveFileLockKey(session(handle('disk-1')))
  const b = await resolveFileLockKey(session(handle('disk-1')))
  expect(a).toBe(b)
})

test('two different files sharing a name get different keys', async () => {
  // e.g. "team.tmv" in two different folders — keyed by name alone, the
  // second one opened went read-only for no reason.
  const a = await resolveFileLockKey(session(handle('folder-a/team.tmv')))
  const b = await resolveFileLockKey(session(handle('folder-b/team.tmv')))
  expect(a).not.toBe(b)
})

test('fallback mode (no handle) keys by name', async () => {
  expect(await resolveFileLockKey(session(null, 'x.tmv'))).toBe('tmv:x.tmv')
})

test('concurrent resolves of a new file mint a single key when serialized by a Web Lock', async () => {
  const locks = serializingLocks()
  const [a, b] = await Promise.all([
    resolveFileLockKey(session(handle('fresh')), locks),
    resolveFileLockKey(session(handle('fresh')), locks),
  ])
  expect(a).toBe(b)
})

test('the registry keeps only the most recently used files', async () => {
  const first = await resolveFileLockKey(session(handle('oldest')))
  for (let i = 0; i < LOCK_REGISTRY_CAP; i++) await resolveFileLockKey(session(handle(`f${i}`)))
  const entries = idbMocks.data.get('fileLockRegistry') as unknown[]
  expect(entries).toHaveLength(LOCK_REGISTRY_CAP)
  // The evicted file simply gets a fresh key next time.
  expect(await resolveFileLockKey(session(handle('oldest')))).not.toBe(first)
})

test('an IndexedDB failure falls back to the name key instead of throwing', async () => {
  idbMocks.idbGet.mockRejectedValueOnce(new Error('idb unavailable'))
  expect(await resolveFileLockKey(session(handle('x'), 'y.tmv'))).toBe('tmv:y.tmv')
})
