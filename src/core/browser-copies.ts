// src/core/browser-copies.ts — the browser copies of documents other than the open one.
//
// Every document ever opened leaves a copy in the live database (live-db.ts) that nothing else removes. The copy of a
// document the user never opens again is dead weight, but not always harmless to drop:
//   - a copy with `unwrittenChanges` holds edits its file lacks, possibly the only place they exist, so it is deleted only
//     when the user says so, never by `pruneStale`;
//   - a clean copy only saves the next open a re-import (live-open.ts falls back to the file), so an old one may go.
// A copy another tab has open must not go either: that tab's persister would write rows into a document with no meta.
// Tabs tell each other by holding a shared Web Lock per open document, for as long as it is open (`holdDocument`).
import type { LiveDb } from './live-db'

export interface CopyInfo {
  docId: string
  /** The file the copy was last written for; empty when the copy has none recorded. */
  fileName: string
  modifiedAt: number
  /** The copy has edits its file does not. */
  unwritten: boolean
}

export interface BrowserCopies {
  /** The other documents' copies, most recently modified first. */
  list(): Promise<CopyInfo[]>
  /** Deletes one copy. False, and nothing deleted, when it is the open document's or another tab has it open. */
  remove(docId: string): Promise<boolean>
  /** Deletes the clean copies untouched for `STALE_COPY_MS` that no tab has open; returns how many. Never throws a copy's failure past the others. */
  pruneStale(now: number): Promise<number>
}

export const STALE_COPY_MS = 90 * 24 * 60 * 60 * 1000

const lockName = (docId: string): string => `tmv-doc:${docId}`

/** Holds a shared lock on `docId` until the returned function is called; a no-op where Web Locks do not exist. */
export function holdDocument(docId: string, locks: LockManager | undefined): () => void {
  if (!locks) return () => {}
  let release: () => void = () => {}
  void locks.request(lockName(docId), { mode: 'shared' }, () => new Promise<void>((resolve) => { release = resolve })).catch(() => {})
  return () => release()
}

export function createBrowserCopies(db: LiveDb, openDocId: string, locks: LockManager | undefined): BrowserCopies {
  async function heldElsewhere(docId: string): Promise<boolean> {
    if (!locks) return false
    const { held } = await locks.query()
    return !!held?.some((l) => l.name === lockName(docId))
  }

  async function remove(docId: string): Promise<boolean> {
    if (docId === openDocId || (await heldElsewhere(docId))) return false
    await db.deleteDoc(docId)
    return true
  }

  return {
    async list() {
      const metas = await db.listMeta()
      return metas
        .filter((m) => m.docId !== openDocId)
        .map((m): CopyInfo => ({ docId: m.docId, fileName: m.fileName, modifiedAt: m.modifiedAt, unwritten: m.unwrittenChanges }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
    },
    remove,
    async pruneStale(now) {
      // Without Web Locks another tab's open document cannot be told apart, so nothing is removed unasked.
      if (!locks) return 0
      let removed = 0
      for (const c of await this.list()) {
        if (c.unwritten || now - c.modifiedAt < STALE_COPY_MS) continue
        try {
          if (await remove(c.docId)) removed++
        } catch (e) {
          console.error(e)
        }
      }
      return removed
    },
  }
}
