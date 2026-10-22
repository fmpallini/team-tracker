// src/core/storage-persist.ts — asks the browser not to evict this origin's
// storage under disk pressure, and reports whether it agreed. The browser holds the
// live copy of every open document in IndexedDB (core/live-db.ts) and the remembered
// file handle and auto-open-last flag (core/idb.ts); if it were cleared, work not yet
// written to the file would be lost. Chromium grants this without a prompt (automatically
// for an installed PWA). `PersistNav` (not the real Navigator type) keeps it testable:
// jsdom has no navigator.storage.
export interface PersistNav {
  storage?: { persist?(): Promise<boolean>; persisted?(): Promise<boolean> }
}

export function requestPersistentStorage(nav: PersistNav = navigator): void {
  const storage = nav.storage
  if (!storage || typeof storage.persist !== 'function') return
  storage.persist().catch((e: unknown) => console.error(e))
}

/** Whether the browser has promised to keep this origin's storage; null when it cannot say. */
export async function getPersistStatus(nav: PersistNav = navigator): Promise<boolean | null> {
  const storage = nav.storage
  if (!storage || typeof storage.persisted !== 'function') return null
  try {
    return await storage.persisted()
  } catch (e) {
    console.error(e)
    return null
  }
}

/** The request, then the status the browser ended up with. Called once per opened document, in every build. */
export async function ensurePersistentStorage(nav: PersistNav = navigator): Promise<boolean | null> {
  const storage = nav.storage
  if (storage && typeof storage.persist === 'function') {
    try { await storage.persist() } catch (e) { console.error(e) }
  }
  return getPersistStatus(nav)
}
