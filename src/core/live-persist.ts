// src/core/live-persist.ts — keeps the browser live store (live-store.ts) equal to
// the in-memory document. After every mutation, on a short debounce, it splits
// the document into records (doc-records.ts), compares each record's JSON with
// what it last wrote and commits only the differences, plus the bytes of images
// not yet stored, in one transaction.
//
// Why a full re-split on every flush instead of trusting the mutation's scope:
// an absent scope means "everything" (core/scope.ts) and a too-narrow one would
// silently lose an edit, whereas re-serializing costs little next to the commit.
//
// The cache holds JSON *strings*, never record objects: entity records alias the
// live document (doc-records.ts), so an object kept across a later edit would
// look unchanged to the diff.
//
// A cache entry changes only when a commit succeeded. A failed commit therefore
// leaves every record "dirty" and the next flush retries the same writes; the
// edit itself stays in memory the whole time.
//
// The `unwrittenChanges` meta flag means "the file at lastWriteId lacks edits the
// browser copy has". Only a file write (markFileWritten) or adopting the file as
// truth (adoptFileStamp) clears it; an ordinary flush can raise it, never lower it.
import type { Store } from './store'
import type { LiveStore } from './live-store'
import type { LiveMeta } from './live-db'
import type { FileStamp } from './file-stamp'
import { splitDoc, type DocRecords } from './doc-records'
import { collectImageRefs } from './image-ref'
import type { RecordCodec } from './crypto'

export interface LivePersister {
  /** Writes whatever differs now and resolves once that commit (and any in flight before it) has settled. Never rejects; a failure shows in `lastError`. */
  flush(): Promise<void>
  /**
   * Records that the file now holds the document as of `revAtSnapshot` (default: all of it): stores the stamp as the
   * lineage, clears `unwrittenChanges` unless the document moved on since, and sweeps blobs of images no
   * note references any more. A stamp whose commit fails is kept and applied by the next successful one.
   */
  markFileWritten(stamp: FileStamp, revAtSnapshot?: number): Promise<void>
  /** After the app adopted the file as the truth (conflict Reload, open from the file): full flush, then records the file's stamp and clears `unwrittenChanges`. */
  adoptFileStamp(stamp: FileStamp | null): Promise<void>
  /**
   * Starts the diff over from what the browser store holds now (the caller just loaded it) and re-reads the
   * lineage and `unwrittenChanges` from its meta. For a tab that lost the write lock and took it back: another tab
   * wrote meanwhile, so this cache is stale, and `replaceDoc`ing the stored content would otherwise be diffed
   * against it and rewrite identical records.
   */
  reseed(stored: { records: DocRecords; blobIds: Iterable<string> }): Promise<void>
  /**
   * A password change (or adding/removing one): re-seals every stored record and image under `codec` (null: plain) in one commit,
   * ordered with the flushes so none interleaves. Call after the image store itself was re-keyed, since the blobs written are its
   * stored forms. Rejects if the commit fails; the old codec then stays in force, consistently.
   */
  rekey(codec: RecordCodec | null): Promise<void>
  /** Calls `fn(true)` when the browser store starts failing and `fn(false)` when it recovers; not for every retry in between. Returns the unsubscribe. */
  onErrorChange(fn: (failed: boolean) => void): () => void
  /** The error of the last failed commit, or null once a later one succeeded. */
  readonly lastError: unknown
  dispose(): void
}

export interface LivePersisterDeps {
  store: Store
  live: LiveStore
  fileName: string
  onError?(e: unknown): void
  onRecovered?(): void
  /**
   * Set when the document was just read from this file (null: a file without a stamp). If the browser store holds
   * nothing yet, the initial write then records the file's lineage in the same commit, so a crash between "records
   * written" and "lineage written" can never leave a copy that looks unwritten and misfires the both-changed prompt.
   */
  fromFile?: FileStamp | null
  /**
   * With `fromFile`: the browser store already holds a copy of this document and the file wins, so the initial sync
   * replaces it wholesale (one commit, the old rows deleted in it) instead of trusting it.
   */
  replaceStored?: boolean
  /**
   * What the browser store holds for this document, when the caller just loaded it. The diff then starts from that
   * rather than from the document in memory, so records the open changed (a schema migration) are written, not assumed.
   */
  stored?: { records: DocRecords; blobIds: Iterable<string> }
  debounceMs?: number
  schedule?: (fn: () => void, ms: number) => () => void
}

const KNOWN_WRITE_IDS = 20
const RETRY_MS = 30_000

type LineageFields = Pick<LiveMeta, 'lastWriteId' | 'knownWriteIds' | 'lastFileWriteAt'>

interface FileWrite { stamp: FileStamp; revAtSnapshot?: number }

interface RunOptions {
  file?: FileWrite
  /** The file is the truth: record the lineage and clear `unwrittenChanges`, whatever the diff finds. */
  adopt?: { stamp: FileStamp | null }
  /** Delete every stored row of the document in the same commit (a wholesale replacement). */
  clear?: boolean
  /** This run is the initial sync: if it cannot happen (read-only, a failed commit) it is owed, not dropped. */
  initial?: boolean
  /** The first reconcile of a loaded copy: what the diff finds is derived data (a migration), not a user edit, so it does not raise `unwrittenChanges`. */
  quiet?: boolean
}

export async function createLivePersister(deps: LivePersisterDeps): Promise<LivePersister> {
  const { store, live } = deps
  const debounceMs = deps.debounceMs ?? 400
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t) })

  const cache = new Map<string, string>()
  const persistedBlobs = new Set<string>()
  let lineage: LineageFields = { lastWriteId: null, knownWriteIds: [], lastFileWriteAt: null }
  let unwritten = false
  let lastMeta = ''
  // A file write whose commit failed: kept (with the revision the file holds) for the next successful commit.
  let pendingStamp: FileWrite | null = null
  // Blobs the sweep deleted. They return only once a note references them again (an undo), never by themselves.
  const swept = new Set<string>()
  let lastError: unknown = null
  const errorListeners = new Set<(failed: boolean) => void>()
  const announceError = (failed: boolean): void => {
    for (const fn of [...errorListeners]) { try { fn(failed) } catch (e) { console.error(e) } }
  }
  let disposed = false
  let timer: { cancel: () => void; retry: boolean } | null = null
  let chain: Promise<void> = Promise.resolve()
  // The initial sync, while it is still owed. Only the tab holding the write lock may touch the browser copy, and a
  // tab learns that after it has opened, so a read-only tab (or one whose first commit failed) keeps it pending.
  let initialOwed: RunOptions | null = null
  let initialDone = false

  const serialize = (records: Map<string, unknown>): Map<string, string> =>
    new Map([...records].map(([path, value]) => [path, JSON.stringify(value)]))

  function arm(ms: number, retry: boolean): void {
    if (disposed) return
    if (timer) {
      // A mutation shortens a pending retry; anything else already pending is soon enough.
      if (!(timer.retry && !retry)) return
      timer.cancel()
    }
    const cancel = schedule(() => { timer = null; void run({}) }, ms)
    timer = { cancel, retry }
  }

  /** Runs the owed initial sync first when it can run, then `opts`. */
  async function run(opts: RunOptions): Promise<void> {
    await runInitial()
    await enqueue(opts)
  }

  async function runInitial(): Promise<void> {
    const owed = initialOwed
    if (!owed || store.readOnly || disposed) return
    initialOwed = null
    await enqueue(owed)
    // Lost the lock before the run got its turn, or the commit failed: still owed.
    if (!owed.initial) return
    if (!initialDone) initialOwed = owed
  }

  function enqueue(opts: RunOptions): Promise<void> {
    timer?.cancel()
    timer = null
    const run = chain.then(() => commitOnce(opts))
    chain = run.catch(() => {})
    return run
  }

  async function commitOnce(opts: RunOptions): Promise<void> {
    if (disposed || store.readOnly) return
    const records = splitDoc(store.doc)
    const next = serialize(records)
    const puts = new Map<string, unknown>()
    for (const [path, json] of next) if (cache.get(path) !== json) puts.set(path, records.get(path))
    const deletes = [...cache.keys()].filter((p) => !next.has(p))

    const images = store.doc.images
    const putBlobs = new Map<string, Uint8Array>()
    const referenced = swept.size > 0 ? collectImageRefs(store.doc) : null
    for (const id of Object.keys(images)) {
      if (persistedBlobs.has(id) || !store.images.has(id)) continue
      if (swept.has(id) && !referenced!.has(id)) continue
      const bytes = await store.images.getStored(id)
      if (bytes) putBlobs.set(id, bytes)
    }

    const file = opts.file ?? pendingStamp
    const nextLineage: LineageFields = { ...lineage }
    let nextUnwritten = unwritten
    if (store.dirty || (!opts.quiet && (puts.size > 0 || deletes.length > 0))) nextUnwritten = true
    let deleteBlobs: string[] = []
    if (file || opts.adopt) {
      const s = opts.adopt ? opts.adopt.stamp : file!.stamp
      if (s) {
        nextLineage.lastWriteId = s.writeId
        nextLineage.knownWriteIds = [s.writeId, ...lineage.knownWriteIds.filter((w) => w !== s.writeId)].slice(0, KNOWN_WRITE_IDS)
        nextLineage.lastFileWriteAt = s.savedAt
      } else {
        nextLineage.lastWriteId = null
      }
      nextUnwritten = !opts.adopt && file!.revAtSnapshot !== undefined && store.rev !== file!.revAtSnapshot
      if (!opts.adopt) {
        const refs = referenced ?? collectImageRefs(store.doc)
        deleteBlobs = [...persistedBlobs].filter((id) => !refs.has(id) && !putBlobs.has(id))
      }
    }

    const meta = { unwrittenChanges: nextUnwritten, fileName: deps.fileName, ...nextLineage }
    const metaJson = JSON.stringify(meta)
    if (puts.size === 0 && deletes.length === 0 && putBlobs.size === 0 && deleteBlobs.length === 0 && metaJson === lastMeta) return

    try {
      await live.write({ puts, deletes, putBlobs, deleteBlobs, meta, clear: opts.clear })
    } catch (e) {
      const first = lastError === null
      lastError = e
      if (first) { deps.onError?.(e); announceError(true) }
      arm(RETRY_MS, true)
      return
    }
    for (const [path, json] of next) cache.set(path, json)
    for (const p of deletes) cache.delete(p)
    for (const id of putBlobs.keys()) { persistedBlobs.add(id); swept.delete(id) }
    for (const id of deleteBlobs) { persistedBlobs.delete(id); swept.add(id) }
    lineage = nextLineage
    unwritten = nextUnwritten
    lastMeta = metaJson
    if (opts.initial) initialDone = true
    if (file && pendingStamp === file) pendingStamp = null
    if (lastError !== null) {
      lastError = null
      deps.onRecovered?.()
      announceError(false)
    }
  }

  // --- initial sync ---------------------------------------------------------
  const existing = await live.meta()
  const replacing = !!existing && deps.replaceStored === true
  if (existing && !replacing) {
    // The caller loaded this document from the browser store (or verified the file equals it), so what the
    // store holds is what the document holds: seed the cache from it rather than rewriting everything.
    for (const [path, json] of deps.stored ? serialize(deps.stored.records) : serialize(splitDoc(store.doc))) cache.set(path, json)
    for (const id of deps.stored ? deps.stored.blobIds : Object.keys(store.doc.images)) persistedBlobs.add(id)
    lineage = { lastWriteId: existing.lastWriteId, knownWriteIds: existing.knownWriteIds, lastFileWriteAt: existing.lastFileWriteAt }
    unwritten = existing.unwrittenChanges
    lastMeta = JSON.stringify({ unwrittenChanges: unwritten, fileName: existing.fileName, ...lineage })
  }
  const unsubscribers = [
    store.onMutate(() => arm(debounceMs, false)),
    store.onDirty(() => arm(debounceMs, false)),
    // Gaining the write lock is the moment an owed initial sync can run.
    store.onReadOnlyChange((readOnly) => { if (!readOnly) void runInitial() }),
  ]
  if (!existing || replacing) {
    initialOwed = { initial: true, ...(deps.fromFile !== undefined ? { adopt: { stamp: deps.fromFile } } : {}), ...(replacing ? { clear: true } : {}) }
  } else if (deps.stored || existing.fileName !== deps.fileName) {
    initialOwed = { initial: true, quiet: true }
  } else {
    initialDone = true
  }
  await runInitial()

  return {
    flush: () => run({}),
    markFileWritten: (stamp, revAtSnapshot) => {
      const file: FileWrite = { stamp, revAtSnapshot }
      pendingStamp = file
      return run({ file })
    },
    adoptFileStamp: (stamp) => run({ adopt: { stamp } }),
    rekey: (codec) => {
      const rekeying = chain.then(async () => {
        const blobs = new Map<string, Uint8Array>()
        const lost: string[] = []
        for (const id of persistedBlobs) {
          const bytes = store.images.has(id) ? await store.images.getStored(id) : null
          if (bytes) blobs.set(id, bytes)
          else lost.push(id) // damaged or gone: it is not carried over (the store drops blobs absent from the new set)
        }
        await live.rekey(codec, blobs)
        for (const id of lost) persistedBlobs.delete(id)
      })
      chain = rekeying.catch(() => {})
      return rekeying
    },
    reseed: (stored) => {
      // What the store holds now supersedes anything this tab still owed it.
      initialOwed = null
      initialDone = true
      const reseeding = chain.then(async () => {
        const meta = await live.meta()
        cache.clear()
        for (const [path, json] of serialize(stored.records)) cache.set(path, json)
        persistedBlobs.clear()
        for (const id of stored.blobIds) persistedBlobs.add(id)
        swept.clear()
        if (meta) {
          lineage = { lastWriteId: meta.lastWriteId, knownWriteIds: meta.knownWriteIds, lastFileWriteAt: meta.lastFileWriteAt }
          unwritten = meta.unwrittenChanges
          lastMeta = JSON.stringify({ unwrittenChanges: unwritten, fileName: meta.fileName, ...lineage })
        }
      })
      chain = reseeding.catch(() => {})
      return reseeding
    },
    onErrorChange(fn) {
      errorListeners.add(fn)
      return () => { errorListeners.delete(fn) }
    },
    get lastError() { return lastError },
    dispose() {
      disposed = true
      timer?.cancel()
      timer = null
      errorListeners.clear()
      for (const off of unsubscribers) off()
    },
  }
}
