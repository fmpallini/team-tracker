// test/search-memory.test.ts — retention guard for the search cache.
//
// createSearchIndex keeps a prepared copy of every searchable field so a
// keystroke doesn't re-run stripMd/normalize over the whole document. That
// cache is the app's single largest allocation on a big document — measured
// at ~3 bytes per corpus character, roughly 2.5x the document's own strings —
// so how many *derived copies* of the corpus it retains is a property worth
// pinning down, not just a benchmark number.
//
// One derived copy (the normalized text a query matches against) is
// unavoidable. A second retained copy (the markdown-stripped text, needed
// only to cut a snippet for the handful of results actually shown) is not.
//
// Why the fixture must be accented and mixed-case: `normalize` is
// NFD -> strip combining marks -> lowercase, and every one of those steps
// returns the *same string object* when it changes nothing. An all-lowercase
// unaccented corpus therefore makes the cache look nearly free, and this test
// would pass no matter what the implementation retained.
//
// Turns on V8's gc hook from inside the worker rather than needing an
// --expose-gc on the vitest command line, so `npm test` measures the same
// thing with no extra setup.
import v8 from 'node:v8'
import vm from 'node:vm'
import { createSearchIndex } from '../src/core/search'
import { createEmptyDocument } from '../src/core/document'
import type { Doc, Team } from '../src/core/types'

v8.setFlagsFromString('--expose_gc')
const collect = vm.runInNewContext('gc') as () => void

// Ordinary note sizes on purpose (~2 KB each). Fields at or above
// search.ts's EAGER_STRIP_MIN keep their stripped copy by design — that is
// the large-field trade guarded by test/search-large-fields.test.ts — so a
// fixture built from oversized notes would be measuring the exception rather
// than the rule.
const CANDIDATES = 6000
const WORDS_PER_NOTE = 100

/**
 * Heap in use, collected to a fixed point. A single gc() is not enough: V8
 * collects incrementally, and an under-collected baseline reads back as an
 * impossibly small delta.
 */
function heap(): number {
  let previous = Infinity
  for (let i = 0; i < 12; i++) {
    collect()
    const used = process.memoryUsage().heapUsed
    if (Math.abs(used - previous) < previous * 0.005) return used
    previous = used
  }
  return previous
}

// Deterministic (seeded LCG) so the corpus is byte-identical across runs.
let seed = 20260906
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const WORDS = ('Rollout release Blocker standup Vendor contrato renovação Migração incidente orçamento previsão '
  + 'reunião decisão Auditoria pendência handover Escalonamento dependência').split(' ')
const paragraph = (n: number): string => {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]!)
  return out.join(' ')
}
// Every markdown form stripMd handles, so the stripped text really does
// differ from the raw text (a corpus with no markdown would let stripMd
// return its input unchanged and share storage with it).
const noteBody = (): string =>
  `# ${paragraph(3)}\n${paragraph(WORDS_PER_NOTE)}\n- ${paragraph(8)}\n**${paragraph(4)}** ${paragraph(WORDS_PER_NOTE)}`

function bigTeam(): Team {
  const team: Team = {
    id: 't1', name: 'Alpha', emoji: '🧭', stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
  }
  for (let i = 0; i < CANDIDATES; i++) {
    team.dailyNotes[`2026-01-01-${i}`] = noteBody()
  }
  return team
}

function corpusChars(team: Team): number {
  let chars = 0
  for (const note of Object.values(team.dailyNotes)) chars += note.length
  // generalNotes is undefined here, but collectCandidates still emits it as
  // an empty candidate — no characters either way.
  return chars
}

/** Heap the warm search cache retains, per character of corpus it was built from. */
function cacheBytesPerChar(): number {
  const doc: Doc = createEmptyDocument('pt-BR')
  const team = bigTeam()
  doc.teams.push(team)
  const chars = corpusChars(team)

  const before = heap()
  const index = createSearchIndex(() => doc, () => 0)
  // A query that matches nothing still forces the full prepare pass, so the
  // measurement covers the cache alone with no result objects retained.
  expect(index.search('zzzzz-no-such-term', 't1')).toEqual([])
  const after = heap()
  // Keep the index reachable across the second reading, or the cache we are
  // trying to weigh is collectible garbage by the time gc() runs.
  expect(index.search('zzzzz-no-such-term', 't1')).toEqual([])

  return (after - before) / chars
}

test('the warm search cache retains one derived copy of the corpus, not two', () => {
  // Two retained copies measured ~3.0 bytes/char (a Latin-1 stripped copy at
  // ~1, plus the normalized copy). One copy is ~2.0 at worst — see the test
  // below for why it is now lower still. The 2.5 threshold sits between the
  // one-copy and two-copy worlds with room to spare on either side.
  expect(cacheBytesPerChar()).toBeLessThan(2.5)
})

test('the retained copy stays one byte per character for accented Latin text', () => {
  // Portuguese accented letters are all Latin-1, so a note is a one-byte
  // string on the heap. NFD decomposes them into combining marks outside
  // Latin-1, which forces V8's two-byte representation — and mark-stripping
  // does not undo it, so the normalized copy stayed twice the size of the
  // text it came from. `normalize` folds Latin-1 accents directly for exactly
  // this reason, keeping the one copy it retains one byte wide.
  expect(cacheBytesPerChar()).toBeLessThan(1.6)
})
