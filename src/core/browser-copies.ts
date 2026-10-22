// src/core/browser-copies.ts — housekeeping for the browser copies of documents other than the open one.
//
// Every document ever opened leaves a copy in the live database (live-db.ts) that nothing else removes. The copy of a
// document the user never opens again is dead weight, but not always harmless to drop:
//   - a copy with `unwrittenChanges` holds edits its file lacks, possibly the only place they exist, so it is never removed;
//   - a clean copy only saves the next open a re-import (live-open.ts falls back to the file), so an old one may go.
// A copy another tab has open must not go either: that tab's persister would write rows into a document with no meta.
// Tabs tell each other by holding a shared Web Lock per open document, for as long as it is open (`holdDocument`).
import type { LiveDb } from './live-db'

export const STALE_COPY_MS = 90 * 24 * 60 * 60 * 1000

const lockName = (docId: string): string => `tmv-doc:${docId}`

/** Holds a shared lock on `docId` until the returned function is called; a no-op where Web Locks do not exist. */
export function holdDocument(docId: string, locks: LockManager | undefined): () => void {
  if (!locks) return () => {}
  let release: () => void = () => {}
  void locks.request(lockName(docId), { mode: 'shared' }, () => new Promise<void>((resolve) => { release = resolve })).catch(() => {})
  return () => release()
}

/**
 * Deletes the clean copies of other documents untouched for `STALE_COPY_MS` that no tab has open; returns how many.
 * A copy's failure is logged and never stops the others. Without Web Locks another tab's open document cannot be told
 * apart, so nothing is removed.
 */
export async function pruneStaleCopies(db: LiveDb, openDocId: string, locks: LockManager | undefined, now: number): Promise<number> {
  if (!locks) return 0
  let removed = 0
  for (const m of await db.listMeta()) {
    if (m.docId === openDocId || m.unwrittenChanges || now - m.modifiedAt < STALE_COPY_MS) continue
    try {
      const { held } = await locks.query()
      if (held?.some((l) => l.name === lockName(m.docId))) continue
      await db.deleteDoc(m.docId)
      removed++
    } catch (e) {
      console.error(e)
    }
  }
  return removed
}
