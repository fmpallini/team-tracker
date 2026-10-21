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
import { buildRichDoc, makeRng } from './search-fixture'
import type { Doc } from '../src/core/types'

const SHAPE = { teams: 3, dailyNotes: 6, people: 4, actions: 6, milestones: 4, risks: 4 }
const OPS = 300

afterEach(() => { vi.unstubAllGlobals() })

test(`after each of ${OPS} random operations the browser copy equals the live document`, async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const rnd = makeRng(20261021)
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const db = await openLiveDb(new IDBFactory())
  const doc = buildRichDoc(SHAPE, 11)
  const store = createStore(doc, createImageStore(null))
  const live = createLiveStore(db, doc.docId, null)
  const persister = await createLivePersister({ store, live, fileName: 'f.tmv', schedule: () => () => {} })
  let imageSeq = 0
  const log: string[] = []

  for (let op = 0; op < OPS; op++) {
    const team = () => pick(store.doc.teams)
    const kind = Math.floor(rnd() * 12)
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
    const loaded = await createLiveStore(db, doc.docId, null).load()
    const back = joinDoc(loaded.records)
    // toEqual would swallow a missing-vs-undefined difference only for undefined fields, which JSON cannot carry anyway.
    expect(back, `after op ${op} (${log.at(-1)})`).toEqual(JSON.parse(JSON.stringify(store.doc)))
    for (const id of Object.keys(store.doc.images)) {
      if (store.images.has(id)) expect(loaded.blobs.has(id), `blob ${id} after op ${op} (${log.at(-1)})`).toBe(true)
    }
  }
}, 120000)
