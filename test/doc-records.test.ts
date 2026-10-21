import { splitDoc, joinDoc, type DocRecords } from '../src/core/doc-records'
import { createEmptyDocument, createEmptyTeam, validateDoc } from '../src/core/document'
import { buildRichDoc, makeRng } from './search-fixture'
import type { Doc } from '../src/core/types'

const SMALL = { teams: 3, dailyNotes: 8, people: 4, actions: 6, milestones: 4, risks: 4 }
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const snap = (r: DocRecords): Map<string, string> => new Map([...r].map(([k, v]) => [k, JSON.stringify(v)]))

/** Paths whose serialized form differs (added, removed or changed). `sa` is a snapshot: entity records alias the live doc, so stringify before mutating. */
function changedPaths(sa: Map<string, string>, b: DocRecords): string[] {
  const sb = snap(b)
  const out: string[] = []
  for (const [k, v] of sb) if (sa.get(k) !== v) out.push(k)
  for (const k of sa.keys()) if (!sb.has(k)) out.push(k)
  return out.sort()
}

function populated(): Doc {
  const doc = buildRichDoc(SMALL, 7)
  doc.images = { ['a'.repeat(32)]: { mime: 'image/webp', w: 3, h: 4, bytes: 5 } }
  doc.favorites = [{ teamId: doc.teams[0]!.id, ref: { kind: 'general' } }]
  return doc
}

test('an empty document round-trips', () => {
  const doc = createEmptyDocument('en-US')
  expect(joinDoc(splitDoc(doc))).toEqual(doc)
})

test('a populated document round-trips and still validates', () => {
  const doc = populated()
  const back = joinDoc(splitDoc(doc))
  expect(back).toEqual(doc)
  expect(validateDoc(back)).toBeNull()
})

test('split does not mutate its input', () => {
  const doc = populated()
  const before = JSON.stringify(doc)
  splitDoc(doc)
  expect(JSON.stringify(doc)).toBe(before)
})

test('join tolerates records arriving in any map order', () => {
  const doc = populated()
  const entries = [...splitDoc(doc)]
  const rnd = makeRng(3)
  entries.sort(() => rnd() - 0.5)
  expect(joinDoc(new Map(entries))).toEqual(doc)
})

test('every record is JSON-safe: stringify then parse gives the same value', () => {
  for (const [, v] of splitDoc(populated())) expect(JSON.parse(JSON.stringify(v))).toEqual(v)
})

test('a team with no collections elements, empty daily notes and no generalNotes round-trips', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'T', '', 'en-US')
  delete team.generalNotes
  delete team.actionColumns
  doc.teams.push(team)
  const back = joinDoc(splitDoc(doc))
  expect(back).toEqual(doc)
  expect('generalNotes' in back.teams[0]!).toBe(false)
})

test('generalNotes empty string stays an empty string, distinct from undefined', () => {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(createEmptyTeam('T1', 'T', '', 'en-US'))
  expect(joinDoc(splitDoc(doc)).teams[0]!.generalNotes).toBe('')
})

test('empty-string daily notes and unicode survive', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Équipe ✓', '🙂', 'en-US')
  team.dailyNotes = { '2026-01-01': '', '2026-01-02': 'ação — 日本語 \u0000 "quoted"' }
  doc.teams.push(team)
  expect(joinDoc(splitDoc(doc))).toEqual(doc)
})

test('ids containing slashes or other path characters do not break addressing', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t/1?x', 'T', '', 'en-US')
  team.members.push({ id: 'a/b/c', name: 'P', role: '', parentId: null, order: 0, notes: '' })
  team.dailyNotes['2026-01-01'] = 'x'
  doc.teams.push(team)
  expect(joinDoc(splitDoc(doc))).toEqual(doc)
})

test('two entities sharing an id (a damaged file) do not collapse into one record', () => {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'T', '', 'en-US')
  const mk = (summary: string) => ({ id: 'dup', summary, notes: '', status: 'todo', dueDate: null, assignee: '', color: null, order: 0 })
  team.actionItems.push(mk('first'), mk('second'))
  doc.teams.push(team, { ...createEmptyTeam('T1', 'again', '', 'en-US') })
  const back = joinDoc(splitDoc(doc))
  expect(back).toEqual(doc)
  expect(back.teams.map((t) => t.name)).toEqual(['T', 'again'])
})

test('a scalar field added at runtime to the doc and to a team rides in the remainder records', () => {
  const doc = populated()
  ;(doc as unknown as Record<string, unknown>).future = { a: 1 }
  ;(doc.teams[1] as unknown as Record<string, unknown>).futureTeam = 'x'
  const back = joinDoc(splitDoc(doc)) as unknown as Record<string, unknown>
  expect(back.future).toEqual({ a: 1 })
  expect((back.teams as Doc['teams'])[1] as unknown as Record<string, unknown>).toMatchObject({ futureTeam: 'x' })
})

test('reordering two action items changes only the owning team record', () => {
  const doc = populated()
  const before = snap(splitDoc(doc))
  const team = doc.teams[1]!
  ;[team.actionItems[0], team.actionItems[1]] = [team.actionItems[1]!, team.actionItems[0]!]
  expect(changedPaths(before, splitDoc(doc))).toEqual([`team/${encodeURIComponent(team.id)}`])
})

test('editing one daily note changes exactly one record', () => {
  const doc = populated()
  const before = snap(splitDoc(doc))
  const team = doc.teams[0]!
  const date = Object.keys(team.dailyNotes)[0]!
  team.dailyNotes[date] += ' edited'
  expect(changedPaths(before, splitDoc(doc))).toEqual([`team/${encodeURIComponent(team.id)}/daily/${encodeURIComponent(date)}`])
})

test('editing one entity changes exactly that entity record; removing it also changes the order record', () => {
  const doc = populated()
  const before = snap(splitDoc(doc))
  const tk = encodeURIComponent(doc.teams[0]!.id)
  const risk = doc.teams[0]!.risks[0]!
  risk.title += '!'
  expect(changedPaths(before, splitDoc(doc))).toEqual([`team/${tk}/risks/${encodeURIComponent(risk.id)}`])
  doc.teams[0]!.risks.shift()
  expect(changedPaths(before, splitDoc(doc))).toEqual([`team/${tk}`, `team/${tk}/risks/${encodeURIComponent(risk.id)}`])
})

test('splitting twice gives byte-identical records', () => {
  const doc = populated()
  expect(snap(splitDoc(doc))).toEqual(snap(splitDoc(clone(doc))))
})

test('seeded fuzz: random structural edits always round-trip', () => {
  const rnd = makeRng(99)
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!
  for (let n = 0; n < 200; n++) {
    const doc = buildRichDoc({ ...SMALL, teams: 1 + (n % 3) }, n + 1)
    for (let step = 0; step < 6; step++) {
      const team = pick(doc.teams)
      switch (Math.floor(rnd() * 8)) {
        case 0: team.actionItems.reverse(); break
        case 1: team.members.length = 0; break
        case 2: team.dailyNotes[`2027-0${1 + Math.floor(rnd() * 9)}-0${1 + Math.floor(rnd() * 9)}`] = rnd() < 0.3 ? '' : `ñ ${rnd()}`; break
        case 3: delete team.generalNotes; break
        case 4: team.generalNotes = rnd() < 0.5 ? '' : 'notes ✓'; break
        case 5: doc.teams.reverse(); break
        case 6: doc.templates.push({ id: `tpl${n}-${step}`, name: 'T', scope: 'any', body: '' }); break
        default: team.milestones.splice(0, 1); break
      }
    }
    expect(joinDoc(splitDoc(doc))).toEqual(doc)
  }
})
