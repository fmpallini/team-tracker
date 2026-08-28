import type { Doc, ModuleRef, Team } from './types'
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

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
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

/** Id+title extraction for the @ mention picker and the Ctrl+K palette — a lighter sibling of collectCandidates below, which also needs full note bodies for full-text search. */
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

/** A candidate with its markdown stripped and normalized once, ready to match against. */
interface PreparedCandidate {
  ref: ModuleRef
  title: string
  stripped: string
  normalized: string
}

/** Backlinks' reverse index for one team, keyed by the mention's raw "kind:target" string (refPattern's group 2) — same key shape `backlinks()` below looks up by. */
type BacklinksByRef = Map<string, Backlink[]>

/** A match plus its ranking data — kept separate from the public `SearchResult` so `span`/`minPos` never leak into the UI-facing shape. */
interface ScoredHit { result: SearchResult; span: number; minPos: number }

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
function scoreCandidate(candidate: PreparedCandidate, teamId: string, teamName: string, terms: string[]): ScoredHit | null {
  const positions = termPositions(candidate.normalized, terms)
  if (!positions) return null
  const minPos = Math.min(...positions)
  const maxEnd = Math.max(...positions.map((p, i) => p + terms[i]!.length))
  return {
    result: {
      loc: { teamId, ref: candidate.ref },
      moduleKind: candidate.ref.kind,
      title: candidate.title,
      snippet: makeSnippet(candidate.stripped, positions),
      teamName,
    },
    span: maxEnd - minPos,
    minPos,
  }
}

/** Tightest-cluster-first, then earliest-match-first; JS's stable sort keeps same-score hits in `hits`' original (insertion) order as the final tiebreak. */
function rankAndLimit(hits: ScoredHit[]): SearchResult[] {
  hits.sort((a, b) => (a.span - b.span) || (a.minPos - b.minPos))
  return hits.slice(0, RESULT_LIMIT).map((h) => h.result)
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
   * Drops exactly the cached candidates a `store.update()` described by
   * `scope` could have invalidated — see `createSearchIndex`. Wire this to
   * `store.subscribe`, whose callback receives that scope.
   */
  invalidate(scope: ChangeScope | null | undefined): void
}

/**
 * Sections `collectCandidates` actually reads. 'templates' is the only one
 * absent — a template edit can't change any searchable text. ('teams' is in:
 * a rename changes `teamName` on every result. 'prefs' is in: the locale
 * formats daily-note titles.)
 */
const SEARCHABLE: readonly Section[] = ['notes', 'people', 'actions', 'milestones', 'risks', 'teams', 'prefs']

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
 *    search. Expensive, and only the Ctrl+K palette ever reads it, so it is
 *    built lazily on the first `search()` that touches a team rather than
 *    forced (and retained) by an unrelated chip render.
 */
export function createSearchIndex(getDoc: () => Doc, getRev: () => number): SearchIndex {
  // The revision these caches have been *told about* — via invalidate(),
  // which rides store.subscribe() and knows which team changed. A rev that
  // moves without a matching invalidate() is a change nobody described
  // (store.updateNav() bumps rev but deliberately bypasses subscribe()), so
  // both caches are dropped on the next read rather than trusted: an
  // unexplained change could have touched anything.
  let knownRev = -1
  const backlinksCache = new Map<string, BacklinksByRef>()
  const candidatesCache = new Map<string, PreparedCandidate[]>()

  function syncRev(): void {
    const rev = getRev()
    if (rev === knownRev) return
    backlinksCache.clear()
    candidatesCache.clear()
    knownRev = rev
  }

  /** Reverse mention index for one team — a raw-text scan only, no strip/normalize. */
  function backlinksFor(team: Team, doc: Doc): BacklinksByRef {
    const hit = backlinksCache.get(team.id)
    if (hit) return hit
    const byRef: BacklinksByRef = new Map()
    const mentionPattern = refPattern()
    for (const c of collectCandidates(team, doc)) {
      mentionPattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = mentionPattern.exec(c.raw))) {
        const key = m[2]! // "kind:target" — same key shape backlinks() looks up by.
        const bl: Backlink = {
          loc: { teamId: team.id, ref: c.ref },
          moduleKind: c.ref.kind as BacklinkSourceKind,
          title: c.title,
          snippet: backlinkSnippet(c.raw, m.index, m[0].length),
        }
        const list = byRef.get(key)
        if (list) list.push(bl)
        else byRef.set(key, [bl])
      }
    }
    backlinksCache.set(team.id, byRef)
    return byRef
  }

  /** `stripMd`ped + `normalize`d candidates for one team — the expensive half, built only when something actually searches this team. */
  function candidatesFor(team: Team, doc: Doc): PreparedCandidate[] {
    const hit = candidatesCache.get(team.id)
    if (hit) return hit
    const prepared: PreparedCandidate[] = []
    for (const c of collectCandidates(team, doc)) {
      const stripped = stripMd(c.raw)
      prepared.push({ ref: c.ref, title: c.title, stripped, normalized: normalize(stripped) })
    }
    candidatesCache.set(team.id, prepared)
    return prepared
  }

  return {
    invalidate(scope: ChangeScope | null | undefined): void {
      // Whatever this scope describes, we've now accounted for the revision
      // it produced — so syncRev() won't also blanket-clear on the next
      // read. Read before the early return below, or a non-searchable
      // change (a template edit) would leave knownRev stale and trigger a
      // full clear anyway.
      knownRev = getRev()
      if (!scope || scope.teamId === undefined) {
        // No team named — "could be any/all teams" (this is also what
        // store.replaceDoc() sends). Nothing narrower is safe.
        backlinksCache.clear()
        candidatesCache.clear()
        return
      }
      // Both caches read from the same `collectCandidates` fields, so the
      // same section gate applies to both.
      if (scope.sections !== undefined && !scope.sections.some((s) => SEARCHABLE.includes(s))) return
      backlinksCache.delete(scope.teamId)
      candidatesCache.delete(scope.teamId)
    },

    search(query: string, scopeTeamId: string | null): SearchResult[] {
      syncRev()
      const trimmedQuery = query.trim()
      if (!trimmedQuery) return []
      const terms = normalize(trimmedQuery).split(/\s+/).filter(Boolean)
      if (terms.length === 0) return []

      const doc = getDoc()
      const teams = scopeTeamId === null ? doc.teams : doc.teams.filter((team) => team.id === scopeTeamId)
      const hits: ScoredHit[] = []

      for (const team of teams) {
        for (const candidate of candidatesFor(team, doc)) {
          const hit = scoreCandidate(candidate, team.id, team.name, terms)
          if (hit) hits.push(hit)
        }
      }
      return rankAndLimit(hits)
    },

    backlinks(teamId: string, kind: RefKind, targetId: string): Backlink[] {
      syncRev()
      const doc = getDoc()
      const team = doc.teams.find((tm) => tm.id === teamId)
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

  for (const team of teams) {
    for (const candidate of collectCandidates(team, doc)) {
      const stripped = stripMd(candidate.raw)
      const normalized = normalize(stripped)
      const hit = scoreCandidate({ ref: candidate.ref, title: candidate.title, stripped, normalized }, team.id, team.name, terms)
      if (hit) hits.push(hit)
    }
  }
  return rankAndLimit(hits)
}
