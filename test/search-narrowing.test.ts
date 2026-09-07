// test/search-narrowing.test.ts — SearchIndex.search()'s prefix narrowing.
//
// Typing into the search box issues one search() per (debounced) keystroke,
// and each of those is a full scan over every prepared candidate in scope.
// But extending a query can only shrink the match set: every term of the old
// query is a prefix of the term in the same position of the new one, so a
// candidate the old query rejected cannot pass the new one. When the new
// query extends the previous one, the index therefore re-scores only the
// previous query's matches instead of walking the whole document again.
//
// The first test is a relative-timing comparison, not an absolute budget, so
// it stays meaningful on slower and faster machines: the *same* index runs
// the *same* queries in the *same* order twice, and the only difference is
// whether narrowing was allowed to engage. Everything after it pins down the
// correctness properties narrowing must not break.
import { createSearchIndex } from '../src/core/search'
import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

const emptyTeam = (id: string, name: string): Team => ({
  id, name, emoji: '🧭', stakeholders: [], members: [],
  actionItems: [], milestones: [], risks: [], dailyNotes: {},
})

// ── the large fixture, for the timing comparison ──────────────────────────

const NOTE_COUNT = 4000
const RARE = 'quixotesco'
// Only a handful of notes carry the rare token. Keeping the match set small
// keeps the comparison about the scan itself: every search() also cuts a
// snippet per shown result, and that fixed cost is paid identically whether
// the hits came from a full scan or from narrowing.
const RARE_EVERY = 800
const RARE_HITS = NOTE_COUNT / RARE_EVERY

// Deliberately free of q/k/w/y, so no filler word accidentally matches a
// prefix of RARE and dilutes the narrowing being measured.
const WORDS = ('rollout release blocker standup vendor contrato migracao incidente orcamento previsao reuniao '
  + 'decisao auditoria pendencia handover escalonamento dependencia entrega').split(' ')

let seed = 20260906
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const paragraph = (n: number): string => {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!)
  return out.join(' ')
}

function bigDoc(): Doc {
  const team = emptyTeam('t1', 'Alpha')
  for (let i = 0; i < NOTE_COUNT; i++) {
    const body = `# ${paragraph(3)}\n${paragraph(90)}\n- ${paragraph(8)}`
    team.dailyNotes[`2026-01-01-${i}`] = i % RARE_EVERY === 0 ? `${body} ${RARE} pendente` : body
  }
  const doc = createEmptyDocument('pt-BR')
  doc.teams.push(team)
  return doc
}

/** Every prefix of `RARE`, shortest first — what typing it one character at a time issues. */
const prefixes = Array.from({ length: RARE.length }, (_, i) => RARE.slice(0, i + 1))

function timeIt(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/** Best of `reps` runs — the minimum is the sample least polluted by a GC pause landing mid-measurement. */
function bestMs(reps: number, fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < reps; i++) best = Math.min(best, timeIt(fn))
  return best
}

test('typing a query forward costs far less than issuing the same queries with narrowing suppressed', () => {
  const doc = bigDoc()
  const index = createSearchIndex(() => doc, () => 0)
  // Warm the prepared-candidate cache so neither measurement pays for it.
  expect(index.search(RARE, null)).toHaveLength(RARE_HITS)

  // A query no prefix of RARE extends, used to clear the narrowing state
  // between measured queries. It matches nothing, so it costs nothing itself.
  const suppressNarrowing = (): void => { index.search('zzz-suppress-zzz', null) }

  // Same queries, same order, but narrowing is denied to every one of them —
  // ten full scans.
  const suppressed = bestMs(3, () => {
    for (const q of prefixes) {
      suppressNarrowing()
      index.search(q, null)
    }
  })
  // The real typing shape: one full scan, then nine re-scores of a match set
  // that is already tiny after the first keystroke.
  const narrowed = bestMs(3, () => {
    suppressNarrowing()
    for (const q of prefixes) index.search(q, null)
  })

  // Generous margin (not a tight bound), same reasoning as
  // test/search-backlinks-perf.test.ts: near-parity means narrowing never
  // engaged. Measured ratio is ~0.2.
  expect(narrowed).toBeLessThan(suppressed / 3)
})

// ── correctness ───────────────────────────────────────────────────────────

/** Types `query` one character at a time, returning what the final keystroke produced. */
function typeOut(index: ReturnType<typeof createSearchIndex>, query: string, scopeTeamId: string | null = null) {
  let last = index.search(query.slice(0, 1), scopeTeamId)
  for (let i = 2; i <= query.length; i++) last = index.search(query.slice(0, i), scopeTeamId)
  return last
}

function docWithNotes(notes: string[], teamId = 't1', teamName = 'Alpha'): Doc {
  const team = emptyTeam(teamId, teamName)
  notes.forEach((note, i) => { team.dailyNotes[`2026-05-${String(i + 1).padStart(2, '0')}`] = note })
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  return doc
}

test('a query reached by typing returns exactly what the same query returns cold', () => {
  const doc = docWithNotes([
    'deploy the **release** today',
    'release notes for the deploy window',
    'unrelated standup chatter',
    'a later mention of release, further into a much longer note body here',
  ])
  const typed = typeOut(createSearchIndex(() => doc, () => 0), 'release')
  const cold = createSearchIndex(() => doc, () => 0).search('release', null)

  expect(typed).toEqual(cold)
})

test('adding a second term to a typed query keeps matching cold results, ranking included', () => {
  const doc = docWithNotes([
    'release deploy happen together right here',
    'release ... and much later in this same note, the word deploy appears',
    'release alone with no second term at all',
  ])
  const typed = typeOut(createSearchIndex(() => doc, () => 0), 'release deploy')
  const cold = createSearchIndex(() => doc, () => 0).search('release deploy', null)

  expect(typed).toHaveLength(2)
  expect(typed).toEqual(cold)
})

test('extending a query can surface a match that ranked outside the base query\'s shown results', () => {
  // 60 notes match "alpha" at position 0; the target matches it far later, so
  // for the single-term query it ranks last — past the 50-result cut. Only
  // the target also contains "omega".
  const notes: string[] = []
  for (let i = 0; i < 60; i++) notes.push(`alpha filler note number ${i}`)
  notes.push(`${'padding words to push the match late '.repeat(20)} alpha omega`)
  const doc = docWithNotes(notes)
  const index = createSearchIndex(() => doc, () => 0)

  const base = index.search('alpha', null)
  expect(base).toHaveLength(50)
  expect(base.some((r) => r.snippet.includes('omega'))).toBe(false)

  // Narrowing must re-score the *complete* match set, not the 50 that were
  // shown — otherwise the target is gone for every query that follows.
  const narrowed = index.search('alpha omega', null)
  expect(narrowed).toHaveLength(1)
  expect(narrowed[0]!.snippet).toContain('omega')
})

test('backspacing to a shorter query re-scans instead of reusing the longer query\'s matches', () => {
  const doc = docWithNotes([
    'rollout of the new plan',
    'roll call for the standup',
  ])
  const index = createSearchIndex(() => doc, () => 0)

  expect(index.search('rollout', null)).toHaveLength(1)
  // "roll" does not extend "rollout" — the second note has to come back.
  expect(index.search('roll', null)).toHaveLength(2)
})

test('the same query under a different scope re-scans instead of reusing the narrower scope\'s matches', () => {
  const doc = createEmptyDocument('en-US')
  const t1 = emptyTeam('t1', 'Alpha'), t2 = emptyTeam('t2', 'Beta')
  t1.dailyNotes['2026-05-01'] = 'shared word here'
  t2.dailyNotes['2026-05-01'] = 'shared word there'
  doc.teams.push(t1, t2)
  const index = createSearchIndex(() => doc, () => 0)

  expect(index.search('shared', 't1')).toHaveLength(1)
  // Same query text, wider scope: t2's candidate was never considered, so
  // this cannot be answered from t1's hits.
  expect(index.search('shared', null)).toHaveLength(2)
})

test('an edit between keystrokes is reflected, not answered from the pre-edit matches', () => {
  const doc = docWithNotes(['rollout of the new plan', 'unrelated chatter'])
  const store = createStore(doc)
  const index = createSearchIndex(() => store.doc, () => store.rev)
  store.subscribe((scope) => index.invalidate(scope))

  expect(index.search('rollout', null)).toHaveLength(1)

  store.update((d) => {
    d.teams[0]!.dailyNotes['2026-05-02'] = 'rollout zeta phase begins'
  }, { teamId: 't1', sections: ['notes'] })

  // "rollout z" extends "rollout", but the only note matching it did not
  // exist when those matches were collected. ("z" appears nowhere in the
  // original notes, so a stale hit set answers this with nothing.)
  expect(index.search('rollout z', null)).toHaveLength(1)
  expect(index.search('rollout', null)).toHaveLength(2)
})

test('an edit that removes a match is reflected when the query is extended', () => {
  const doc = docWithNotes(['rollout of the new plan', 'rollout zeta phase begins'])
  const store = createStore(doc)
  const index = createSearchIndex(() => store.doc, () => store.rev)
  store.subscribe((scope) => index.invalidate(scope))

  expect(index.search('rollout', null)).toHaveLength(2)

  store.update((d) => {
    d.teams[0]!.dailyNotes['2026-05-02'] = 'nothing of interest anymore'
  }, { teamId: 't1', sections: ['notes'] })

  // A stale hit set would still be holding the pre-edit note and answer 1.
  expect(index.search('rollout z', null)).toHaveLength(0)
})

test('typing an accented word narrows through its unaccented prefixes', () => {
  const doc = docWithNotes(['pauta da **reunião** de terça', 'sem relação com o assunto'])
  const index = createSearchIndex(() => doc, () => 0)

  const typed = typeOut(index, 'Reunião')
  expect(typed).toHaveLength(1)
  // The snippet still comes from markdown-stripped text, cut lazily after
  // ranking — narrowing must not change how it reads.
  expect(typed[0]!.snippet).toContain('reunião')
  expect(typed[0]!.snippet).not.toContain('**')
})

test('a query typed after one that matched nothing still finds its own matches', () => {
  const doc = docWithNotes(['rollout of the new plan'])
  const index = createSearchIndex(() => doc, () => 0)

  expect(index.search('zzz', null)).toHaveLength(0)
  // "zzzz" extends "zzz" (still nothing), but "rollout" does not — it must
  // not be answered from an empty hit set.
  expect(index.search('zzzz', null)).toHaveLength(0)
  expect(index.search('rollout', null)).toHaveLength(1)
})

test('two indexes over the same document narrow independently', () => {
  const doc = docWithNotes(['rollout of the new plan', 'roll call for the standup'])
  const first = createSearchIndex(() => doc, () => 0)
  const second = createSearchIndex(() => doc, () => 0)

  expect(first.search('rollout', null)).toHaveLength(1)
  // `second` has no narrowing state of its own; "rollout" on `first` must not
  // constrain it.
  expect(second.search('roll', null)).toHaveLength(2)
})
