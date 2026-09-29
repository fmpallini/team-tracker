// src/core/storage-persist.ts — asks the browser not to evict this origin's
// storage under disk pressure. IndexedDB (core/idb.ts) holds the remembered
// file handle, the backup handle and the auto-open-last flag; if it were
// cleared, the user would silently lose "reopen last file" and the backup
// link. Chromium grants this without a prompt (automatically for an
// installed PWA). `PersistNav` (not the real Navigator type) keeps it
// testable: jsdom has no navigator.storage.
export interface PersistNav {
  storage?: { persist?(): Promise<boolean> }
}

export function requestPersistentStorage(nav: PersistNav = navigator): void {
  const storage = nav.storage
  if (!storage || typeof storage.persist !== 'function') return
  storage.persist().catch((e: unknown) => console.error(e))
}
