// test/search-large-fields.test.ts — cost guard for documents holding a few
// very large free-text fields.
//
// Snippets are cut lazily, after ranking, so the search cache doesn't have to
// retain a markdown-stripped copy of every candidate (see
// test/search-memory.test.ts). That trade is right for ordinary notes — a
// couple of KB each, where re-stripping the handful of shown results costs
// well under a millisecond — and wrong for a 200 KB field, where stripping it
// again on every keystroke costs more than storing it ever did.
//
// So candidates above a size threshold keep their stripped text prepared, and
// only the small ones are stripped on demand. This test pins the resulting
// cost shape: on a document whose matches are all huge, a repeat query must
// be a small fraction of what building the index cost, not a re-run of a
// large part of it.
//
// Relative timing, not an absolute budget (same reasoning as
// test/search-backlinks-perf.test.ts): both numbers come from the same
// fixture on the same machine, back to back, and only their ratio is asserted.
import { createSearchIndex } from '../src/core/search'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

const HUGE_NOTE_COUNT = 60
// search() caps what it returns; every note here matches, so every query
// below hits that cap and pays a snippet for each of the 50 shown results.
const RESULT_LIMIT = 50
const WORDS_PER_NOTE = 12_000

let seed = 20260906
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const WORDS = ('rollout release blocker standup vendor contrato migracao incidente orcamento previsao reuniao '
  + 'decisao auditoria pendencia handover escalonamento dependencia').split(' ')
const paragraph = (n: number): string => {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!)
  return out.join(' ')
}

/** Notes big enough that stripping one is expensive, all matching the query below. */
function hugeNoteDoc(): Doc {
  const team: Team = {
    id: 't1', name: 'Alpha', emoji: '🧭', stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  for (let i = 0; i < HUGE_NOTE_COUNT; i++) {
    // The query term sits at the very start, so `indexOf` finds it
    // immediately and scanning costs nothing. What the timing below is left
    // measuring is the per-shown-result snippet work — the thing at issue.
    team.dailyNotes[`2026-01-01-${i}`] =
      `# entregavel ${paragraph(3)}\n${paragraph(WORDS_PER_NOTE)}\n- ${paragraph(8)}\n**${paragraph(4)}**`
  }
  const doc = createEmptyDocument('pt-BR')
  doc.teams.push(team)
  return doc
}

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

test('a repeat query over very large fields does not re-do a large share of the index build', () => {
  const doc = hugeNoteDoc()

  // Cold: prepare every candidate (stripMd + normalize over the whole corpus)
  // and answer one query.
  const coldMs = timeIt(() => {
    const fresh = createSearchIndex(() => doc, () => 0)
    expect(fresh.search('entregavel', null)).toHaveLength(RESULT_LIMIT)
  })

  const index = createSearchIndex(() => doc, () => 0)
  expect(index.search('entregavel', null)).toHaveLength(RESULT_LIMIT)
  // Warm: the candidates are already prepared, so this should be a scan plus
  // snippet assembly — never another pass of markdown stripping over
  // megabytes of note text.
  const warmMs = bestMs(5, () => { index.search('entregavel', null) })

  expect(warmMs).toBeLessThan(coldMs / 50)
})
