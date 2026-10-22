// Differential guard for the persister's diff: after every random operation and a flush,
// reading the browser store back must equal the in-memory document (and every image the
// document lists must have its blob). A mutation path the diff misses shows up as the
// first operation after which the two disagree. Same idea as search-differential.test.ts.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { createLivePersister } from '../src/core/live-persist'
import { createStore } from '../src/core/store'
import { createImageStore } from '../src/core/image-store'
import { joinDoc } from '../src/core/doc-records'
import { readDoc } from '../src/core/live-open'
import { collectImageRefs } from '../src/core/image-ref'
import { unlinkRefsInTeam } from '../src/core/refs'
import { deleteInTeamWithUndo, type UndoOffer } from '../src/core/undo-delete'
import { newStamp } from '../src/core/file-stamp'
import { blobCodec, recordCodec, resetSessionKey, type RecordCodec } from '../src/core/crypto'
import type { BlobCodec } from '../src/core/image-store'
import type { LivePersister } from '../src/core/live-persist'
import { buildRichDoc, makeRng } from './search-fixture'
import type { Doc } from '../src/core/types'

const SHAPE = { teams: 3, dailyNotes: 6, people: 4, actions: 6, milestones: 4, risks: 4 }
const OPS = 300

afterEach(() => { vi.unstubAllGlobals() })

// Both kinds of document: with a password every record and image is sealed, so the writes, reads and sweeps below go
// through the real codecs instead of the pass-through of a password-less file.
test.each([['password-less', null], ['encrypted', 'correct horse']] as const)(`after each of ${OPS} random operations the browser copy equals the live document (%s)`, async (_label, password) => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const rnd = makeRng(20261021)
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const db = await openLiveDb(new IDBFactory())
  const doc = buildRichDoc(SHAPE, 11)
  resetSessionKey()
  const blob = password === null ? null : await blobCodec(password)
  const codec = password === null ? null : await recordCodec(password, blob!.header!.salt)
  const store = createStore(doc, createImageStore(blob))
  const live = createLiveStore(db, doc.docId, codec)
  const persister = await createLivePersister({ store, live, fileName: 'f.tmv', schedule: () => () => {} })
  let imageSeq = 0
  const log: string[] = []
  let offer = null as UndoOffer | null
  const REF_OF = { actionItems: 'action', milestones: 'milestone', risks: 'risk' } as const
  const deleteWithUnlink = (collection: keyof typeof REF_OF): void => {
    type Row = { id: string; summary?: string; title?: string }
    const t = pick(store.doc.teams)
    const list = (tm: typeof t): Row[] => tm[collection] as Row[]
    if (list(t).length === 0) return
    const id = pick(list(t)).id
    offer = deleteInTeamWithUndo(store, t.id, (tm) => list(tm).some((e) => e.id === id), (tm) => {
      const gone = list(tm).find((e) => e.id === id)!
      unlinkRefsInTeam(tm, REF_OF[collection], new Map([[id, gone.summary ?? gone.title ?? '']]))
      ;(tm as unknown as Record<string, unknown>)[collection] = list(tm).filter((e) => e.id !== id)
    }, { teamId: t.id })
    // Often the user hits Undo at once, so the restore is exercised right behind the delete.
    if (rnd() < 0.4 && offer?.isAvailable()) offer.undo()
  }

  for (let op = 0; op < OPS; op++) {
    const team = () => pick(store.doc.teams)
    const kind = Math.floor(rnd() * 18)
    switch (kind) {
      case 0: store.update((d) => { const t = pick(d.teams); const k = Object.keys(t.dailyNotes); if (k.length) t.dailyNotes[pick(k)] = `edit ${op}` }); log.push('daily edit'); break
      case 1: store.update((d) => { pick(d.teams).dailyNotes[`2027-01-${String(1 + (op % 28)).padStart(2, '0')}`] = rnd() < 0.2 ? '' : `new ${op}` }); log.push('daily add'); break
      case 2: store.update((d) => { const t = pick(d.teams); const k = Object.keys(t.dailyNotes); if (k.length) delete t.dailyNotes[pick(k)] }); log.push('daily delete'); break
      case 3: store.update((d) => { const t = pick(d.teams); if (t.actionItems.length) t.actionItems[0]!.summary += '!' }); log.push('action edit'); break
      case 4: store.update((d) => { const t = pick(d.teams); t.actionItems.push({ id: `n${op}`, summary: 's', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: op }) }); log.push('action add'); break
      case 5: store.update((d) => { const t = pick(d.teams); if (t.risks.length) t.risks.splice(Math.floor(rnd() * t.risks.length), 1) }); log.push('risk remove'); break
      case 6: store.update((d) => { pick(d.teams).milestones.reverse() }); log.push('milestone reorder'); break
      case 7: store.updateNav((d) => { d.nav.activeTeamId = pick(d.teams).id; d.nav.split = rnd() < 0.5 }); log.push('nav'); break
      case 8: store.update((d) => { d.prefs.fontSize = pick(['S', 'M', 'L'] as const); d.favorites = rnd() < 0.5 ? [] : [{ teamId: d.teams[0]!.id, ref: { kind: 'general' } }] }); log.push('prefs'); break
      case 9: {
        const id = String(imageSeq++).padStart(32, '0')
        store.images.putPlain(id, new Uint8Array([op % 256, 1, 2]))
        const t = team()
        store.update((d) => { d.images[id] = { mime: 'image/webp', w: 1, h: 1, bytes: 3 }; d.teams.find((x) => x.id === t.id)!.generalNotes = `![p](img:${id})` })
        log.push('image add'); break
      }
      case 10: store.update((d) => { if (d.teams.length > 1 && rnd() < 0.5) d.teams.splice(Math.floor(rnd() * d.teams.length), 1); else d.teams.reverse() }); log.push('team remove/reorder'); break
      case 12: store.update((d) => { const t = pick(d.teams); const all = [...t.stakeholders, ...t.members]; if (all.length) pick(all).notes = `person notes ${op}` }); log.push('person notes edit'); break
      case 13: store.update((d) => { const t = pick(d.teams); if (t.milestones.length) pick(t.milestones).followup = `milestone ${op}` }); log.push('milestone edit'); break
      case 14: deleteWithUnlink(pick(['actionItems', 'milestones', 'risks'] as const)); log.push('delete with unlink'); break
      case 15: if (offer?.isAvailable()) offer.undo(); offer = null; log.push('undo delete'); break
      case 16: store.update((d) => { const t = pick(d.teams); if (t.risks.length) pick(t.risks).followup = `risk ${op}` }); log.push('risk edit'); break
      case 17: store.update((d) => { const t = pick(d.teams); const all = [...t.stakeholders, ...t.members]; if (all.length) pick(all).name = `renamed ${op}` }); log.push('person rename'); break
      default: {
        if (rnd() < 0.15) {
          const next: Doc = JSON.parse(JSON.stringify(store.doc)) as Doc
          next.teams = next.teams.slice(0, 2)
          next.teams[0]!.name = `replaced ${op}`
          store.replaceDoc(next)
          log.push('replaceDoc')
        } else {
          store.update((d) => { pick(d.teams).generalNotes = rnd() < 0.3 ? undefined : `general ${op}` })
          log.push('general')
        }
      }
    }
    await persister.flush()
    const loaded = await createLiveStore(db, doc.docId, codec).load()
    const back = joinDoc(loaded.records)
    // toEqual would swallow a missing-vs-undefined difference only for undefined fields, which JSON cannot carry anyway.
    expect(back, `after op ${op} (${log.at(-1)})`).toEqual(JSON.parse(JSON.stringify(store.doc)))
    for (const id of Object.keys(store.doc.images)) {
      if (store.images.has(id)) expect(loaded.blobs.has(id), `blob ${id} after op ${op} (${log.at(-1)})`).toBe(true)
    }
  }
}, 120000)

// The lifecycle fuzz: the same agreement (the browser copy read back through a FRESH store with the CURRENT key equals
// the live document, and every referenced image opens to its bytes), but through everything that moves the copy
// around: encryption and re-keying, file writes with the image sweep, a takeover reseed, read-only toggling, a document
// swapped for another with its own image store, a duplicate id, and a full close-and-reopen from the copy.
test('the browser copy keeps agreeing with the document through key changes, file writes, reseeds, swaps and reopens', async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const rnd = makeRng(20261022)
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const db = await openLiveDb(new IDBFactory())

  // Two real keys, derived once (deriving is the slow part), plus "no key".
  resetSessionKey()
  const blobA = await blobCodec('alpha')
  const recA = await recordCodec('alpha', blobA.header!.salt)
  resetSessionKey()
  const blobB = await blobCodec('beta')
  const recB = await recordCodec('beta', blobB.header!.salt)
  const keys: { blob: BlobCodec | null; rec: RecordCodec | null }[] = [{ blob: null, rec: null }, { blob: blobA, rec: recA }, { blob: blobB, rec: recB }]
  let cur = keys[1]!

  const doc = buildRichDoc({ teams: 2, dailyNotes: 4, people: 3, actions: 4, milestones: 3, risks: 3 }, 12)
  let store = createStore(doc, createImageStore(cur.blob))
  let persister: LivePersister = await createLivePersister({ store, live: createLiveStore(db, doc.docId, cur.rec), fileName: 'f.tmv', schedule: () => () => {} })
  let imageSeq = 0
  const log: string[] = []
  let docAtFileWrite: string | null = null

  const check = async (label: string): Promise<void> => {
    const at = `after ${label} (${log.length} ops)`
    const loaded = await createLiveStore(db, doc.docId, cur.rec).load()
    expect(readDoc(loaded.records), at).toEqual(JSON.parse(JSON.stringify(store.doc)))
    const refs = collectImageRefs(store.doc)
    for (const id of refs) {
      if (!store.images.has(id)) continue
      const stored = loaded.blobs.get(id)
      expect(stored, `blob ${id} ${at}`).toBeDefined()
      const plain = cur.blob ? await cur.blob.open(id, stored!) : stored!
      expect(Array.from(plain), `blob ${id} content ${at}`).toEqual(Array.from((await store.images.getPlain(id))!))
    }
    const meta = (await db.getMeta(doc.docId))!
    expect(meta.encrypted, `encrypted flag ${at}`).toBe(cur.rec !== null)
    if (cur.rec) expect(await cur.rec.verifyCheck(meta.check!), `check block ${at}`).toBe(true)
    if (docAtFileWrite !== null && JSON.stringify(store.doc) !== docAtFileWrite) expect(meta.unwrittenChanges, `unwritten flag ${at}`).toBe(true)
  }

  // Entity edits and undoable deletes, interleaved with everything that moves the key and the copy.
  let offer = null as UndoOffer | null
  const REF_OF = { actionItems: 'action', milestones: 'milestone', risks: 'risk' } as const
  const deleteWithUnlink = (collection: keyof typeof REF_OF): void => {
    type Row = { id: string; summary?: string; title?: string }
    const t = pick(store.doc.teams)
    const list = (tm: typeof t): Row[] => tm[collection] as Row[]
    if (list(t).length === 0) return
    const id = pick(list(t)).id
    offer = deleteInTeamWithUndo(store, t.id, (tm) => list(tm).some((e) => e.id === id), (tm) => {
      const gone = list(tm).find((e) => e.id === id)!
      unlinkRefsInTeam(tm, REF_OF[collection], new Map([[id, gone.summary ?? gone.title ?? '']]))
      ;(tm as unknown as Record<string, unknown>)[collection] = list(tm).filter((e) => e.id !== id)
    }, { teamId: t.id })
    if (rnd() < 0.4 && offer?.isAvailable()) offer.undo()
  }

  const OPS_LIFE = 160
  for (let op = 0; op < OPS_LIFE; op++) {
    const kind = Math.floor(rnd() * 20)
    switch (kind) {
      case 0: store.update((d) => { const t = pick(d.teams); const k = Object.keys(t.dailyNotes); if (k.length) t.dailyNotes[pick(k)] = `edit ${op}` }); log.push('daily edit'); break
      case 1: store.update((d) => { pick(d.teams).dailyNotes[`2027-02-${String(1 + (op % 28)).padStart(2, '0')}`] = `new ${op}` }); log.push('daily add'); break
      case 2: store.update((d) => { const t = pick(d.teams); if (t.actionItems.length) t.actionItems[0]!.summary += '!' }); log.push('action edit'); break
      case 3: {
        // A damaged file can carry two entities with one id: each must keep its own record.
        store.update((d) => { const t = pick(d.teams); if (t.actionItems.length) t.actionItems.push({ ...t.actionItems[0]!, summary: `dup ${op}` }) })
        log.push('duplicate id'); break
      }
      case 4: {
        const id = String(imageSeq++).padStart(32, '0')
        store.images.putPlain(id, new Uint8Array([op % 256, 3, 4]))
        const t = pick(store.doc.teams)
        store.update((d) => { d.images[id] = { mime: 'image/webp', w: 1, h: 1, bytes: 3 }; d.teams.find((x) => x.id === t.id)!.generalNotes = `![p](img:${id})` })
        log.push('image add'); break
      }
      case 5: {
        // image metadata changes with no note change at all
        store.update((d) => { const ids = Object.keys(d.images); if (ids.length) d.images[pick(ids)]!.w += 1 })
        log.push('image metadata'); break
      }
      case 6: store.update((d) => { for (const t of d.teams) if (t.generalNotes?.includes('img:') && rnd() < 0.5) t.generalNotes = 'no picture any more' }); log.push('image unreferenced'); break
      case 7: {
        // a file write: the sweep deletes blobs nothing references, and the copy records the lineage
        await persister.flush()
        await persister.markFileWritten(newStamp(), store.rev)
        store.markSaved()
        docAtFileWrite = JSON.stringify(store.doc)
        log.push('file write'); break
      }
      case 8: {
        // a password change: the image store first (it re-seals every blob), then the copy
        const next = pick(keys.filter((k) => k !== cur))
        await persister.flush()
        await store.images.rekey(next.blob)
        await persister.rekey(next.rec)
        cur = next
        log.push(`rekey -> ${next.rec ? 'key' : 'plain'}`); break
      }
      case 9: {
        // a tab takeover: the persister is re-seeded from whatever the copy holds now
        await persister.flush()
        const stored = await createLiveStore(db, doc.docId, cur.rec).load()
        await persister.reseed({ records: stored.records, blobIds: stored.blobs.keys() })
        log.push('reseed'); break
      }
      case 10: {
        // losing the lock: nothing may reach the copy while read-only
        await persister.flush()
        const before = JSON.stringify(await db.readAll(doc.docId))
        store.setReadOnly(true, { silent: true })
        await persister.flush()
        expect(JSON.stringify(await db.readAll(doc.docId)), 'read-only write').toBe(before)
        store.setReadOnly(false)
        log.push('read-only toggle'); break
      }
      case 11: {
        // the document replaced by another (a conflict Reload), arriving with an image store of its own
        const next: Doc = JSON.parse(JSON.stringify(store.doc)) as Doc
        next.teams = next.teams.slice(0, 2)
        next.teams[0]!.name = `replaced ${op}`
        const images = createImageStore(cur.blob)
        for (const id of Object.keys(next.images)) {
          const plain = await store.images.getPlain(id)
          if (plain) images.putPlain(id, plain)
        }
        store.replaceDoc(next, images)
        log.push('replaceDoc with images'); break
      }
      case 12: {
        // close and reopen from the copy: the whole document comes back from storage and the diff starts from that
        await persister.flush()
        persister.dispose()
        const live = createLiveStore(db, doc.docId, cur.rec)
        const stored = await live.load()
        const reopened = readDoc(stored.records)
        const images = createImageStore(cur.blob)
        for (const [id, bytes] of stored.blobs) images.adoptStored(id, bytes)
        store = createStore(reopened, images)
        persister = await createLivePersister({ store, live, fileName: 'f.tmv', stored: { records: stored.records, blobIds: stored.blobs.keys() }, schedule: () => () => {} })
        log.push('reopen'); break
      }
      case 16: store.update((d) => { const t = pick(d.teams); const all = [...t.stakeholders, ...t.members]; if (all.length) pick(all).notes = `person notes ${op}` }); log.push('person notes edit'); break
      case 17: store.update((d) => { const t = pick(d.teams); if (t.milestones.length) pick(t.milestones).followup = `milestone ${op}` }); log.push('milestone edit'); break
      case 18: deleteWithUnlink(pick(['actionItems', 'milestones', 'risks'] as const)); log.push('delete with unlink'); break
      case 19: if (offer?.isAvailable()) offer.undo(); offer = null; log.push('undo delete'); break
      default: store.update((d) => { pick(d.teams).generalNotes = `general ${op}` }); log.push('general')
    }
    await persister.flush()
    await check(log.at(-1)!)
  }
}, 600000)
