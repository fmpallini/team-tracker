// src/core/file-identity.ts — a stable per-file key for the cross-tab write
// lock (core/tab-lock.ts).
//
// The lock used to be named after the file's *name*, so two different files
// that happen to share one ("team.tmv" in two folders) contended for the same
// lock: whichever opened second went read-only for no reason. A
// FileSystemFileHandle exposes no stable id, but it does expose
// `isSameEntry()`, and handles survive IndexedDB round trips — so a small
// registry of { id, handle } pairs, shared by every tab of this origin, maps
// "this file" to one random id no matter which handle object a tab holds.
import type { FileSession } from './fs'
import { idbGet, idbSet } from './idb'
import { stall, StallError } from './stall'

const REGISTRY_KEY = 'fileLockRegistry'
/** Web Lock serializing registry updates, so two tabs opening the same new file at once can't each mint their own id. */
const REGISTRY_LOCK = 'tmv-file-lock-registry'
/** Files remembered; the least recently opened beyond this are dropped (a dropped file just gets a fresh id next time). */
export const LOCK_REGISTRY_CAP = 50

/** Stored most-recently-used first. */
interface RegistryEntry {
  id: string
  handle: FileSystemFileHandle
}

function nameKey(session: FileSession): string {
  return 'tmv:' + session.name
}

/**
 * `isSameEntry` answers in milliseconds, but a stored handle can stop answering for good: one restored from IndexedDB on
 * an installed PWA never settled, not even against itself, so every open waited out the registry deadline behind it.
 */
export const SAME_ENTRY_MS = 2_000
const NO_ANSWER = Symbol('no answer')

/** True/false as `isSameEntry` says (a throw counts as "not the same"); NO_ANSWER when it has not settled in time. */
async function sameEntry(a: FileSystemFileHandle, b: FileSystemFileHandle): Promise<boolean | typeof NO_ANSWER> {
  try {
    return await stall(a.isSameEntry(b), 'isSameEntry', { ms: SAME_ENTRY_MS })
  } catch (e) {
    return e instanceof StallError ? NO_ANSWER : false
  }
}

/** Null when nothing can be decided: the opened handle cannot even answer for itself, so the registry is left alone. */
async function lookupOrAssign(handle: FileSystemFileHandle): Promise<string | null> {
  const entries = (await idbGet<RegistryEntry[]>(REGISTRY_KEY)) ?? []
  // All at once, each with its own deadline, so this holds the registry lock at most SAME_ENTRY_MS (plus the reads):
  // one by one, a single dead entry held it forever. The handle compared with itself is the control — when it answers,
  // the browser is answering, and an entry that does not is dead.
  const [self, ...answers] = await Promise.all([sameEntry(handle, handle), ...entries.map((e) => sameEntry(handle, e.handle))])
  // Without that control every entry may merely be slow, this file among them: minting would give it a second id.
  if (self === NO_ANSWER) return null
  const entry = entries.find((_, i) => answers[i] === true)
  // A dead entry is dropped like one past the cap: its file just gets a fresh id the next time it opens.
  const dead = entries.filter((_, i) => answers[i] === NO_ANSWER)
  if (dead.length > 0) console.warn(`file id registry: dropped ${dead.length} file handle(s) that never answered`)
  // Most recently used first, by position rather than by timestamp — ties
  // within one millisecond would otherwise evict the entry just added.
  const rest = entries.filter((e, i) => e !== entry && answers[i] !== NO_ANSWER)
  const kept = entry ?? { id: crypto.randomUUID(), handle }
  await idbSet(REGISTRY_KEY, [kept, ...rest].slice(0, LOCK_REGISTRY_CAP))
  return kept.id
}

/**
 * The id of `session`'s file: the same for every handle to that file, in
 * every tab. Null when there is none to give — no handle (fallback mode) or
 * an unreadable registry, or a handle that cannot be compared at all. Besides the write lock below, the browser copy
 * records it (core/live-open.ts), to tell an OS copy of a file from the file.
 */
export async function resolveFileId(session: FileSession, locks?: LockManager): Promise<string | null> {
  const handle = session.handle
  if (!handle) return null
  try {
    // The registry lock is exclusive and origin-wide: an open stuck inside it (core/stall.ts) used to queue every later
    // open behind it forever. Past the deadline this open goes on with no id, like any other registry failure; the
    // queued request, if it is ever granted, only refreshes this file's entry. Inside the lock nothing waits longer
    // than its own deadline (lookupOrAssign, idb.ts), so the lock is always given back.
    return await stall(
      locks ? (locks.request(REGISTRY_LOCK, () => lookupOrAssign(handle)) as Promise<string | null>) : lookupOrAssign(handle),
      'file id registry'
    )
  } catch (e) {
    console.error(e)
    return null
  }
}

/**
 * The lock / BroadcastChannel name for `session`'s file, from the id resolveFileId gave it. Falls back to the file name
 * when there is none (fallback mode, an unreadable registry) — no worse than before, and never a reason to fail
 * opening a file. Takes the id the open already resolved rather than asking the registry again: a second trip doubled
 * the wait when browser storage stalls, and left the opened tab silently read-only for it (core/tab-lock.ts).
 */
export function fileLockKey(session: FileSession, fileId: string | null): string {
  return fileId === null ? nameKey(session) : 'tmv:' + fileId
}
