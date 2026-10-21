// src/core/file-snapshot.ts — the `.tmv` file as a periodic snapshot of the
// document, not its live store. The browser copy (live-persist.ts) takes every
// edit; this module writes the whole file only at three moments — when a
// document is opened from a browser copy that is ahead of it, when the document
// is closed (Lock/Close), and on a 1–24 hour timer — plus an explicit export in
// browsers that cannot write a file silently. There is no "save now" and no
// write on blur or tab-hide.
//
// It owns what the user needs to know about those writes: `health()` (the save
// pill reads it; this module holds no text), single-writer ordering with the
// password change (`runExclusive`), and the failure paths (lapsed permission,
// external change, any other error). A failed write never touches the browser
// copy and never clears `store.dirty`, so the next moment tries again.
import type { Store } from './store'
import type { Prefs } from './types'
import type { LivePersister } from './live-persist'
import { writeFile, downloadFallback, ExternalChangeError, type FileSession } from './fs'
import { buildSnapshot, commitSnapshot, type Snapshot } from './snapshot'

export type WriteReason = 'open' | 'close' | 'timer' | 'export'

export type FileHealth =
  | { kind: 'ok'; lastWrittenAt: number | null }
  | { kind: 'writing' }
  | { kind: 'permission' }
  | { kind: 'error'; message?: string }
  /** Only without a file handle: the file can be exported, never written silently. */
  | { kind: 'export'; lastExportedAt: number | null }

export type WriteResult =
  | { ok: true }
  | { ok: false; reason: 'permission' | 'conflict' | 'error' | 'readonly' | 'nohandle' }

export interface FileSnapshot {
  /**
   * Writes the file now. Does nothing (and succeeds) for a clean document when the reason is the timer or close;
   * 'open' and 'export' always write. A call that finds a write in flight joins it — except that anything but the
   * timer then writes again if edits landed meanwhile, so a Lock/Close always leaves the file current.
   */
  writeNow(reason: WriteReason): Promise<WriteResult>
  /** (Re)arms the timer from the last successful write (or from open). Without a file handle there is no timer. */
  scheduleFrom(prefs: Prefs): void
  health(): FileHealth
  /**
   * The conflict modal was resolved: `wrote` (Overwrite put the document in the file, so that counts as the last write)
   * or `reloaded` (the file's content was taken instead). Either way a failure that was about the conflict is over.
   */
  conflictResolved(how: 'wrote' | 'reloaded'): void
  /** Fires at once with the current health, then on every change. */
  subscribe(fn: (h: FileHealth) => void): () => void
  /** Re-requests write permission on the handle (needs a user gesture); on success writes what was waiting. Resolves whether the grant is held. */
  resolveGrants(): Promise<boolean>
  /** Runs `fn` alone: after any write in flight, and with writes requested meanwhile held until it settles. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  /** Resolves once nothing is in flight. */
  flush(): Promise<void>
  /** A dirty document whose last write (or open, or export) is a full interval old: the window-close warning's trigger. */
  isOverdue(): boolean
  dispose(): void
}

export interface FileSnapshotDeps {
  store: Store
  session: FileSession
  getPassword(): string | null
  /** Null when the browser could not open its storage: files are still written. */
  persister?: LivePersister | null
  /** Opens the conflict modal (ui/conflict.ts). */
  onExternalChange(): void
  /** Whether that modal is up: no write is attempted meanwhile, and none opens a second modal. */
  isConflictOpen?(): boolean
  /** Commits debounced editor input into the store; the first thing a write does. */
  flushPending?(): void
  now?(): number
  /** Timers, injectable for tests. Returns the canceller. */
  schedule?(fn: () => void, ms: number): () => void
}

const MIN_INTERVAL_MIN = 60
const MAX_INTERVAL_MIN = 1440

export function createFileSnapshot(deps: FileSnapshotDeps): FileSnapshot {
  const { store, session } = deps
  const now = (): number => (deps.now ? deps.now() : Date.now())
  const schedule = (fn: () => void, ms: number): (() => void) => {
    if (deps.schedule) return deps.schedule(fn, ms)
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  }

  const openedAt = now()
  let lastWrittenAt: number | null = null
  let lastExportedAt: number | null = openedAt // opening the file is as good as an export: the user holds that content
  let lastAttemptAt: number | null = null
  let status: 'idle' | 'writing' | 'permission' | 'error' = 'idle'
  let errorMessage: string | undefined
  let autoSaveMin = store.doc.prefs.autoSaveMin
  let timerCancel: (() => void) | null = null
  /** The timer's own write and the re-arm after it; `flush` waits for it too. */
  let timerRun: Promise<void> = Promise.resolve()
  let disposed = false
  const subscribers = new Set<(h: FileHealth) => void>()

  // One chain orders every write and every exclusive section, so none ever interleaves with another.
  let tail: Promise<unknown> = Promise.resolve()
  let inflight: Promise<WriteResult> | null = null
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  const intervalMs = (): number => Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, autoSaveMin)) * 60_000

  function health(): FileHealth {
    if (!session.handle) return { kind: 'export', lastExportedAt }
    if (status === 'writing') return { kind: 'writing' }
    if (status === 'permission') return { kind: 'permission' }
    if (status === 'error') return { kind: 'error', message: errorMessage }
    return { kind: 'ok', lastWrittenAt }
  }

  function setStatus(next: typeof status, message?: string): void {
    status = next
    errorMessage = message
    emit()
  }

  function emit(): void {
    const h = health()
    for (const fn of [...subscribers]) { try { fn(h) } catch (e) { console.error(e) } }
  }

  async function attempt(reason: WriteReason): Promise<WriteResult> {
    if (store.readOnly) return { ok: false, reason: 'readonly' }
    if (deps.isConflictOpen?.()) return { ok: false, reason: 'conflict' }
    if (!session.handle && reason !== 'export') return { ok: false, reason: 'nohandle' }
    if (!store.dirty && reason !== 'open' && reason !== 'export') return { ok: true }

    setStatus('writing')
    try { deps.flushPending?.() } catch (e) { console.error(e) }
    try { await deps.persister?.flush() } catch (e) { console.error(e) }

    let snapshot: Snapshot
    try {
      snapshot = await buildSnapshot(store, deps.getPassword())
    } catch (e) {
      console.error(e)
      setStatus('error', e instanceof Error ? e.message : undefined)
      return { ok: false, reason: 'error' }
    }
    try {
      if (session.handle) await writeFile(session, snapshot.bytes)
      else downloadFallback(session.name, snapshot.bytes)
    } catch (e) {
      if (e instanceof ExternalChangeError) {
        // The in-memory document is never discarded: it stays dirty and the conflict modal decides.
        setStatus('error', 'conflict')
        if (!deps.isConflictOpen?.()) deps.onExternalChange()
        return { ok: false, reason: 'conflict' }
      }
      console.error(e)
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        setStatus('permission')
        return { ok: false, reason: 'permission' }
      }
      setStatus('error', e instanceof Error ? e.message : undefined)
      return { ok: false, reason: 'error' }
    }

    // The file is written: nothing past this point may report a failed write.
    await commitSnapshot(deps.persister ?? null, snapshot.stamp, snapshot.revAtSnapshot)
    // An edit that landed during the write is not in the bytes, so only a matching revision may clear `dirty`.
    if (store.rev === snapshot.revAtSnapshot) store.markSaved()
    if (session.handle) lastWrittenAt = now()
    else lastExportedAt = now()
    setStatus('idle')
    return { ok: true }
  }

  function start(reason: WriteReason): Promise<WriteResult> {
    const p: Promise<WriteResult> = enqueue(() => attempt(reason)).finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
  }

  async function writeNow(reason: WriteReason): Promise<WriteResult> {
    for (;;) {
      if (!inflight) return start(reason)
      const result = await inflight
      if (reason === 'timer' || !result.ok || !store.dirty || store.readOnly) return result
      // An edit landed while that write ran, and for anything but the timer the file must hold it: write again.
    }
  }

  function arm(): void {
    timerCancel?.()
    timerCancel = null
    if (!session.handle || disposed) return
    // From the last successful write — or, after a failed attempt, from that attempt, so a failure retries
    // a full interval later instead of in a tight loop.
    const base = Math.max(lastWrittenAt ?? openedAt, lastAttemptAt ?? 0)
    const delay = Math.max(0, base + intervalMs() - now())
    timerCancel = schedule(() => {
      timerCancel = null
      timerRun = writeNow('timer').then(() => undefined).finally(() => {
        lastAttemptAt = now()
        arm()
      })
    }, delay)
  }

  async function resolveGrants(): Promise<boolean> {
    const handle = session.handle
    if (!handle) return false
    try {
      // Re-prompting a downgraded grant needs the user activation of the click that got us here.
      let permission = await handle.queryPermission({ mode: 'readwrite' })
      if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'readwrite' })
      if (permission !== 'granted') return false
    } catch (e) {
      console.error(e)
      return false
    }
    if (status === 'permission') setStatus('idle')
    await writeNow('timer')
    return true
  }

  return {
    writeNow,
    scheduleFrom(prefs) {
      autoSaveMin = prefs.autoSaveMin
      arm()
    },
    health,
    conflictResolved(how) {
      if (how === 'wrote') lastWrittenAt = now()
      if (status === 'error' && errorMessage === 'conflict') setStatus('idle')
      else if (how === 'wrote') emit()
    },
    subscribe(fn) {
      subscribers.add(fn)
      fn(health())
      return () => { subscribers.delete(fn) }
    },
    resolveGrants,
    runExclusive: (fn) => enqueue(fn),
    async flush() {
      let seen: Promise<unknown>
      do {
        seen = tail
        await seen
        await timerRun
      } while (seen !== tail)
    },
    isOverdue() {
      if (!store.dirty) return false
      const since = session.handle ? (lastWrittenAt ?? openedAt) : (lastExportedAt ?? openedAt)
      return now() - since >= intervalMs()
    },
    dispose() {
      disposed = true
      timerCancel?.()
      timerCancel = null
      subscribers.clear()
    },
  }
}
