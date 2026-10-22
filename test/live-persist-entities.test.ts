// Per-entity persistence + search/backlinks coherence through delete and undo.
// The browser copy must receive only the records an edit touched; the search index (fed the way
// ui/panes.ts feeds it) must agree with an uncached scan and with a copy read back from the browser.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLiveDb, type LiveBatch, type LiveDb } from '../src/core/live-db'
import { createLiveStore } from '../src/core/live-store'
import { createLivePersister } from '../src/core/live-persist'
import { createStore, type Store } from '../src/core/store'
import { createImageStore } from '../src/core/image-store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { joinDoc, splitDoc } from '../src/core/doc-records'
import { createSearchIndex, searchDocument, type SearchIndex } from '../src/core/search'
import { recordCodec, type RecordCodec } from '../src/core/crypto'
import { unlinkRefsInTeam } from '../src/core/refs'
import { deleteInTeamWithUndo, type UndoOffer } from '../src/core/undo-delete'
import type { Doc, Team } from '../src/core/types'
import { buildRichDoc, makeRng } from './search-fixture'

let rawDb: LiveDb
let commits: LiveBatch[]
let gate: Promise<void> | null
let metaGate: Promise<void> | null
// The key the browser copy is sealed under in the suite running now (null: a password-less document).
let codec: RecordCodec | null = null

beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  rawDb = await openLiveDb(new IDBFactory())
  commits = []
  gate = null
  metaGate = null
})
afterEach(() => { vi.unstubAllGlobals() })

function sampleDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  const t1 = createEmptyTeam('T1', 'Alpha', '', 'en-US')
  t1.members.push({ id: 'p1', name: 'Ana', role: 'dev', parentId: null, order: 0, notes: 'owns @[fix login](action:a1) and @[fix cart](action:a2)' })
  t1.members.push({ id: 'p2', name: 'Bob', role: 'qa', parentId: null, order: 1, notes: 'plain' })
  t1.actionItems.push(
    { id: 'a1', summary: 'fix login', notes: 'blocked by vendor', status: 'todo', dueDate: null, assignee: '', color: null, order: 0 },
    { id: 'a2', summary: 'fix cart', notes: 'see @[fix login](action:a1)', status: 'todo', dueDate: null, assignee: '', color: null, order: 1 },
    { id: 'a3', summary: 'unrelated', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 2 },
  )
  t1.milestones.push({ id: 'm1', date: '2026-10-01', title: 'ship', done: false, followup: 'needs @[fix login](action:a1) first' })
  t1.risks.push({ id: 'r1', title: 'vendor slip', chance: 2, impact: 2, plan: 'mitigate', followup: '', order: 0, closed: false })
  t1.dailyNotes['2026-10-01'] = 'talked about @[fix login](action:a1) today'
  t1.dailyNotes['2026-10-02'] = 'nothing relevant'
  t1.generalNotes = 'general @[fix login](action:a1)'
  doc.teams.push(t1)
  const t2 = createEmptyTeam('T2', 'Beta', '', 'en-US')
  t2.actionItems.push({ id: 'b1', summary: 'fix login too', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 0 })
  t2.dailyNotes['2026-10-01'] = 'beta note'
  doc.teams.push(t2)
  return doc
}

interface Rig { store: Store; index: SearchIndex; flush: () => Promise<void>; load: () => Promise<Doc>; fire: () => void }

async function rig(doc: Doc = sampleDoc()): Promise<Rig> {
  const store = createStore(doc, createImageStore(null))
  const db: LiveDb = {
    ...rawDb,
    async getMeta(id) { if (metaGate) await metaGate; return rawDb.getMeta(id) },
    async commit(id, batch) { commits.push(batch); if (gate) await gate; return rawDb.commit(id, batch) },
  }
  const live = createLiveStore(db, doc.docId, codec)
  const timers = new Set<() => void>()
  const persister = await createLivePersister({ store, live, fileName: 'a.tmv', schedule: (fn) => { timers.add(fn); return () => { timers.delete(fn) } } })
  // The wiring of ui/panes.ts.
  const index = createSearchIndex(() => store.doc, () => store.rev)
  store.subscribe((scope) => index.invalidate(scope))
  store.onMutate((kind) => { if (kind === 'nav') index.acknowledgeNav() })
  commits.length = 0
  return {
    store, index, flush: () => persister.flush(),
    load: async () => joinDoc((await createLiveStore(rawDb, doc.docId, codec).load()).records),
    fire: () => { const all = [...timers]; timers.clear(); all.forEach((f) => f()) },
  }
}

type Collection = 'actionItems' | 'milestones' | 'risks'
const REF_OF = { actionItems: 'action', milestones: 'milestone', risks: 'risk' } as const

/** The delete flow of modules/entity-delete.ts: unlink the mentions across the team, drop the entity, one undoable update. */
function deleteEntity(store: Store, teamId: string, collection: Collection, id: string): UndoOffer | null {
  type Row = { id: string; summary?: string; title?: string }
  const listOf = (tm: Team): Row[] => tm[collection] as Row[]
  return deleteInTeamWithUndo(store, teamId, (tm) => listOf(tm).some((e) => e.id === id), (tm) => {
    const removed = listOf(tm).find((e) => e.id === id)!
    unlinkRefsInTeam(tm, REF_OF[collection], new Map([[id, removed.summary ?? removed.title ?? '']]))
    ;(tm as unknown as Record<string, unknown>)[collection] = listOf(tm).filter((e) => e.id !== id)
  }, { teamId })
}
const deleteAction = (store: Store, id: string): UndoOffer | null => deleteEntity(store, 'T1', 'actionItems', id)

const fresh = (doc: Doc, q: string, scope: string | null) => searchDocument(doc, q, scope)

// Both kinds of document: the seal is real async work, so an encrypted copy has a wider window for every race
// below, and a password-less one is what most documents are.
describe.each([['password-less', null], ['encrypted', 'correct horse']] as const)('%s document', (_label, password) => {
  beforeAll(async () => { codec = password === null ? null : await recordCodec(password) })
  afterAll(() => { codec = null })

  describe('only the edited entity reaches the browser copy', () => {
    test('editing one action item commits exactly that item', async () => {
      const r = await rig()
      r.store.update((d) => { d.teams[0]!.actionItems[2]!.summary = 'unrelated!' }, { teamId: 'T1', sections: ['actions'] })
      await r.flush()
      expect(commits).toHaveLength(1)
      expect(commits[0]!.putRecords).toHaveLength(1)
      expect(commits[0]!.deleteRecords).toHaveLength(0)
      expect(await r.load()).toEqual(r.store.doc)
    })

    test("editing one person's notes commits exactly that person", async () => {
      const r = await rig()
      r.store.update((d) => { d.teams[0]!.members[1]!.notes = 'changed' }, { teamId: 'T1', sections: ['people'] })
      await r.flush()
      expect(commits).toHaveLength(1)
      expect(commits[0]!.putRecords).toHaveLength(1)
      expect(commits[0]!.deleteRecords).toHaveLength(0)
    })

    test('editing one milestone and one risk commits exactly those two', async () => {
      const r = await rig()
      r.store.update((d) => { d.teams[0]!.milestones[0]!.title = 'ship it' }, { teamId: 'T1', sections: ['milestones'] })
      r.store.update((d) => { d.teams[0]!.risks[0]!.closed = true }, { teamId: 'T1', sections: ['risks'] })
      await r.flush()
      expect(commits).toHaveLength(1)
      expect(commits[0]!.putRecords).toHaveLength(2)
    })

    test('deleting an action item writes the item out and only the records that mentioned it', async () => {
      const r = await rig()
      deleteAction(r.store, 'a1')
      await r.flush()
      expect(commits).toHaveLength(1)
      // a1 itself; the team order record; the mentioning person (p1), action (a2), milestone (m1), daily note and general notes.
      expect(commits[0]!.deleteRecords).toHaveLength(1)
      expect(commits[0]!.putRecords).toHaveLength(6)
      expect(await r.load()).toEqual(r.store.doc)
    })

    test('undo of that delete restores the copy, again touching only what changed', async () => {
      const r = await rig()
      const before = structuredClone(r.store.doc)
      const offer = deleteAction(r.store, 'a1')
      await r.flush()
      commits.length = 0
      expect(offer!.undo()).toBe(true)
      await r.flush()
      expect(commits).toHaveLength(1)
      expect(commits[0]!.deleteRecords).toHaveLength(0)
      expect(commits[0]!.putRecords).toHaveLength(7) // the six rewritten above, plus a1 back
      expect(await r.load()).toEqual(before)
    })

    test('a delete and its undo inside one debounce window write nothing', async () => {
      const r = await rig()
      const offer = deleteAction(r.store, 'a1')
      offer!.undo()
      await r.flush()
      expect(commits).toHaveLength(0)
    })

    test('deleting a team-less-general-notes item does not leave a stray general-notes record behind after undo', async () => {
      const r = await rig()
      delete r.store.doc.teams[1]!.generalNotes
      await r.flush()
      commits.length = 0
      const offer = deleteInTeamWithUndo(r.store, 'T2', () => true, (tm) => {
        unlinkRefsInTeam(tm, 'action', new Map([['b1', 'fix login too']]))
        tm.actionItems = []
      }, { teamId: 'T2' })
      await r.flush()
      offer!.undo()
      await r.flush()
      const back = await r.load()
      expect(back).toEqual(JSON.parse(JSON.stringify(r.store.doc)))
      expect('generalNotes' in back.teams[1]!).toBe(false)
    })
  })

  describe('an edit that lands while a commit is being prepared', () => {
    // Entity records alias the live document and live-store.write reads them only after its first await (the meta
    // read, a real IndexedDB round trip). An edit landing in that gap is sealed, but the cache holds the JSON the diff
    // compared. Revert it before the trailing flush and cache and document agree, so the browser copy keeps the
    // intermediate value for good.
    test('is not lost when it is reverted before the trailing flush', async () => {
      const r = await rig()
      let release!: () => void
      metaGate = new Promise<void>((res) => { release = res })
      r.store.update((d) => { d.teams[0]!.actionItems[2]!.summary = 'X1' })
      const p = r.flush()
      await new Promise((res) => setTimeout(res, 10))
      r.store.update((d) => { d.teams[0]!.actionItems[2]!.summary = 'X2' })
      metaGate = null
      release()
      await p
      r.store.update((d) => { d.teams[0]!.actionItems[2]!.summary = 'X1' })
      await r.flush()
      expect(r.store.doc.teams[0]!.actionItems[2]!.summary).toBe('X1')
      expect((await r.load()).teams[0]!.actionItems[2]!.summary).toBe('X1')
    })
  })

  describe('search and backlinks follow delete and undo', () => {
    const mentionsOf = (r: Rig) => r.index.backlinks('T1', 'action', 'a1').map((b) => b.title).sort()

    test('deleting flattens the mentions: no backlinks, no stale hits; undo brings both back', async () => {
      const r = await rig()
      const before = structuredClone(r.store.doc)
      expect(mentionsOf(r)).toHaveLength(5) // p1, a2, m1, daily 10-01, general
      expect(r.index.search('fix login', null).map((h) => h.teamName)).toContain('Alpha')

      const offer = deleteAction(r.store, 'a1')
      expect(r.index.backlinks('T1', 'action', 'a1')).toEqual([])
      for (const q of ['fix login', 'login', 'vendor', 'owns']) {
        expect(r.index.search(q, null), q).toEqual(fresh(r.store.doc, q, null))
      }
      // The deleted item itself is gone from results, its flattened label remains in the notes that named it.
      expect(r.index.search('blocked by vendor', null)).toEqual([])

      expect(offer!.undo()).toBe(true)
      expect(r.store.doc).toEqual(before)
      expect(mentionsOf(r)).toHaveLength(5)
      for (const q of ['fix login', 'login', 'vendor', 'blocked']) {
        expect(r.index.search(q, null), q).toEqual(fresh(r.store.doc, q, null))
      }
    })

    test('narrowing a query across a delete does not serve the deleted item', async () => {
      const r = await rig()
      expect(r.index.search('block', 'T1').length).toBeGreaterThan(0)
      deleteAction(r.store, 'a1')
      expect(r.index.search('blocked', 'T1')).toEqual(fresh(r.store.doc, 'blocked', 'T1'))
      expect(r.index.search('blocked', 'T1')).toEqual([])
    })

    test('the other team is untouched by a delete in this one', async () => {
      const r = await rig()
      r.index.search('fix', null)
      deleteAction(r.store, 'a1')
      expect(r.index.search('fix login too', 'T2')).toEqual(fresh(r.store.doc, 'fix login too', 'T2'))
      expect(r.index.backlinks('T2', 'action', 'b1')).toEqual([])
    })

    test('what the browser copy holds, searched, equals what the live document searches to', async () => {
      const r = await rig()
      const offer = deleteAction(r.store, 'a1')
      await r.flush()
      const reloaded = await r.load()
      for (const q of ['fix', 'login', 'vendor', 'ana']) expect(fresh(reloaded, q, null), q).toEqual(r.index.search(q, null))
      offer!.undo()
      await r.flush()
      const reloaded2 = await r.load()
      for (const q of ['fix', 'login', 'vendor', 'ana']) expect(fresh(reloaded2, q, null), q).toEqual(r.index.search(q, null))
      expect(splitDoc(reloaded2)).toEqual(splitDoc(r.store.doc))
    })
  })


  // --- randomized: minimal writes, search/backlink coherence, overlapped edits ---------------------------------------

  const snap = (doc: Doc): Map<string, string> => new Map([...splitDoc(doc)].map(([path, v]) => [path, JSON.stringify(v)]))
  function changedRecords(before: Map<string, string>, after: Map<string, string>): { puts: number; dels: number } {
    let puts = 0, dels = 0
    for (const [path, json] of after) if (before.get(path) !== json) puts++
    for (const path of before.keys()) if (!after.has(path)) dels++
    return { puts, dels }
  }

  type Rnd = () => number
  const pick = <T,>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const anyOf = <T,>(rnd: Rnd, xs: readonly T[]): T | undefined => (xs.length ? pick(rnd, xs) : undefined)
  const RICH = { teams: 2, dailyNotes: 5, people: 4, actions: 6, milestones: 4, risks: 4 }

  interface FuzzCtx { offer: UndoOffer | null }
  /** `single`: a plain edit of one record, so exactly one record may be written. */
  interface FuzzOp { name: string; single: boolean; run: (store: Store, rnd: Rnd, ctx: FuzzCtx) => void }

  const FUZZ_OPS: FuzzOp[] = [
    { name: 'edit daily note', single: true, run: (s, r) => { s.update((d) => { const t = pick(r, d.teams); const k = Object.keys(t.dailyNotes); if (k.length) t.dailyNotes[pick(r, k)] = `daily ${r()} rollout` }, { sections: ['notes'] }) } },
    { name: 'edit general notes', single: true, run: (s, r) => { s.update((d) => { pick(r, d.teams).generalNotes = `general ${r()} vendor` }, { sections: ['notes'] }) } },
    { name: 'edit person notes', single: true, run: (s, r) => { s.update((d) => { const p = anyOf(r, d.teams.flatMap((t) => [...t.stakeholders, ...t.members])); if (p) p.notes = `notes ${r()} auditoria` }, { sections: ['people'] }) } },
    { name: 'rename person', single: true, run: (s, r) => { s.update((d) => { const p = anyOf(r, d.teams.flatMap((t) => [...t.stakeholders, ...t.members])); if (p) p.name = `Nome ${r()}` }, { sections: ['people'] }) } },
    { name: 'edit action item', single: true, run: (s, r) => { s.update((d) => { const a = anyOf(r, d.teams.flatMap((t) => t.actionItems)); if (a) a.notes = `an ${r()} entrega` }, { sections: ['actions'] }) } },
    { name: 'edit milestone', single: true, run: (s, r) => { s.update((d) => { const m = anyOf(r, d.teams.flatMap((t) => t.milestones)); if (m) m.followup = `mf ${r()} contrato` }, { sections: ['milestones'] }) } },
    { name: 'edit risk', single: true, run: (s, r) => { s.update((d) => { const x = anyOf(r, d.teams.flatMap((t) => t.risks)); if (x) x.title = `risco ${r()} incidente` }, { sections: ['risks'] }) } },
    { name: 'add action item', single: false, run: (s, r) => { s.update((d) => { pick(r, d.teams).actionItems.push({ id: `n${Math.floor(r() * 1e9)}`, summary: 'novo', notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 99 }) }, { sections: ['actions'] }) } },
    { name: 'delete action item with unlink', single: false, run: (s, r, c) => { const t = pick(r, s.doc.teams); if (t.actionItems.length) c.offer = deleteEntity(s, t.id, 'actionItems', pick(r, t.actionItems).id) } },
    { name: 'delete milestone with unlink', single: false, run: (s, r, c) => { const t = pick(r, s.doc.teams); if (t.milestones.length) c.offer = deleteEntity(s, t.id, 'milestones', pick(r, t.milestones).id) } },
    { name: 'delete risk with unlink', single: false, run: (s, r, c) => { const t = pick(r, s.doc.teams); if (t.risks.length) c.offer = deleteEntity(s, t.id, 'risks', pick(r, t.risks).id) } },
    { name: 'undo the last delete', single: false, run: (_s, _r, c) => { if (c.offer?.isAvailable()) c.offer.undo(); c.offer = null } },
    { name: 'reorder action items', single: false, run: (s, r) => { s.update((d) => { pick(r, d.teams).actionItems.reverse() }, { sections: ['actions'] }) } },
  ]

  const QUERIES = ['rollout', 'vendor', 'auditoria', 'entrega', 'contrato', 'incidente', 'novo', 'acao', 'nome', 'pessoa']

  describe.each([1, 2, 3, 4])('random edits, deletes and undos, seed %i', (seed) => {
    test('every flush writes exactly the records that changed, the copy equals the document, search and backlinks equal the uncached answer', async () => {
      const rnd = makeRng(seed * 104729)
      const r = await rig(buildRichDoc(RICH, seed))
      const ctx: FuzzCtx = { offer: null }
      for (let step = 0; step < 80; step++) {
        const op = pick(rnd, FUZZ_OPS)
        const where = `seed ${seed} step ${step} (${op.name})`
        const before = snap(r.store.doc)
        commits.length = 0
        op.run(r.store, rnd, ctx)
        await r.flush()

        const expected = changedRecords(before, snap(r.store.doc))
        const wrote = { puts: commits.reduce((n, b) => n + b.putRecords.length, 0), dels: commits.reduce((n, b) => n + b.deleteRecords.length, 0) }
        expect(wrote, `${where}: records written`).toEqual(expected)
        if (op.single && expected.puts > 0) expect(wrote, `${where}: a plain edit`).toEqual({ puts: 1, dels: 0 })
        expect(await r.load(), where).toEqual(JSON.parse(JSON.stringify(r.store.doc)))

        for (const q of [pick(rnd, QUERIES), pick(rnd, QUERIES)]) {
          const scope = rnd() < 0.5 ? pick(rnd, r.store.doc.teams).id : null
          expect(r.index.search(q, scope), `${where}: search "${q}"`).toEqual(searchDocument(r.store.doc, q, scope))
        }
        const oracle = createSearchIndex(() => r.store.doc, () => 0)
        for (const t of r.store.doc.teams) {
          const targets = [...t.actionItems.map((e) => ['action', e.id] as const), ...t.milestones.map((e) => ['milestone', e.id] as const), ...t.risks.map((e) => ['risk', e.id] as const)]
          for (const [kind, id] of targets) expect(r.index.backlinks(t.id, kind, id), `${where}: backlinks ${kind}:${id}`).toEqual(oracle.backlinks(t.id, kind, id))
        }
      }
    }, 60000)
  })

  test('the random sequence really edits, deletes and undoes (guard against an op list that silently does nothing)', async () => {
    const rnd = makeRng(7)
    const r = await rig(buildRichDoc(RICH, 7))
    const ctx: FuzzCtx = { offer: null }
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const op = pick(rnd, FUZZ_OPS)
      const before = JSON.stringify(r.store.doc)
      op.run(r.store, rnd, ctx)
      if (JSON.stringify(r.store.doc) !== before) seen.add(op.name)
    }
    for (const name of FUZZ_OPS.map((o) => o.name)) expect(seen.has(name), name).toBe(true)
  })

  describe('edits that overlap a commit being prepared', () => {
    // The race above, randomized: whatever lands during the commit and whatever is reverted after it, the copy ends equal to the document.
    test('the copy equals the document after random edit/revert patterns around an in-flight commit', async () => {
      const rnd = makeRng(31337)
      const r = await rig(buildRichDoc(RICH, 3))
      const find = (id: string) => r.store.doc.teams.flatMap((t) => t.actionItems).find((a) => a.id === id)
      for (let round = 0; round < 40; round++) {
        const target = pick(rnd, pick(rnd, r.store.doc.teams).actionItems)
        const id = target.id
        const original = target.notes
        let release!: () => void
        metaGate = new Promise<void>((res) => { release = res })
        r.store.update(() => { find(id)!.notes = `first ${round}` })
        const p = r.flush()
        await new Promise((res) => setTimeout(res, 2))
        const during = pick(rnd, ['none', 'other', 'same', 'delete'] as const)
        if (during === 'same') r.store.update(() => { find(id)!.notes = `during ${round}` })
        if (during === 'other') r.store.update(() => { const o = r.store.doc.teams.flatMap((t) => t.actionItems).find((a) => a.id !== id)!; o.notes = `${o.notes}!` })
        if (during === 'delete') deleteEntity(r.store, r.store.doc.teams.find((t) => t.actionItems.some((a) => a.id === id))!.id, 'actionItems', id)
        metaGate = null
        release()
        await p
        const after = pick(rnd, ['revert', 'toFirst', 'keep'] as const)
        if (after === 'revert' && find(id)) r.store.update(() => { find(id)!.notes = original })
        // Back to what the in-flight commit compared: the diff then sees no change from its cache.
        if (after === 'toFirst' && find(id)) r.store.update(() => { find(id)!.notes = `first ${round}` })
        await r.flush()
        expect(await r.load(), `round ${round} (${during}, ${after})`).toEqual(JSON.parse(JSON.stringify(r.store.doc)))
      }
    }, 60000)
  })

  describe('damaged documents', () => {
    test('two entities sharing an id: deleting the first rewrites the survivor under the first key (correct, not minimal)', async () => {
      const r = await rig()
      r.store.update((d) => { d.teams[0]!.actionItems.push({ ...d.teams[0]!.actionItems[0]!, summary: 'twin' }) })
      await r.flush()
      expect(await r.load()).toEqual(r.store.doc)
      commits.length = 0
      r.store.update((d) => { d.teams[0]!.actionItems.shift() })
      await r.flush()
      expect(commits).toHaveLength(1)
      // order record + the survivor taking over the first key; its old `~1` key goes.
      expect(commits[0]!.putRecords).toHaveLength(2)
      expect(commits[0]!.deleteRecords).toHaveLength(1)
      expect(await r.load()).toEqual(r.store.doc)
    })
  })

  if (password !== null) {
    test('no stored row reveals note text, a title or a date', async () => {
      const r = await rig()
      r.store.update((d) => { d.teams[0]!.actionItems[2]!.summary = 'zebra-unique-title' }, { teamId: 'T1', sections: ['actions'] })
      await r.flush()
      const all = (await rawDb.readAll(r.store.doc.docId)).records
      const walk = (v: unknown): string => ArrayBuffer.isView(v) ? String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : Array.isArray(v) ? v.map(walk).join(' ') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => k + walk(x)).join(' ') : String(v)
      const raw = walk(all)
      for (const secret of ['zebra-unique-title', 'talked about', '2026-10-01', 'vendor slip']) expect(raw.includes(secret), secret).toBe(false)
    })
  }
})
