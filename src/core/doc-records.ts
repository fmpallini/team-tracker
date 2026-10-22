// src/core/doc-records.ts — splits a Doc into path-addressed records for the
// browser live store (live-persist.ts diffs them, live-store.ts seals and
// writes them) and joins them back.
//
// Paths:
//   doc                              the Doc minus teams/templates/images, plus _order { teams, templates }
//   team/<t>                         the team minus its collections, notes and daily notes, plus _order
//   team/<t>/daily/<date>            one daily note (a string)
//   team/<t>/general                 the general notes (a string; absent when the team has none)
//   team/<t>/<collection>/<e>        one stakeholder | member | action item | milestone | risk
//   tpl/<id>                         one template
//   img/<id>                         one image's metadata
// Every path segment is encodeURIComponent-ed (ids are free-form strings).
//
// Whatever else lives on a doc or team object stays in its remainder record, so a
// newly added scalar field is persisted without touching this file; a newly
// added *collection* is stored coarsely inside the remainder, which is correct,
// just not minimal. The `_order` lists name record keys, not ids: a damaged
// file may carry two entities with one id, and each must keep its own record
// (the later duplicate gets a `~n` suffix) instead of silently overwriting the first.
//
// Entity, template and image records are the live objects themselves, not copies:
// a consumer that keeps them across a later edit must serialize them first.
import type { Doc, Team, Template } from './types'

export type DocRecords = Map<string, unknown>

/** Each record as its JSON text — what the persister diffs, and what the live store seals or stores as it is. */
export function serializeRecords(records: DocRecords): Map<string, string> {
  return new Map([...records].map(([path, value]) => [path, JSON.stringify(value)]))
}

const COLLECTIONS = ['stakeholders', 'members', 'actionItems', 'milestones', 'risks'] as const
type Collection = typeof COLLECTIONS[number]

const seg = encodeURIComponent
const unseg = decodeURIComponent

/** The record path of one image's metadata. */
export const imageRecordPath = (id: string): string => `img/${seg(id)}`

/** One distinct path segment per id, in input order. */
function uniqueKeys(ids: string[]): string[] {
  const seen = new Set<string>()
  return ids.map((id) => {
    let key = seg(id)
    for (let n = 1; seen.has(key); n++) key = `${seg(id)}~${n}`
    seen.add(key)
    return key
  })
}

type Plain = Record<string, unknown>

export function splitDoc(doc: Doc): DocRecords {
  const out: DocRecords = new Map()
  const { teams, templates, images, ...docRest } = doc
  const teamKeys = uniqueKeys(teams.map((t) => t.id))
  const tplKeys = uniqueKeys(templates.map((t) => t.id))
  out.set('doc', { ...docRest, _order: { teams: teamKeys, templates: tplKeys } })
  teams.forEach((team, i) => splitTeam(out, teamKeys[i]!, team))
  templates.forEach((tpl, i) => out.set(`tpl/${tplKeys[i]}`, tpl))
  for (const [id, meta] of Object.entries(images)) out.set(imageRecordPath(id), meta)
  return out
}

function splitTeam(out: DocRecords, tk: string, team: Team): void {
  const rest: Plain = { ...team }
  const order: Partial<Record<Collection, string[]>> = {}
  for (const c of COLLECTIONS) {
    const list = team[c] as unknown
    delete rest[c]
    if (!Array.isArray(list)) continue
    const keys = uniqueKeys((list as { id: string }[]).map((e) => e.id))
    order[c] = keys
    list.forEach((e, i) => out.set(`team/${tk}/${c}/${keys[i]}`, e))
  }
  delete rest.dailyNotes
  for (const [date, body] of Object.entries(team.dailyNotes ?? {})) out.set(`team/${tk}/daily/${seg(date)}`, body)
  if (typeof team.generalNotes === 'string') {
    delete rest.generalNotes
    out.set(`team/${tk}/general`, team.generalNotes)
  }
  out.set(`team/${tk}`, { ...rest, _order: order })
}

interface TeamParts {
  team?: Plain
  general?: string
  daily: Map<string, string>
  coll: Record<Collection, Map<string, unknown>>
}

const COLLECTION_SET: ReadonlySet<string> = new Set(COLLECTIONS)

/** `keys` first (those that exist), then any record not listed, in path order. */
function ordered<T>(keys: string[] | undefined, byKey: Map<string, T>): T[] {
  const listed = new Set(keys ?? [])
  const out: T[] = []
  for (const k of keys ?? []) if (byKey.has(k)) out.push(byKey.get(k)!)
  for (const k of [...byKey.keys()].sort()) if (!listed.has(k)) out.push(byKey.get(k)!)
  return out
}

export function joinDoc(records: DocRecords): Doc {
  const head = records.get('doc') as Plain | undefined
  if (!head) throw new Error('missing doc record')
  const parts = new Map<string, TeamParts>()
  const partsOf = (tk: string): TeamParts => {
    let p = parts.get(tk)
    if (!p) {
      p = { daily: new Map(), coll: { stakeholders: new Map(), members: new Map(), actionItems: new Map(), milestones: new Map(), risks: new Map() } }
      parts.set(tk, p)
    }
    return p
  }
  const templates = new Map<string, Template>()
  const images: Doc['images'] = {}
  for (const path of [...records.keys()].sort()) {
    const value = records.get(path)
    const bits = path.split('/')
    if (bits[0] === 'team' && bits.length === 2) partsOf(bits[1]!).team = value as Plain
    else if (bits[0] === 'team' && bits.length === 3 && bits[2] === 'general') partsOf(bits[1]!).general = value as string
    else if (bits[0] === 'team' && bits.length === 4 && bits[2] === 'daily') partsOf(bits[1]!).daily.set(unseg(bits[3]!), value as string)
    else if (bits[0] === 'team' && bits.length === 4 && COLLECTION_SET.has(bits[2]!)) partsOf(bits[1]!).coll[bits[2] as Collection].set(bits[3]!, value)
    else if (bits[0] === 'tpl' && bits.length === 2) templates.set(bits[1]!, value as Template)
    else if (bits[0] === 'img' && bits.length === 2) images[unseg(bits[1]!)] = value as Doc['images'][string]
  }

  const { _order, ...docRest } = head as Plain & { _order?: { teams?: string[]; templates?: string[] } }
  const teams: Team[] = []
  const teamsByKey = new Map<string, Team>()
  for (const [tk, p] of parts) if (p.team) teamsByKey.set(tk, joinTeam(p))
  for (const t of ordered(_order?.teams, teamsByKey)) teams.push(t)
  return { ...docRest, teams, templates: ordered(_order?.templates, templates), images } as unknown as Doc
}

function joinTeam(p: TeamParts): Team {
  const { _order, ...rest } = p.team as Plain & { _order?: Partial<Record<Collection, string[]>> }
  const team: Plain = { ...rest }
  for (const c of COLLECTIONS) {
    const keys = _order?.[c]
    if (Array.isArray(keys) || p.coll[c].size > 0) team[c] = ordered(keys, p.coll[c])
  }
  team.dailyNotes = Object.fromEntries([...p.daily].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  if (p.general !== undefined) team.generalNotes = p.general
  return team as unknown as Team
}
