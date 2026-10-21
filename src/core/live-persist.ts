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
import { splitDoc } from './doc-records'
import { collectImageRefs } from './image-ref'

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
  let disposed = false
  let timer: { cancel: () => void; retry: boolean } | null = null
  let chain: Promise<void> = Promise.resolve()

  const serialize = (records: Map<string, unknown>): Map<string, string> =>
    new Map([...records].map(([path, value]) => [path, JSON.stringify(value)]))

  function arm(ms: number, retry: boolean): void {
    if (disposed) return
    if (timer) {
      // A mutation shortens a pending retry; anything else already pending is soon enough.
      if (!(timer.retry && !retry)) return
      timer.cancel()
    }
    const cancel = schedule(() => { timer = null; void enqueue({}) }, ms)
    timer = { cancel, retry }
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
    if (store.dirty || puts.size > 0 || deletes.length > 0) nextUnwritten = true
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
      await live.write({ puts, deletes, putBlobs, deleteBlobs, meta })
    } catch (e) {
      const first = lastError === null
      lastError = e
      if (first) deps.onError?.(e)
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
    if (file && pendingStamp === file) pendingStamp = null
    if (lastError !== null) {
      lastError = null
      deps.onRecovered?.()
    }
  }

  // --- initial sync ---------------------------------------------------------
  const existing = await live.meta()
  if (existing) {
    // The caller loaded this document from the browser store (or verified the file equals it), so what the
    // store holds is what the document holds: seed the cache from it rather than rewriting everything.
    for (const [path, json] of serialize(splitDoc(store.doc))) cache.set(path, json)
    for (const id of Object.keys(store.doc.images)) persistedBlobs.add(id)
    lineage = { lastWriteId: existing.lastWriteId, knownWriteIds: existing.knownWriteIds, lastFileWriteAt: existing.lastFileWriteAt }
    unwritten = existing.unwrittenChanges
    lastMeta = JSON.stringify({ unwrittenChanges: unwritten, fileName: existing.fileName, ...lineage })
  }
  const unsubscribers = [
    store.onMutate(() => arm(debounceMs, false)),
    store.onDirty(() => arm(debounceMs, false)),
  ]
  if (!existing) await enqueue({})
  else if (existing.fileName !== deps.fileName) await enqueue({})

  return {
    flush: () => enqueue({}),
    markFileWritten: (stamp, revAtSnapshot) => {
      const file: FileWrite = { stamp, revAtSnapshot }
      pendingStamp = file
      return enqueue({ file })
    },
    adoptFileStamp: (stamp) => enqueue({ adopt: { stamp } }),
    get lastError() { return lastError },
    dispose() {
      disposed = true
      timer?.cancel()
      timer = null
      for (const off of unsubscribers) off()
    },
  }
}
