import type { Doc, ModuleRef, Team } from './types'
import { formatDate } from './i18n'

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
// and @[label](ref) references (kept as their label).
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
      l = l.replace(/<\/?u>/g, '')
      l = l.replace(/\*([^*]+)\*/g, '$1')
      return l
    })
    .join('\n')
}

function allTermsMatch(haystack: string, terms: string[]): boolean {
  return terms.every(term => haystack.includes(term))
}

// `stripped` and `normalized` are index-aligned (normalize preserves character
// count for the accented Latin text this app handles), so an index found in
// `normalized` can be used directly to slice the display text in `stripped`.
function makeSnippet(stripped: string, normalized: string, terms: string[]): string {
  let idx = -1
  for (const term of terms) {
    const i = normalized.indexOf(term)
    if (i >= 0 && (idx === -1 || i < idx)) idx = i
  }
  if (idx < 0) idx = 0
  const start = Math.max(0, idx - SNIPPET_RADIUS)
  const end = Math.min(stripped.length, idx + SNIPPET_RADIUS)
  let out = stripped.slice(start, end).trim()
  if (start > 0) out = `…${out}`
  if (end < stripped.length) out = `${out}…`
  return out
}

interface Candidate { raw: string; title: string; ref: ModuleRef }

function collectCandidates(team: Team, doc: Doc): Candidate[] {
  const out: Candidate[] = []
  for (const [date, text] of Object.entries(team.dailyNotes)) {
    out.push({ raw: text, title: formatDate(date, doc.prefs.locale), ref: { kind: 'daily', date } })
  }
  for (const group of ['stakeholders', 'members'] as const) {
    for (const person of team[group]) {
      out.push({ raw: person.notes, title: person.name, ref: { kind: 'person', personId: person.id, group } })
    }
  }
  for (const item of team.actionItems) {
    out.push({ raw: `${item.text}\n${item.assignee}\n${item.notes}`, title: item.text, ref: { kind: 'actions', itemId: item.id } })
  }
  for (const milestone of team.milestones) {
    out.push({ raw: `${milestone.title}\n${milestone.followup}`, title: milestone.title, ref: { kind: 'milestones', itemId: milestone.id } })
  }
  for (const risk of team.risks) {
    out.push({ raw: `${risk.title}\n${risk.followup}`, title: risk.title, ref: { kind: 'risks', itemId: risk.id } })
  }
  return out
}

export function searchDocument(doc: Doc, query: string, scopeTeamId: string | null): SearchResult[] {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return []
  const terms = normalize(trimmedQuery).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const teams = scopeTeamId === null ? doc.teams : doc.teams.filter(team => team.id === scopeTeamId)
  const results: SearchResult[] = []

  for (const team of teams) {
    for (const candidate of collectCandidates(team, doc)) {
      const stripped = stripMd(candidate.raw)
      const normalized = normalize(stripped)
      if (!allTermsMatch(normalized, terms)) continue
      results.push({
        loc: { teamId: team.id, ref: candidate.ref },
        moduleKind: candidate.ref.kind,
        title: candidate.title,
        snippet: makeSnippet(stripped, normalized, terms),
        teamName: team.name,
      })
      if (results.length >= RESULT_LIMIT) return results
    }
  }
  return results
}
