// scripts/bench-search.mjs — measurement harness for the search path's cost
// shape. Answers three questions with numbers instead of guesses:
//
//   1. How big does a real document actually get (JSON bytes, searchable
//      characters, retained heap)?
//   2. How much heap does the search cache add on top of the document —
//      i.e. how many derived copies of the corpus we retain per candidate.
//   3. What does a keystroke cost on a warm index, and does narrowing an
//      already-typed query cost less than starting a fresh one?
//
// Dev-only, never bundled into dist/ (same status as scripts/build.mjs, and
// like it, untested — it measures, it doesn't ship behavior).
//
// Usage:
//   node scripts/bench-search.mjs                  # synthetic scales
//   node scripts/bench-search.mjs path/to/file.tmv # a real document
//   TMV_PASSWORD=... node scripts/bench-search.mjs path/to/encrypted.tmv
//
// Re-execs itself with --expose-gc when needed: without a forced collection
// the heap deltas below are dominated by uncollected garbage from stripMd's
// own intermediates and mean nothing.
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

if (typeof globalThis.gc !== 'function') {
  const r = spawnSync(process.execPath, ['--expose-gc', ...process.argv.slice(1)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

// Each scenario runs in its own process. Sharing one process across scales
// leaves the heap carrying the previous scenario's history, and V8 will not
// always collect a several-hundred-MB heap back down within a bounded number
// of gc() calls — an under-collected baseline reads back as an impossibly
// small (or negative) cache delta.
const SCENARIOS = {
  small: ['small  (3 teams x 120 notes)', 3, 120, 120],
  medium: ['medium (8 teams x 400 notes)', 8, 400, 160],
  large: ['large  (20 teams x 800 notes)', 20, 800, 200],
}

// -- bundle the TS modules under test into something node can import --------
const outDir = mkdtempSync(join(tmpdir(), 'tt-bench-'))
const bundled = await build({
  stdin: {
    contents: [
      "export { createSearchIndex, searchDocument, normalize } from './src/core/search.ts'",
      "export { createEmptyDocument } from './src/core/document.ts'",
      "export { parsePlain, decryptDocument } from './src/core/crypto.ts'",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', write: false, charset: 'utf8',
  define: { __APP_VERSION__: '"bench"', __PWA__: 'false', __PAGES_URL__: '""', __REPO__: '""' },
})
const modPath = join(outDir, 'search-bundle.mjs')
writeFileSync(modPath, bundled.outputFiles[0].text)
const { createSearchIndex, createEmptyDocument, parsePlain, decryptDocument } =
  await import(pathToFileURL(modPath).href)

// -- synthetic corpus ------------------------------------------------------
// Deterministic (seeded LCG) so two runs on the same machine are comparable.
let seed = 20260906
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
// Mixed case and accents on purpose. An all-lowercase, unaccented corpus is
// not a realistic stand-in: `normalize()` (NFD -> strip marks -> lowercase)
// returns the *same string object* when nothing changes, so a synthetic
// lowercase corpus makes the search cache look nearly free when a real
// pt-BR/en-US document allocates a genuine second copy of every field.
const WORDS = ('Rollout release Blocker standup Vendor contrato renovacao Migracao incidente Staffing orcamento '
  + 'previsao Hiring onboarding Retro roadmap dependencia Escalonamento handover conformidade Auditoria latencia '
  + 'Backlog capacidade reuniao Entrega decisao Acompanhamento pendencia').split(' ')
const ACCENTED = { contrato: 'contrato', renovacao: 'renovação', Migracao: 'Migração', orcamento: 'orçamento', previsao: 'previsão', dependencia: 'dependência', Auditoria: 'Auditoria', reuniao: 'reunião', decisao: 'decisão', pendencia: 'pendência' }
const pick = () => {
  const w = WORDS[Math.floor(rnd() * WORDS.length)]
  return ACCENTED[w] ?? w
}

function paragraph(words) {
  const out = []
  for (let i = 0; i < words; i++) out.push(pick())
  return out.join(' ')
}

function noteBody(words) {
  return `# ${paragraph(3)}\n${paragraph(words)}\n- ${paragraph(8)}\n**${paragraph(4)}** ${paragraph(words)}`
}

// A token almost nothing contains, seeded into one note in RARE_EVERY. The
// common-word timing below is narrowing's worst case (every prefix of
// "rollout" still matches nearly every note, so there is barely anything to
// narrow to); a selective query is its best case, and both are worth seeing.
const RARE = 'quixotesco'
const RARE_EVERY = 200

function buildTeam(id, n, notesPerTeam, wordsPerNote) {
  const team = {
    id, name: `Team ${n}`, emoji: '\u{1f9ed}', stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {}, generalNotes: noteBody(wordsPerNote),
  }
  for (let i = 0; i < notesPerTeam; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10)
    const body = noteBody(wordsPerNote)
    team.dailyNotes[d] = i % RARE_EVERY === 0 ? `${body} ${RARE} pendente` : body
  }
  for (let i = 0; i < Math.round(notesPerTeam / 2); i++) {
    team.actionItems.push({
      id: `${id}-a${i}`, summary: paragraph(6), status: 'todo', color: 'ledger',
      dueDate: null, assignee: pick(), notes: noteBody(Math.round(wordsPerNote / 2)), order: i,
    })
    team.milestones.push({ id: `${id}-m${i}`, date: '2026-08-01', title: paragraph(5), done: false, followup: noteBody(40) })
    team.risks.push({ id: `${id}-r${i}`, title: paragraph(5), chance: 2, impact: 3, plan: 'mitigate', followup: noteBody(40), order: i, closed: false })
    team.members.push({ id: `${id}-p${i}`, name: `Person ${i}`, role: 'Dev', parentId: null, order: i, notes: noteBody(60) })
  }
  return team
}

function syntheticDoc(teams, notesPerTeam, wordsPerNote) {
  const doc = createEmptyDocument('en-US')
  doc.teams.length = 0
  for (let t = 0; t < teams; t++) doc.teams.push(buildTeam(`t${t}`, t, notesPerTeam, wordsPerNote))
  return doc
}

// -- measurement helpers ---------------------------------------------------
/**
 * Heap in use, after collecting to a fixed point. Two gc() calls are not
 * enough on a multi-hundred-MB heap — V8's collection is incremental, so an
 * under-collected baseline shows up later as a *negative* delta. Loop until
 * two consecutive readings agree within 0.5%.
 */
function heap() {
  let previous = Infinity
  for (let i = 0; i < 12; i++) {
    globalThis.gc()
    const used = process.memoryUsage().heapUsed
    if (Math.abs(used - previous) < previous * 0.005) return used
    previous = used
  }
  return previous
}
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
const ms = (n) => `${n.toFixed(2)} ms`

function timeIt(fn) {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

/** Median of `reps` runs — a single timing is dominated by JIT warm-up noise. */
function medianMs(reps, fn) {
  const samples = []
  for (let i = 0; i < reps; i++) samples.push(timeIt(fn))
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

function corpusChars(doc) {
  let chars = 0, candidates = 0
  for (const team of doc.teams) {
    const fields = [
      ...Object.values(team.dailyNotes), team.generalNotes ?? '',
      ...[...team.stakeholders, ...team.members].map((p) => p.notes),
      ...team.actionItems.map((i) => `${i.summary}\n${i.assignee}\n${i.notes}`),
      ...team.milestones.map((m) => `${m.title}\n${m.followup}`),
      ...team.risks.map((r) => `${r.title}\n${r.followup}`),
    ]
    candidates += fields.length
    for (const f of fields) chars += f.length
  }
  return { chars, candidates }
}

async function report(label, buildDoc) {
  // `buildDoc` is a thunk, not a document, so the doc's own heap footprint
  // can be read as the delta across building it.
  const empty = heap()
  const doc = await buildDoc()
  const withDoc = heap()
  const docBytes = withDoc - empty

  const { chars, candidates } = corpusChars(doc)

  // Retained heap the warm search cache adds on top of the document itself.
  // Baseline is taken with the doc alive and nothing else; the index is then
  // warmed over every team and kept referenced across the second reading.
  //
  // Nothing large may be serialized between these two readings — a
  // JSON.stringify() of the document immediately before the baseline stays
  // reachable from the optimized frame across gc(), and inflates `before` by
  // exactly the size of that string. That is why jsonBytes is measured last.
  const before = heap()
  const index = createSearchIndex(() => doc, () => 0)
  for (const team of doc.teams) index.search('zzzzz-no-match', team.id)
  const after = heap()
  const cacheBytes = after - before
  const jsonBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8')

  const warmOne = medianMs(9, () => index.search('rollout', null))
  const coldMs = timeIt(() => {
    const fresh = createSearchIndex(() => doc, () => 0)
    fresh.search('rollout', null)
  })

  // What a user actually does: type a word one character at a time on a warm
  // index. Each keystroke is its own search(), and each one that extends the
  // previous query re-scores only that query's matches.
  const typing = (word) => medianMs(5, () => {
    // Break any narrowing left over from the previous measurement, so the
    // first keystroke below pays a full scan exactly as it would in real use.
    index.search('zzz-reset-zzz', null)
    for (let i = 1; i <= word.length; i++) index.search(word.slice(0, i), null)
  })
  const commonWord = 'rollout'
  const typingCommonMs = typing(commonWord)
  const typingRareMs = typing(RARE)

  console.log(`\n-- ${label}`)
  console.log(`  teams ${doc.teams.length}  candidates ${candidates}  searchable chars ${chars.toLocaleString()}`)
  console.log(`  serialized JSON            ${mb(jsonBytes)}`)
  console.log(`  document strings on heap   ${mb(docBytes)}   (${(docBytes / chars).toFixed(2)} bytes/char)`)
  console.log(`  search cache retained heap ${mb(cacheBytes)}   (${(cacheBytes / chars).toFixed(2)} bytes/char)`)
  console.log(`  cold search (build+query)  ${ms(coldMs)}`)
  console.log(`  warm search (one query)    ${ms(warmOne)}`)
  console.log(`  typing "${commonWord}" (matches most notes)  ${ms(typingCommonMs)}   (${commonWord.length} keystrokes)`)
  console.log(`  typing "${RARE}" (selective)      ${ms(typingRareMs)}   (${RARE.length} keystrokes)`)
  index.invalidate(null)
}

// -- run -------------------------------------------------------------------
const scenarioFlag = process.argv.indexOf('--scenario')
if (scenarioFlag !== -1) {
  const [label, teams, notes, words] = SCENARIOS[process.argv[scenarioFlag + 1]]
  await report(label, () => syntheticDoc(teams, notes, words))
  console.log()
  process.exit(0)
}

const target = process.argv[2]
if (target) {
  await report(target, async () => {
    const bytes = new Uint8Array(readFileSync(target))
    const plain = parsePlain(bytes)
    if (plain) return plain
    const password = process.env.TMV_PASSWORD
    if (!password) {
      console.error(`${target} is not a TMV-PLAIN file - set TMV_PASSWORD to measure an encrypted one.`)
      process.exit(2)
    }
    return decryptDocument(bytes, password)
  })
} else {
  for (const name of Object.keys(SCENARIOS)) {
    spawnSync(process.execPath, ['--expose-gc', process.argv[1], '--scenario', name], { stdio: 'inherit' })
  }
}
console.log()
