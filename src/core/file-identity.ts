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

async function sameEntry(a: FileSystemFileHandle, b: FileSystemFileHandle): Promise<boolean> {
  try {
    return await a.isSameEntry(b)
  } catch {
    return false
  }
}

async function lookupOrAssign(handle: FileSystemFileHandle): Promise<string> {
  const entries = (await idbGet<RegistryEntry[]>(REGISTRY_KEY)) ?? []
  let entry: RegistryEntry | undefined
  for (const e of entries) {
    if (await sameEntry(e.handle, handle)) {
      entry = e
      break
    }
  }
  // Most recently used first, by position rather than by timestamp — ties
  // within one millisecond would otherwise evict the entry just added.
  const rest = entries.filter((e) => e !== entry)
  entry ??= { id: crypto.randomUUID(), handle }
  await idbSet(REGISTRY_KEY, [entry, ...rest].slice(0, LOCK_REGISTRY_CAP))
  return entry.id
}

/**
 * The lock / BroadcastChannel name for `session`'s file. Falls back to the
 * file name when there is no handle (fallback mode) or the registry can't be
 * read — no worse than before, and never a reason to fail opening a file.
 */
export async function resolveFileLockKey(session: FileSession, locks?: LockManager): Promise<string> {
  const handle = session.handle
  if (!handle) return nameKey(session)
  try {
    const id = locks
      ? ((await locks.request(REGISTRY_LOCK, () => lookupOrAssign(handle))) as string)
      : await lookupOrAssign(handle)
    return 'tmv:' + id
  } catch (e) {
    console.error(e)
    return nameKey(session)
  }
}
