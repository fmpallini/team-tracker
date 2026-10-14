// test/search-differential.test.ts — the incremental SearchIndex against an oracle.
//
// The index keeps prepared candidates and mention scans alive across edits and
// decides what to reuse by comparing text. That is only safe if, whatever
// happens to the document, it answers exactly as an index with no cache at all
// would. This test drives a real Store through long random sequences of the
// edits the app performs — every field kind, adds and deletes, renames, team
// add/delete/restore, locale and other preference changes, unscoped updates,
// nav-only mutations, whole-document replacement — each with the scope the
// real call sites use, and after every step compares:
//
//  - search(): `searchDocument` (the uncached path) for a mix of whole-document
//    and single-team queries, including a typed-forward prefix run so the
//    narrowing shortcut is exercised across edits;
//  - backlinks(): a brand-new index over the same document.
//
// Results, order, titles, snippets and team names must all be identical. The
// seeds are fixed, so a failure reproduces; the message carries seed and step.
import { createSearchIndex, searchDocument, type SearchIndex } from '../src/core/search'
import { createStore, type Store } from '../src/core/store'
import { createEmptyTeam } from '../src/core/document'
import type { Section } from '../src/core/scope'
import type { Doc, Team } from '../src/core/types'
import { buildRichDoc, makeRng, sentence, type RichDocShape } from './search-fixture'

const SHAPE: RichDocShape = { teams: 4, dailyNotes: 14, people: 5, actions: 10, milestones: 6, risks: 6 }
const STEPS = 120
// Each step re-runs the uncached oracle over the whole document, so a long run is
// real work; the explicit timeout keeps a loaded CI runner from failing it on time alone.
const TIMEOUT_MS = 60_000
const SEEDS = [1, 2, 3, 4, 5, 6]

type Rnd = () => number
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
const int = (rnd: Rnd, n: number): number => Math.floor(rnd() * n)

/** Fresh text for a field: ordinary words, sometimes accented, sometimes a mention of something that exists right now. */
function text(rnd: Rnd, team: Team): string {
  const parts = [sentence(rnd, 4 + int(rnd, 12))]
  if (rnd() < 0.5 && team.actionItems.length > 0) parts.push(`@[${sentence(rnd, 1)}](action:${pick(rnd, team.actionItems).id})`)
  if (rnd() < 0.3 && team.risks.length > 0) parts.push(`@[r](risk:${pick(rnd, team.risks).id})`)
  if (rnd() < 0.3 && team.milestones.length > 0) parts.push(`@[m](milestone:${pick(rnd, team.milestones).id})`)
  if (rnd() < 0.3) parts.push(`@[p](person:${pick(rnd, [...team.stakeholders, ...team.members, { id: 'ghost' }]).id})`)
  if (rnd() < 0.2) parts.push('# heading **bold** ~~gone~~ *it*')
  if (rnd() < 0.1) parts.push('x'.repeat(5000) + ' bigfield') // above the eager-strip threshold
  return parts.join(rnd() < 0.5 ? ' ' : '\n')
}

interface Op { name: string; run: (store: Store, rnd: Rnd) => void }

const teamOf = (store: Store, rnd: Rnd): Team => pick(rnd, store.doc.teams)
const scoped = (store: Store, team: Team, sections: readonly Section[], fn: (d: Doc, t: Team) => void): void => {
  store.update((d) => { fn(d, d.teams.find((t) => t.id === team.id)!) }, { teamId: team.id, sections })
}

const OPS: Op[] = [
  { name: 'edit daily note', run: (s, r) => { const t = teamOf(s, r); const keys = Object.keys(t.dailyNotes); if (keys.length) { const k = pick(r, keys); scoped(s, t, ['notes'], (_, tm) => { tm.dailyNotes[k] = text(r, tm) }) } } },
  { name: 'add daily note', run: (s, r) => { const t = teamOf(s, r); scoped(s, t, ['notes'], (_, tm) => { tm.dailyNotes[`2040-${String(1 + int(r, 12)).padStart(2, '0')}-${String(1 + int(r, 28)).padStart(2, '0')}`] = text(r, tm) }) } },
  { name: 'delete daily note', run: (s, r) => { const t = teamOf(s, r); const keys = Object.keys(t.dailyNotes); if (keys.length) { const k = pick(r, keys); scoped(s, t, ['notes'], (_, tm) => { delete tm.dailyNotes[k] }) } } },
  { name: 'edit general notes', run: (s, r) => { const t = teamOf(s, r); scoped(s, t, ['notes'], (_, tm) => { tm.generalNotes = text(r, tm) }) } },
  { name: 'edit person notes', run: (s, r) => { const t = teamOf(s, r); const all = [...t.stakeholders, ...t.members]; if (all.length) { const id = pick(r, all).id; scoped(s, t, ['people'], (_, tm) => { [...tm.stakeholders, ...tm.members].find((p) => p.id === id)!.notes = text(r, tm) }) } } },
  { name: 'rename person', run: (s, r) => { const t = teamOf(s, r); const all = [...t.stakeholders, ...t.members]; if (all.length) { const id = pick(r, all).id; scoped(s, t, ['people'], (_, tm) => { [...tm.stakeholders, ...tm.members].find((p) => p.id === id)!.name = `Nome ${int(r, 99)} Ç` }) } } },
  { name: 'change person role', run: (s, r) => { const t = teamOf(s, r); const all = [...t.stakeholders, ...t.members]; if (all.length) { const id = pick(r, all).id; scoped(s, t, ['people'], (_, tm) => { [...tm.stakeholders, ...tm.members].find((p) => p.id === id)!.role = pick(r, ['', 'Eng', 'Líder Técnico', 'Diretora']) }) } } },
  { name: 'edit action item', run: (s, r) => { const t = teamOf(s, r); if (t.actionItems.length) { const id = pick(r, t.actionItems).id; const field = pick(r, ['summary', 'assignee', 'notes'] as const); scoped(s, t, ['actions'], (_, tm) => { tm.actionItems.find((a) => a.id === id)![field] = text(r, tm) }) } } },
  { name: 'add action item', run: (s, r) => { const t = teamOf(s, r); const id = `new-a${int(r, 1e6)}`; scoped(s, t, ['actions'], (_, tm) => { tm.actionItems.push({ id, summary: text(r, tm), status: 'todo', color: 'ledger', dueDate: null, assignee: 'Zé', order: 99, notes: text(r, tm) }) }) } },
  { name: 'delete action item', run: (s, r) => { const t = teamOf(s, r); if (t.actionItems.length) { const id = pick(r, t.actionItems).id; scoped(s, t, ['actions'], (_, tm) => { tm.actionItems = tm.actionItems.filter((a) => a.id !== id) }) } } },
  { name: 'edit milestone', run: (s, r) => { const t = teamOf(s, r); if (t.milestones.length) { const id = pick(r, t.milestones).id; const field = pick(r, ['title', 'followup'] as const); scoped(s, t, ['milestones'], (_, tm) => { tm.milestones.find((m) => m.id === id)![field] = text(r, tm) }) } } },
  { name: 'delete milestone', run: (s, r) => { const t = teamOf(s, r); if (t.milestones.length) { const id = pick(r, t.milestones).id; scoped(s, t, ['milestones'], (_, tm) => { tm.milestones = tm.milestones.filter((m) => m.id !== id) }) } } },
  { name: 'edit risk', run: (s, r) => { const t = teamOf(s, r); if (t.risks.length) { const id = pick(r, t.risks).id; const field = pick(r, ['title', 'followup'] as const); scoped(s, t, ['risks'], (_, tm) => { tm.risks.find((x) => x.id === id)![field] = text(r, tm) }) } } },
  { name: 'add risk', run: (s, r) => { const t = teamOf(s, r); const id = `new-r${int(r, 1e6)}`; scoped(s, t, ['risks'], (_, tm) => { tm.risks.push({ id, title: text(r, tm), chance: 1, impact: 1, plan: 'accept', followup: '', order: 99, closed: false }) }) } },
  { name: 'rename team', run: (s, r) => { const t = teamOf(s, r); scoped(s, t, ['teams'], (_, tm) => { tm.name = `Equipe ${int(r, 999)}` }) } },
  { name: 'add team', run: (s, r) => { s.update((d) => { const t = createEmptyTeam(`nt${int(r, 1e6)}`, 'Nova', '🆕', d.prefs.locale); t.generalNotes = sentence(r, 8); d.teams.push(t) }, { sections: ['teams'] }) } },
  { name: 'delete team', run: (s, r) => { if (s.doc.teams.length > 1) { const id = teamOf(s, r).id; s.update((d) => { d.teams = d.teams.filter((t) => t.id !== id) }, { sections: ['teams'] }) } } },
  { name: 'restore a deleted team id with new content', run: (s, r) => { if (s.doc.teams.length > 1) { const gone = teamOf(s, r); s.update((d) => { d.teams = d.teams.filter((t) => t.id !== gone.id) }, { sections: ['teams'] }); s.update((d) => { d.teams.push({ ...gone, generalNotes: text(r, gone) }) }, { sections: ['teams'] }) } } },
  { name: 'flip locale', run: (s) => { s.update((d) => { d.prefs.locale = d.prefs.locale === 'pt-BR' ? 'en-US' : 'pt-BR' }, { sections: ['prefs'] }) } },
  { name: 'font size', run: (s) => { s.update((d) => { d.prefs.fontSize = d.prefs.fontSize === 'M' ? 'XL' : 'M' }, { sections: ['prefs'] }) } },
  { name: 'template edit', run: (s, r) => { s.update((d) => { d.templates.push({ id: `tp${int(r, 1e6)}`, name: 'T', scope: 'any', body: sentence(r, 3) }) }, { sections: ['templates'] }) } },
  { name: 'unscoped edit', run: (s, r) => { const t = teamOf(s, r); s.update((d) => { d.teams.find((x) => x.id === t.id)!.generalNotes = text(r, t) }) } },
  { name: 'unscoped no-op', run: (s) => { s.update(() => {}) } },
  { name: 'nav mutation', run: (s) => { s.updateNav((d) => { d.nav.focusedPane = d.nav.focusedPane === 0 ? 1 : 0 }) } },
  { name: 'move action item between teams (unscoped)', run: (s, r) => { const [a, b] = [teamOf(s, r), teamOf(s, r)]; if (a.id !== b.id && a.actionItems.length) s.update((d) => { const from = d.teams.find((t) => t.id === a.id)!; d.teams.find((t) => t.id === b.id)!.actionItems.push(...from.actionItems.splice(0, 1)) }) } },
  { name: 'replace whole document', run: (s, r) => { if (r() < 0.15) s.replaceDoc(buildRichDoc({ ...SHAPE, teams: 1 + int(r, 4) }, int(r, 1e6))) } },
]

function queriesFor(store: Store, rnd: Rnd): string[] {
  const t = store.doc.teams[0]
  const probe = t ? (Object.values(t.dailyNotes)[0] ?? t.generalNotes ?? '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3) : []
  const word = probe.length ? pick(rnd, probe) : 'rollout'
  return [pick(rnd, ['rollout', 'acao', 'ação', 'reuniao', 'decisao auditoria', 'diretora', 'tecnico', 'nome', 'bigfield', 'heading', 'gone']), word, `${word} ${pick(rnd, ['entrega', 'cafe', 'stand'])}`]
}

function checkSearch(store: Store, index: SearchIndex, rnd: Rnd, where: string): void {
  for (const q of queriesFor(store, rnd)) {
    // A typed-forward run, so narrowing is tried against the freshly edited document.
    for (let n = Math.min(3, q.length); n <= q.length; n += Math.max(1, Math.floor(q.length / 3))) {
      const prefix = q.slice(0, n)
      const scope = rnd() < 0.4 ? pick(rnd, store.doc.teams).id : null
      expect(index.search(prefix, scope), `${where}: search "${prefix}" scope ${scope}`).toEqual(searchDocument(store.doc, prefix, scope))
    }
  }
  // A scope naming a team the document no longer has.
  expect(index.search('rollout', 'no-such-team'), where).toEqual([])
}

function checkBacklinks(store: Store, index: SearchIndex, where: string): void {
  const fresh = createSearchIndex(() => store.doc, () => 0)
  for (const t of store.doc.teams) {
    const targets: [Parameters<SearchIndex['backlinks']>[1], string][] = [
      ...t.actionItems.map((a): [Parameters<SearchIndex['backlinks']>[1], string] => ['action', a.id]),
      ...t.milestones.map((m): [Parameters<SearchIndex['backlinks']>[1], string] => ['milestone', m.id]),
      ...t.risks.map((x): [Parameters<SearchIndex['backlinks']>[1], string] => ['risk', x.id]),
      ...[...t.stakeholders, ...t.members].map((p): [Parameters<SearchIndex['backlinks']>[1], string] => ['person', p.id]),
      ['person', 'ghost'],
    ]
    for (const [kind, id] of targets) {
      expect(index.backlinks(t.id, kind, id), `${where}: backlinks ${t.id} ${kind}:${id}`).toEqual(fresh.backlinks(t.id, kind, id))
    }
    for (const date of Object.keys(t.dailyNotes).slice(0, 4)) {
      expect(index.backlinks(t.id, 'day', date), `${where}: backlinks ${t.id} day:${date}`).toEqual(fresh.backlinks(t.id, 'day', date))
    }
  }
}

describe.each(SEEDS)('random edit sequences, seed %i', (seed) => {
  test(`${STEPS} steps agree with the uncached oracle after every step`, () => {
    const rnd = makeRng(seed * 7919)
    const store = createStore(buildRichDoc(SHAPE, seed))
    const index = createSearchIndex(() => store.doc, () => store.rev)
    store.subscribe((scope) => index.invalidate(scope))
    store.onMutate((kind) => { if (kind === 'nav') index.acknowledgeNav() })

    checkSearch(store, index, rnd, `seed ${seed} start`)
    checkBacklinks(store, index, `seed ${seed} start`)
    for (let step = 0; step < STEPS; step++) {
      const op = pick(rnd, OPS)
      const where = `seed ${seed} step ${step} (${op.name})`
      op.run(store, rnd)
      // Sometimes read nothing for a few edits, so several changes pile up
      // between reads — the stale flag has to survive that.
      if (rnd() < 0.3) continue
      checkSearch(store, index, rnd, where)
      if (step % 4 === 0) checkBacklinks(store, index, where)
    }
    checkSearch(store, index, rnd, `seed ${seed} end`)
    checkBacklinks(store, index, `seed ${seed} end`)
  }, TIMEOUT_MS)
})

test('the fixture sequence actually exercises edits (guard against an op list that silently does nothing)', () => {
  const rnd = makeRng(99)
  const store = createStore(buildRichDoc(SHAPE, 99))
  const before = JSON.stringify(store.doc.teams)
  for (let i = 0; i < 40; i++) pick(rnd, OPS).run(store, rnd)
  expect(JSON.stringify(store.doc.teams)).not.toBe(before)
  expect(store.rev).toBeGreaterThan(20)
})
