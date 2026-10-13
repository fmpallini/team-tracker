import type { Doc, ModuleRef, Team } from './types'
import { findTeam as docFindTeam } from './document'
import type { ChangeScope, Section } from './scope'
import { formatDate, t } from './i18n'
import { refPattern, type RefKind } from './refs'

export interface SearchResult {
  loc: { teamId: string; ref: ModuleRef }
  moduleKind: ModuleRef['kind']
  title: string
  snippet: string
  teamName: string
}

const RESULT_LIMIT = 50
const SNIPPET_RADIUS = 80

/** The general case: decompose, drop every combining mark, lowercase. */
function decomposeAndFold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

// Written as the positive range rather than as "not ASCII": spelling it
// [^\u0000-\u007F] means naming control characters in a class, which
// eslint's no-control-regex rejects. Every UTF-16 code unit outside ASCII
// (lone surrogates included) falls in this range, so the two are equivalent.
const NON_ASCII = /[\u0080-\uFFFF]/

/**
 * Latin-1 letters that carry an accent, mapped straight to the plain
 * lowercase letter `decomposeAndFold` would leave.
 *
 * Built by running `decomposeAndFold` over the Latin-1 range at module load
 * rather than typed out, so the table cannot drift from the behaviour it
 * stands in for, and so the letters with *no* canonical decomposition are
 * excluded by construction — ø, æ, ð, þ and ß are left alone by NFD, and must
 * be left alone here too.
 */
const LATIN1_FOLD = new Map<string, string>()
for (let codePoint = 0xa0; codePoint <= 0xff; codePoint++) {
  const char = String.fromCharCode(codePoint)
  const folded = decomposeAndFold(char)
  if (folded !== char.toLowerCase()) LATIN1_FOLD.set(char, folded)
}
const LATIN1_FOLD_PATTERN = new RegExp(`[${[...LATIN1_FOLD.keys()].join('')}]`, 'g')

/**
 * Accent- and case-insensitive form used for every match and every cached
 * candidate.
 *
 * Written to avoid `normalize('NFD')` wherever it can, for memory rather than
 * speed. The accented letters this app's documents actually contain — the
 * whole of Portuguese, and Latin-1 generally — live in the one-byte range, so
 * a note sits on the heap as a one-byte string. NFD decomposes those letters
 * into combining marks outside that range, which promotes the string to V8's
 * two-byte representation, and stripping the marks afterwards does not demote
 * it again: the derived copy the search cache retains ends up twice the size
 * of the text it came from. Folding Latin-1 accents directly keeps it one
 * byte wide, halving the cache on an accented corpus and running about twice
 * as fast besides.
 *
 * The NFD path is still there, reached only when folding leaves something
 * outside ASCII — anything beyond Latin-1, or already-decomposed input — so
 * the result is the same string for every input either way. See
 * test/search-normalize.test.ts, which asserts exactly that over the range
 * these documents can hold.
 */
export function normalize(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase()
  const folded = s.replace(LATIN1_FOLD_PATTERN, (char) => LATIN1_FOLD.get(char)!)
  if (!NON_ASCII.test(folded)) return folded.toLowerCase()
  return decomposeAndFold(folded)
}

// Strips the basic markdown syntax this app produces so search snippets read
// as plain text: heading/list/ordered-list markers, bold/italic/strike/underline,
// @[label](ref) references (kept as their label), and refs.ts's
// single-tilde unlinked-reference marker (also kept as its label).
function stripMd(s: string): string {
  return s
    .split('\n')
    .map(line => {
      let l = line
      l = l.replace(/^#{1,6}\s+/, '')
      l = l.replace(/^-\s+/, '')
      l = l.replace(/^\d+\.\s+/, '')
      l = l.replace(/@\[([^\]]+)\]\([^)]*\)/g, '$1')
      l = l.replace(/\*\*([^*]+)\*\*/g, '$1')
      l = l.replace(/~~([^~]+)~~/g, '$1')
      l = l.replace(/~([^~]+)~/g, '$1')
      l = l.replace(/<\/?u>/g, '')
      l = l.replace(/\*([^*]+)\*/g, '$1')
      return l
    })
    .join('\n')
}

/** Each term's first-match index in `haystack`, or `null` if any term is missing (replaces the old allTermsMatch boolean — the AND-check and the ranking data below both fall out of the same per-term scan). */
function termPositions(haystack: string, terms: string[]): number[] | null {
  const positions: number[] = []
  for (const term of terms) {
    const i = haystack.indexOf(term)
    if (i < 0) return null
    positions.push(i)
  }
  return positions
}

// `stripped` and `normalized` are index-aligned (normalize preserves character
// count for the accented Latin text this app handles), so an index found in
// `normalized` can be used directly to slice the display text in `stripped`.
function makeSnippet(stripped: string, positions: number[]): string {
  const idx = Math.min(...positions)
  const start = Math.max(0, idx - SNIPPET_RADIUS)
  const end = Math.min(stripped.length, idx + SNIPPET_RADIUS)
  let out = stripped.slice(start, end).trim()
  if (start > 0) out = `…${out}`
  if (end < stripped.length) out = `${out}…`
  return out
}

export const KIND_ICON: Record<SearchResult['moduleKind'], string> = {
  daily: '📅', general: '🗒️', person: '🧑', stakeholders: '🧑‍💼', members: '👥', actions: '✅', milestones: '🚩', risks: '⚠️',
}

export interface RefCandidate { id: string; title: string }
export interface TeamRefCandidates {
  people: RefCandidate[]
  actionItems: RefCandidate[]
  milestones: RefCandidate[]
  risks: RefCandidate[]
}

/** Id+title extraction for the @ mention picker and the Ctrl+Shift+K palette — a lighter sibling of collectCandidates below, which also needs full note bodies for full-text search. */
export function teamRefCandidates(team: Team | undefined): TeamRefCandidates {
  if (!team) return { people: [], actionItems: [], milestones: [], risks: [] }
  return {
    people: [...team.stakeholders, ...team.members].map((p): RefCandidate => ({ id: p.id, title: p.name })),
    actionItems: team.actionItems.map((i): RefCandidate => ({ id: i.id, title: i.summary })),
    milestones: team.milestones.map((m): RefCandidate => ({ id: m.id, title: m.title })),
    risks: team.risks.map((r): RefCandidate => ({ id: r.id, title: r.title })),
  }
}

interface Candidate { raw: string; title: string; ref: ModuleRef }

function collectCandidates(team: Team, doc: Doc): Candidate[] {
  const out: Candidate[] = []
  for (const [date, text] of Object.entries(team.dailyNotes)) {
    out.push({ raw: text, title: formatDate(date, doc.prefs.locale), ref: { kind: 'daily', date } })
  }
  out.push({ raw: team.generalNotes ?? '', title: t(doc.prefs.locale, 'module_general_notes'), ref: { kind: 'general' } })
  for (const group of ['stakeholders', 'members'] as const) {
    for (const person of team[group]) {
      out.push({ raw: person.notes, title: person.name, ref: { kind: 'person', personId: person.id, group } })
    }
  }
  for (const item of team.actionItems) {
    out.push({ raw: `${item.summary}\n${item.assignee}\n${item.notes}`, title: item.summary, ref: { kind: 'actions', itemId: item.id } })
  }
  for (const milestone of team.milestones) {
    out.push({ raw: `${milestone.title}\n${milestone.followup}`, title: milestone.title, ref: { kind: 'milestones', itemId: milestone.id } })
  }
  for (const risk of team.risks) {
    out.push({ raw: `${risk.title}\n${risk.followup}`, title: risk.title, ref: { kind: 'risks', itemId: risk.id } })
  }
  return out
}

/**
 * Sections whose mutations can add/remove a backlink match or change a
 * backlink's displayed title/snippet — the fields collectCandidates scans,
 * minus 'teams'/'prefs' (a rename or locale change going stale here is the
 * same acceptable class of staleness createSearchIndex already accepts for
 * its own cache). Modules that render a backlinks chip/badge widen their own
 * store.subscribe WATCHED list with this (see Tasks 5-9).
 */
export const BACKLINK_SECTIONS: readonly Section[] = ['notes', 'people', 'actions', 'milestones', 'risks']

/**
 * Source kinds collectCandidates ever produces for its `ref` field — a
 * narrower subset of ModuleRef['kind'] than KIND_ICON's domain (excludes
 * 'stakeholders'/'members', which are whole-list pane views, never a single
 * free-text field a mention can live in).
 */
export type BacklinkSourceKind = 'daily' | 'general' | 'person' | 'actions' | 'milestones' | 'risks'

export interface Backlink {
  /** Where the mention lives — the free-text field's own location, not the target's. */
  loc: { teamId: string; ref: ModuleRef }
  moduleKind: BacklinkSourceKind
  /** The source item's display title (e.g. the mentioning person's name, or the mentioning daily note's formatted date). */
  title: string
  /** Plain-text excerpt around the mention, markdown-stripped. */
  snippet: string
}

/** Same trim shape as makeSnippet above, but anchored at a known raw-text match span instead of a search term. */
function backlinkSnippet(raw: string, matchIndex: number, matchLen: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS)
  const end = Math.min(raw.length, matchIndex + matchLen + SNIPPET_RADIUS)
  let out = stripMd(raw.slice(start, end)).trim()
  if (start > 0) out = `…${out}`
  if (end < raw.length) out = `${out}…`
  return out
}

/**
 * Field size at or above which a candidate's markdown-stripped text is kept
 * instead of re-derived per query — see `PreparedCandidate`. Chosen so the
 * stripping a single query can be asked to redo stays bounded at roughly
 * RESULT_LIMIT x this many characters, which measures well under a
 * millisecond, while ordinary notes (a couple of KB at most) stay on the
 * cheap side of the trade.
 */
const EAGER_STRIP_MIN = 4096

/**
 * A candidate ready to match against.
 *
 * `raw` is the document's own string, held by reference — nothing new is
 * allocated for it — and `normalized` is the one derived copy matching needs.
 * The markdown-stripped text a result's snippet is cut from is normally *not*
 * retained: on a large document it measured a full extra copy of the whole
 * corpus (~1 byte per character on top of normalized's ~2), while at most
 * RESULT_LIMIT candidates per query ever need it. `stripMd` is pure, so
 * re-running it on the survivors reproduces exactly the string `normalized`
 * was derived from, and the index alignment `makeSnippet` depends on holds.
 *
 * The exception is `stripped`, kept only for fields at least
 * EAGER_STRIP_MIN characters long. Re-stripping is cheap per KB but the cost
 * is paid per shown result per keystroke, so on a document holding a few very
 * large fields — where all 50 shown results can be enormous notes — deriving
 * it on demand cost more per query than storing it ever did (measured: a
 * repeat query redoing a third of the whole index build). Above the
 * threshold the old eager behaviour is simply kept, so neither axis is ever
 * worse than it was before snippets went lazy.
 *
 * See test/search-memory.test.ts and test/search-large-fields.test.ts.
 */
interface PreparedCandidate {
  ref: ModuleRef
  title: string
  raw: string
  normalized: string
  /** Pre-stripped display text, present only for fields >= EAGER_STRIP_MIN. */
  stripped?: string
}

/** The one place `raw` is turned into the forms matching and snippets need — shared by `createSearchIndex`'s cache and by the uncached `searchDocument`. */
function prepareCandidate(candidate: Candidate): PreparedCandidate {
  const stripped = stripMd(candidate.raw)
  const prepared: PreparedCandidate = {
    ref: candidate.ref, title: candidate.title, raw: candidate.raw, normalized: normalize(stripped),
  }
  // Free to keep at this point — it has just been computed either way.
  if (candidate.raw.length >= EAGER_STRIP_MIN) prepared.stripped = stripped
  return prepared
}

/**
 * Identity of a candidate across rebuilds — which field of the team it is, not
 * what it currently says. Two candidates with the same key are "the same field,
 * possibly edited"; whether its text actually changed is decided by comparing
 * `raw` and `title`, never by this key, so a collision (a corrupt document with
 * a duplicated id) can only cost a redundant re-derive, never a wrong result.
 */
function candidateKey(ref: ModuleRef): string {
  switch (ref.kind) {
    case 'daily': return `d:${ref.date}`
    case 'person': return `p:${ref.group}:${ref.personId}`
    case 'actions': case 'milestones': case 'risks': return `${ref.kind}:${ref.itemId ?? ''}`
    default: return ref.kind
  }
}

/** Backlinks' reverse index for one team, keyed by the mention's raw "kind:target" string (refPattern's group 2) — same key shape `backlinks()` below looks up by. */
type BacklinksByRef = Map<string, Backlink[]>

/**
 * One team's prepared candidates. `stale` means "something may have changed
 * since `list` was built": the list is kept rather than dropped so the rebuild
 * can reuse every entry whose text turns out to be unchanged — the expensive
 * `stripMd` + `normalize` pass is then paid for the edited fields only.
 */
interface CandidateEntry { list: PreparedCandidate[]; stale: boolean }

/** The mentions found in one source field, kept so an unchanged field is not re-scanned. */
interface SourceMentions {
  ref: ModuleRef
  raw: string
  title: string
  found: { key: string; backlink: Backlink }[]
}

/**
 * One team's reverse mention index plus the per-field scans it was assembled
 * from. `sources` holds only fields that contain a mention — the rest are
 * cleared by an `indexOf` — so it does not scale with the number of fields.
 */
interface BacklinkEntry { byRef: BacklinksByRef; sources: Map<string, SourceMentions>; stale: boolean }

/**
 * A match plus its ranking data — kept separate from the public
 * `SearchResult` so `span`/`minPos` never leak into the UI-facing shape.
 * Holds the candidate itself rather than a finished result: the snippet is
 * only cut once ranking has decided which hits are actually shown.
 */
interface ScoredHit {
  candidate: PreparedCandidate
  teamId: string
  teamName: string
  /** Each term's first-match index in `candidate.normalized` — where the snippet gets anchored. */
  positions: number[]
  span: number
  minPos: number
  /** Position in document order (teams, then each team's candidates) — the final tiebreak, so a narrowed result list orders ties exactly as a fresh scan would. */
  order: number
}

/**
 * Scores one candidate against `terms` (already required to all match, via
 * `termPositions`), or returns `null` if it doesn't match at all. Two ranking
 * signals, both cheap to derive from the same position scan:
 *   - `minPos`: how early the first term hits — an early match beats one
 *     buried deep in a long note.
 *   - `span`: how tightly the terms cluster (last term's end minus first
 *     term's start) — terms found next to each other beat the same terms
 *     scattered across opposite ends of a note. Degenerates to a constant
 *     (the one term's length) for single-term queries, so it naturally drops
 *     out of the sort and `minPos` alone decides.
 */
function scoreCandidate(candidate: PreparedCandidate, teamId: string, teamName: string, terms: string[], order: number): ScoredHit | null {
  const positions = termPositions(candidate.normalized, terms)
  if (!positions) return null
  const minPos = Math.min(...positions)
  const maxEnd = Math.max(...positions.map((p, i) => p + terms[i]!.length))
  return { candidate, teamId, teamName, positions, span: maxEnd - minPos, minPos, order }
}

/** Cuts the displayed snippet — the one step that needs the markdown-stripped text, so it is paid per shown result rather than per cached candidate. */
function toResult(hit: ScoredHit): SearchResult {
  return {
    loc: { teamId: hit.teamId, ref: hit.candidate.ref },
    moduleKind: hit.candidate.ref.kind,
    title: hit.candidate.title,
    snippet: makeSnippet(hit.candidate.stripped ?? stripMd(hit.candidate.raw), hit.positions),
    teamName: hit.teamName,
  }
}

/**
 * Tightest-cluster-first, then earliest-match-first, then document order. The
 * last key is explicit rather than left to the sort's stability: `hits` can
 * arrive already ranked (narrowing re-scores the previous query's sorted
 * matches), and insertion order would then be that earlier ranking instead.
 */
function rankAndLimit(hits: ScoredHit[]): SearchResult[] {
  hits.sort((a, b) => (a.span - b.span) || (a.minPos - b.minPos) || (a.order - b.order))
  return hits.slice(0, RESULT_LIMIT).map(toResult)
}

export interface SearchIndex {
  search(query: string, scopeTeamId: string | null): SearchResult[]
  /**
   * Every mention of `kind:targetId` in `teamId`'s free-text fields, served
   * from this index's own per-team cache instead of re-walking every field
   * on each call. Empty array if `teamId` doesn't exist in the current doc.
   */
  backlinks(teamId: string, kind: RefKind, targetId: string): Backlink[]
  /**
   * Marks stale exactly the teams a `store.update()` described by `scope`
   * could have changed — see `createSearchIndex`. A stale team keeps its
   * prepared text, so the next read only re-derives fields that differ. Wire
   * this to `store.subscribe`, whose callback receives that scope.
   */
  invalidate(scope: ChangeScope | null | undefined): void
  /**
   * Declares that the store revision that just landed was a nav-only mutation
   * (`store.updateNav()`), which by contract touches `doc.nav` alone — never a
   * searchable field. Without this, the rev bump it causes looks like an
   * undescribed change and the next read drops every team's caches. Wire it to
   * `store.onMutate` for `kind === 'nav'`. Only honoured when the caches were
   * in sync one revision earlier; otherwise the blanket drop stays in force.
   */
  acknowledgeNav(): void
}

/**
 * A `searchDocument` that prepares each team's candidates once per document
 * revision instead of once per keystroke. `stripMd` runs seven regexes per
 * line and `normalize` does an NFD pass plus a regex — repeating both across
 * every note in every team on each of a fast typist's keystrokes was the
 * single largest source of repeated allocation in the app.
 *
 * Two separate per-team caches, both keyed by `getRev()` (not object
 * identity — the store mutates the Doc in place, so the same `Team` object is
 * both the before and after of an edit):
 *
 *  - `backlinksCache` — the reverse mention index. Cheap to build: one
 *    raw-text regex scan per candidate, no `stripMd`/`normalize`. Every chip
 *    render (milestone/risk/action/person/day) hits this, so it is built the
 *    moment any such module mounts.
 *  - `candidatesCache` — `stripMd`ped + `normalize`d text for full-text
 *    search. Expensive, and only the Ctrl+Shift+K palette ever reads it, so it is
 *    built lazily on the first `search()` that touches a team rather than
 *    forced (and retained) by an unrelated chip render.
 *
 * Invalidation never throws a team's work away. A change marks the affected
 * teams *stale*; the next read re-collects that team's fields (cheap: no
 * strip, no normalize) and reuses the prepared form of every field whose text
 * is identical to last time. So the cost of an edit is proportional to the
 * fields that changed, and an invalidation that was broader than necessary —
 * an unscoped update, a rename, an undescribed revision — costs a re-collect
 * rather than a rebuild. Staleness is still decided by the change scope (a
 * scope that lies about what it touched can still serve a stale result, same
 * as before); the content comparison only makes over-invalidating cheap.
 */
export function createSearchIndex(getDoc: () => Doc, getRev: () => number): SearchIndex {
  // The revision these caches have been *told about* — via invalidate(),
  // which rides store.subscribe() and knows which team changed. A rev that
  // moves without a matching invalidate() is a change nobody described
  // (store.updateNav() bypasses subscribe() on purpose), so every team is
  // marked stale on the next read rather than trusted: an unexplained change
  // could have touched anything.
  let knownRev = -1
  // The locale the caches were last known to be built under — the only pref
  // that reaches a candidate (daily-note and general-notes titles).
  let knownLocale = getDoc().prefs.locale
  const backlinksCache = new Map<string, BacklinkEntry>()
  const candidatesCache = new Map<string, CandidateEntry>()

  /**
   * The previous query's *complete* match set (pre-`RESULT_LIMIT`), kept so
   * that extending that query re-scores only those hits instead of the whole
   * document — see `narrowable` below for why that is sound.
   *
   * Storing the ranked-and-limited results here instead would be wrong: a hit
   * ranked 51st for "ro" can rank 1st for "rollout", and truncating first
   * would lose it for every query that follows.
   *
   * Holds `PreparedCandidate` references, so it must be dropped whenever a
   * cache entry is touched, or it would keep serving candidates prepared from
   * text the document no longer has.
   */
  let lastQuery: { normalizedQuery: string; scopeTeamId: string | null; hits: ScoredHit[] } | null = null

  /** Marks `teamId` (or, when `undefined`, every team) stale and forgets teams the document no longer has. */
  function markStale(teamId: string | undefined): void {
    const doc = getDoc()
    for (const cache of [candidatesCache, backlinksCache] as const) {
      for (const [id, entry] of cache) {
        if (!docFindTeam(doc, id)) cache.delete(id)
        else if (teamId === undefined || teamId === id) entry.stale = true
      }
    }
  }

  function syncRev(): void {
    const rev = getRev()
    if (rev === knownRev) return
    markStale(undefined)
    lastQuery = null
    knownLocale = getDoc().prefs.locale
    knownRev = rev
  }

  /**
   * Whether `normalizedQuery` can be answered by re-scoring the previous
   * query's matches alone.
   *
   * Extending a query can only shrink the match set. Splitting on whitespace,
   * a query that starts with the previous one has the same leading terms, and
   * its final term has the previous final term as a prefix (or adds a new
   * term outright). A candidate matching every new term therefore contains
   * every old term too — so anything the new query matches was already in the
   * old query's hits, and anything the old query rejected cannot match now.
   *
   * The scope has to be identical: a hit set collected for one team says
   * nothing about candidates in the teams that scope excluded.
   */
  function narrowable(normalizedQuery: string, scopeTeamId: string | null): boolean {
    return lastQuery !== null
      && lastQuery.scopeTeamId === scopeTeamId
      && normalizedQuery.startsWith(lastQuery.normalizedQuery)
  }

  /** Reverse mention index for one team — a raw-text scan only, no strip/normalize. */
  function backlinksFor(team: Team, doc: Doc): BacklinksByRef {
    const cached = backlinksCache.get(team.id)
    if (cached && !cached.stale) return cached.byRef
    const mentionPattern = refPattern()
    const byRef: BacklinksByRef = new Map()
    const sources = new Map<string, SourceMentions>()
    for (const c of collectCandidates(team, doc)) {
      const sourceKey = candidateKey(c.ref)
      const previous = cached?.sources.get(sourceKey)
      let source: SourceMentions | undefined
      if (previous && previous.raw === c.raw && previous.title === c.title) {
        source = previous
      } else if (c.raw.includes('@[')) { // every mention starts with it — most fields never do, so skip the regex
        const found: SourceMentions['found'] = []
        mentionPattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = mentionPattern.exec(c.raw))) {
          found.push({
            key: m[2]!, // "kind:target" — same key shape backlinks() looks up by.
            backlink: {
              loc: { teamId: team.id, ref: c.ref },
              moduleKind: c.ref.kind as BacklinkSourceKind,
              title: c.title,
              snippet: backlinkSnippet(c.raw, m.index, m[0].length),
            },
          })
        }
        if (found.length > 0) source = { ref: c.ref, raw: c.raw, title: c.title, found }
      }
      if (!source) continue
      sources.set(sourceKey, source)
      for (const { key, backlink } of source.found) {
        const list = byRef.get(key)
        if (list) list.push(backlink)
        else byRef.set(key, [backlink])
      }
    }
    backlinksCache.set(team.id, { byRef, sources, stale: false })
    return byRef
  }

  /** `stripMd`ped + `normalize`d candidates for one team — the expensive half, built only when something actually searches this team. */
  function candidatesFor(team: Team, doc: Doc): PreparedCandidate[] {
    const cached = candidatesCache.get(team.id)
    if (cached && !cached.stale) return cached.list
    const previous = new Map<string, PreparedCandidate>()
    if (cached) for (const p of cached.list) previous.set(candidateKey(p.ref), p)
    const list = collectCandidates(team, doc).map((c) => {
      const old = previous.get(candidateKey(c.ref))
      if (!old || old.raw !== c.raw) return prepareCandidate(c)
      // Same text: the matching form carries over untouched. Only the title can
      // differ (a locale change reformats daily-note dates).
      return old.title === c.title ? old : { ...old, title: c.title }
    })
    candidatesCache.set(team.id, { list, stale: false })
    return list
  }

  return {
    invalidate(scope: ChangeScope | null | undefined): void {
      // Whatever this scope describes, we've now accounted for the revision
      // it produced — so syncRev() won't also mark everything stale on the
      // next read. Read before the early return below, or a non-searchable
      // change (a template edit) would leave knownRev stale and trigger a
      // full re-collect anyway.
      knownRev = getRev()
      // Dropped unconditionally, even for a change no cache entry cares
      // about. The previous query's hit set is the one thing here that can
      // outlive its own team's cache entry, and re-deriving it costs a single
      // full scan on the next keystroke — far cheaper than reasoning about
      // whether this particular scope could have touched a hit.
      lastQuery = null
      // A locale flip is the one pref that changes a candidate, and it does so
      // for every team. Detected by value, so a font-size or theme change —
      // which arrives scoped to 'prefs' alone — leaves the caches alone, and so
      // does a scope that forgot to name 'prefs' when the locale moved.
      const locale = getDoc().prefs.locale
      const localeChanged = locale !== knownLocale
      knownLocale = locale
      const sections = scope?.sections
      // 'teams' is treated as content: a rename can't change a candidate, but
      // add/delete/restore can, and re-collecting a team is cheap now.
      if (sections !== undefined && !localeChanged && !sections.some((s) => s === 'teams' || BACKLINK_SECTIONS.includes(s))) return
      // No team named means "could be any/all teams" (this is also what
      // store.replaceDoc() sends). Nothing narrower is safe.
      markStale(localeChanged ? undefined : scope?.teamId)
    },

    acknowledgeNav(): void {
      // Exactly one revision ahead = this nav mutation is the only thing the
      // caches haven't been told about. Anything further behind means some
      // other undescribed change slipped in, so leave it for syncRev() to
      // mark stale.
      if (knownRev === getRev() - 1) knownRev = getRev()
    },

    search(query: string, scopeTeamId: string | null): SearchResult[] {
      syncRev()
      const trimmedQuery = query.trim()
      if (!trimmedQuery) return []
      const normalizedQuery = normalize(trimmedQuery)
      const terms = normalizedQuery.split(/\s+/).filter(Boolean)
      if (terms.length === 0) return []

      const doc = getDoc()
      const hits: ScoredHit[] = []

      if (narrowable(normalizedQuery, scopeTeamId)) {
        // Typing forward: re-score the previous query's matches only. Each
        // hit already knows its team, so no team walk is needed here.
        for (const previous of lastQuery!.hits) {
          const hit = scoreCandidate(previous.candidate, previous.teamId, previous.teamName, terms, previous.order)
          if (hit) hits.push(hit)
        }
      } else {
        const teams = scopeTeamId === null ? doc.teams : doc.teams.filter((team) => team.id === scopeTeamId)
        let order = 0
        for (const team of teams) {
          for (const candidate of candidatesFor(team, doc)) {
            const hit = scoreCandidate(candidate, team.id, team.name, terms, order++)
            if (hit) hits.push(hit)
          }
        }
      }

      lastQuery = { normalizedQuery, scopeTeamId, hits }
      return rankAndLimit(hits)
    },

    backlinks(teamId: string, kind: RefKind, targetId: string): Backlink[] {
      syncRev()
      const doc = getDoc()
      const team = docFindTeam(doc, teamId)
      if (!team) return []
      return backlinksFor(team, doc).get(`${kind}:${targetId}`) ?? []
    },
  }
}

export function searchDocument(doc: Doc, query: string, scopeTeamId: string | null): SearchResult[] {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return []
  const terms = normalize(trimmedQuery).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const teams = scopeTeamId === null ? doc.teams : doc.teams.filter(team => team.id === scopeTeamId)
  const hits: ScoredHit[] = []

  let order = 0
  for (const team of teams) {
    for (const candidate of collectCandidates(team, doc)) {
      const hit = scoreCandidate(prepareCandidate(candidate), team.id, team.name, terms, order++)
      if (hit) hits.push(hit)
    }
  }
  return rankAndLimit(hits)
}
