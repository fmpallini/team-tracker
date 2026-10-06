import type { ActionItemColor, Doc, Team } from './types'
import { builtinTemplates } from './templates'
import { t, type Locale, type MsgKey } from './i18n'

export const SCHEMA_VERSION = 15

export class SchemaTooNewError extends Error {}

export function createEmptyDocument(locale: Locale): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 10, palette: 'ledger', dueSoonDays: 7, openRefsInSecondaryPane: false, dailyBackupEnabled: false, backupHandleId: null, backupFrequency: 'daily', ctrlWheelFontSize: true, dailyEdgeScroll: true },
    templates: builtinTemplates(locale),
    nav: { activeTeamId: null, split: false, focusedPane: 0,
      panes: [{ history: [], index: -1 }, { history: [], index: -1 }], teamSplit: {}, sidebarCollapsed: false, calendarCollapsed: false },
    teams: [],
    favorites: [],
  }
}

/**
 * All six action-item colors, each carrying a suggested category tag name.
 * Single source for both consumers: `createEmptyTeam` below seeds new
 * teams with these names as real, editable data, and the kanban
 * (src/modules/action-items.ts) shows the same names as placeholder
 * fallbacks for teams that cleared one or predate the seeding.
 */
export const SUGGESTED_TAG_NAME_KEYS: Partial<Record<ActionItemColor, MsgKey>> = {
  rust: 'kanban_suggest_process', brass: 'kanban_suggest_people', slate: 'kanban_suggest_financial',
  sage: 'kanban_suggest_technical', plum: 'kanban_suggest_operations', ledger: 'kanban_suggest_legal',
}

export function createEmptyTeam(id: string, name: string, emoji: string, locale: Locale): Team {
  const actionTagNames: Partial<Record<ActionItemColor, string>> = {}
  for (const [color, key] of Object.entries(SUGGESTED_TAG_NAME_KEYS) as [ActionItemColor, MsgKey][]) {
    actionTagNames[color] = t(locale, key)
  }
  return {
    id, name, emoji,
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [],
    dailyNotes: {},
    actionTagNames,
    actionColumns: [{ id: 'wip', name: t(locale, 'kanban_wip_default_name'), order: 0 }],
    generalNotes: '',
  }
}

export function findTeam(doc: Doc, teamId: string): Team | undefined {
  return doc.teams.find((tm) => tm.id === teamId)
}

/**
 * The date in `dailyNotes` nearest to `fromIso` (exclusive) whose note is
 * non-empty, searching forward (`dir` 1) or backward (`dir` -1). Any run of
 * empty or absent days in between is skipped; whitespace-only notes count as
 * empty (same `.trim()` test the calendar's has-note tint uses). Returns
 * null when there is no dated note in that direction.
 *
 * Shared by the daily-notes Alt+Shift+[ / Alt+Shift+] hotkey ("jump to the
 * prev/next day that actually has content", main.ts's `dayNav` case).
 */
export function nearestDatedNote(
  dailyNotes: Record<string, string>,
  fromIso: string,
  dir: -1 | 1,
): string | null {
  const dated = Object.entries(dailyNotes)
    .filter(([, note]) => note.trim() !== '')
    .map(([d]) => d)
    .sort()
  if (dir === 1) return dated.find((d) => d > fromIso) ?? null
  for (let i = dated.length - 1; i >= 0; i--) {
    const d = dated[i]!
    if (d < fromIso) return d
  }
  return null
}

const MIGRATIONS: Record<number, (d: Record<string, unknown>) => void> = {
  1: (d) => {
    for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
      for (const r of (team.risks as Record<string, unknown>[]) ?? []) r.closed = r.closed ?? false
      for (const a of (team.actionItems as Record<string, unknown>[]) ?? []) a.notes = a.notes ?? ''
      for (const m of (team.milestones as Record<string, unknown>[]) ?? []) m.followup = m.followup ?? ''
    }
  },
  2: (d) => {
    const nav = d.nav as Record<string, unknown> | undefined
    if (nav && typeof nav.teamSplit !== 'object') nav.teamSplit = {}
  },
  3: (d) => {
    for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
      const items = (team.actionItems as Record<string, unknown>[]) ?? []
      for (const a of items) {
        a.summary = a.text ?? ''
        delete a.text
        a.status = a.done ? 'done' : 'todo'
        delete a.done
        a.color = a.color ?? 'ledger'
      }
      const byStatus = new Map<string, Record<string, unknown>[]>()
      for (const a of items) {
        const key = a.status as string
        const arr = byStatus.get(key) ?? []
        arr.push(a)
        byStatus.set(key, arr)
      }
      for (const arr of byStatus.values()) {
        arr.sort((x, y) => (x.order as number) - (y.order as number))
        arr.forEach((a, i) => { a.order = i })
      }
    }
  },
  4: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) prefs.palette = prefs.palette ?? 'ledger'
  },
  5: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) prefs.dueSoonDays = prefs.dueSoonDays ?? 7
  },
  6: (d) => {
    const nav = d.nav as Record<string, unknown> | undefined
    if (nav) nav.sidebarCollapsed = nav.sidebarCollapsed ?? false
  },
  7: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) prefs.openRefsInSecondaryPane = prefs.openRefsInSecondaryPane ?? false
  },
  8: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) {
      prefs.dailyBackupEnabled = prefs.dailyBackupEnabled ?? false
      prefs.backupHandleId = prefs.backupHandleId ?? null
    }
  },
  9: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) prefs.backupFrequency = prefs.backupFrequency ?? 'daily'
  },
  // 'muster' was dropped (near-indistinguishable from 'forest' — same
  // brown/orange accent, same pale khaki-green background, in both light
  // and dark) in favor of two more visually distinct palettes, 'verdant'
  // (green) and 'ember' (red) — neither hue previously existed in the set.
  // Remap to 'forest', the closest surviving palette by accent hue, so a
  // document saved under 'muster' keeps roughly the same look instead of
  // silently falling back to the 'ledger' default (which [data-palette]'s
  // CSS does for any unrecognized value).
  10: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs?.palette === 'muster') prefs.palette = 'forest'
  },
  11: (d) => {
    const nav = d.nav as Record<string, unknown> | undefined
    if (nav) nav.calendarCollapsed = nav.calendarCollapsed ?? false
  },
  12: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    const locale: Locale = prefs?.locale === 'pt-BR' ? 'pt-BR' : 'en-US'
    for (const team of (d.teams as Record<string, unknown>[]) ?? []) {
      if (!Array.isArray(team.actionColumns)) {
        team.actionColumns = [{ id: 'wip', name: t(locale, 'kanban_wip_default_name'), order: 0 }]
      }
    }
  },
  13: (d) => {
    const prefs = d.prefs as Record<string, unknown> | undefined
    if (prefs) {
      prefs.ctrlWheelFontSize = prefs.ctrlWheelFontSize ?? true
      prefs.dailyEdgeScroll = prefs.dailyEdgeScroll ?? true
    }
  },
  14: (d) => {
    d.favorites = Array.isArray(d.favorites) ? d.favorites : []
  },
}

export function migrate(raw: unknown): Doc {
  const d = raw as { schemaVersion?: unknown } & Record<string, unknown>
  if (typeof d?.schemaVersion !== 'number') throw new Error('invalid document')
  if (d.schemaVersion > SCHEMA_VERSION) throw new SchemaTooNewError()
  for (let v = d.schemaVersion; v < SCHEMA_VERSION; v++) {
    MIGRATIONS[v]?.(d); d.schemaVersion = v + 1
  }
  return d as unknown as Doc
}

/**
 * Reused by the team export/import feature (src/core/team-export.ts) to
 * bring an imported file's teams up to the current shape before their IDs
 * get remapped. Feeds `migrate()` a shim doc missing `nav`/`prefs` — every
 * `MIGRATIONS` step already guards on those keys' presence (see steps 2 and
 * 4 above) before touching them, so the doc-scoped steps safely no-op here
 * while the team-scoped ones (1, 3) still apply. Same table, same
 * guarantees `.tmv` opening already has — no separate migration ladder.
 *
 * Generic over `T` rather than fixed to `Team`: an export file's teams are
 * narrower than a full `Team` (no `id`/`dailyNotes` — see team-export.ts's
 * `ExportedTeam`), and the migrations here only ever mutate the nested
 * actionItems/milestones/risks arrays, never those two fields — so the
 * input shape passes through unchanged except for what the migrations
 * actually touch.
 */
export function migrateTeams<T>(teams: T[], fromVersion: number): T[] {
  const result = migrate({ schemaVersion: fromVersion, teams }) as unknown as { teams: T[] }
  return result.teams
}

/**
 * Gap 4: structural validation of a document that has already been through
 * `migrate()`. `migrate()` itself only checks that `schemaVersion` is a
 * number and then casts — so a truncated or hand-edited plain file (the
 * `TMV-PLAIN` format is deliberately human-readable, see crypto.ts) could
 * load as a `Doc` that lies about its own shape. The app would then render
 * against it, and the next auto-save would write that gutted doc straight
 * back over the user's real file. This is the check that stops that.
 *
 * Returns the dotted path of the FIRST violation (`teams[0].members[3].id`)
 * or null when the shape is sound. Callers — crypto.ts's `decryptDocument`
 * and `parsePlain`, the only two Doc-producing load paths — turn a non-null
 * result into a `CorruptFileError` carrying that path, so the user gets an
 * actionable message instead of a crash.
 *
 * Deliberately NOT called from `migrate()`'s tail: `migrateTeams()` feeds
 * `migrate()` a shim doc with no prefs/nav/templates (see its comment), and
 * validating there would break team import.
 *
 * Structure only — never business rules. Enum membership (`status`, `plan`,
 * `color`, `palette`) and referential integrity (`assignee` naming a real
 * person) are NOT checked: thirteen migrations have left real files loose in
 * exactly those places, and refusing on them would reject documents that
 * open fine today. The bar here is "can the app render this without
 * crashing", not "is every value canonical".
 *
 * `prefs`, `nav`, `templates` and `teams` are all required rather than
 * tolerated-when-absent: no `MIGRATIONS` step ever creates one from scratch
 * (they only patch what's already there), so a document missing one has
 * never been openable in any released version — the shell reads all four
 * unguarded. Refusing it by name beats crashing halfway through a render.
 */
type FieldType = 'string' | 'id' | 'number' | 'boolean' | 'string|null' | 'any'

const PERSON_FIELDS: Record<string, FieldType> = {
  id: 'id', name: 'string', role: 'string', parentId: 'string|null', order: 'number', notes: 'string',
}
const ACTION_ITEM_FIELDS: Record<string, FieldType> = {
  id: 'id', summary: 'string', notes: 'string', status: 'string',
  dueDate: 'string|null', assignee: 'string', color: 'string|null', order: 'number',
}
const MILESTONE_FIELDS: Record<string, FieldType> = {
  id: 'id', date: 'string', title: 'string', done: 'boolean', followup: 'string',
}
const RISK_FIELDS: Record<string, FieldType> = {
  id: 'id', title: 'string', chance: 'number', impact: 'number',
  plan: 'string', followup: 'string', order: 'number', closed: 'boolean',
}
const ACTION_COLUMN_FIELDS: Record<string, FieldType> = {
  id: 'id', name: 'string', order: 'number',
}
const TEMPLATE_FIELDS: Record<string, FieldType> = {
  id: 'id', name: 'string', scope: 'string', body: 'string',
}

const TEAM_COLLECTIONS: [string, Record<string, FieldType>][] = [
  ['stakeholders', PERSON_FIELDS], ['members', PERSON_FIELDS],
  ['actionItems', ACTION_ITEM_FIELDS], ['milestones', MILESTONE_FIELDS], ['risks', RISK_FIELDS],
]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fieldOk(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'id': return typeof value === 'string' && value !== ''
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'string|null': return value === null || typeof value === 'string'
    case 'any': return true
  }
}

/** Validates one array of same-shaped entities, returning the first bad path. */
function validateEntities(arr: unknown, spec: Record<string, FieldType>, path: string): string | null {
  if (!Array.isArray(arr)) return path
  for (let i = 0; i < arr.length; i++) {
    const entity: unknown = arr[i]
    if (!isPlainObject(entity)) return `${path}[${i}]`
    for (const [field, type] of Object.entries(spec)) {
      if (!fieldOk(entity[field], type)) return `${path}[${i}].${field}`
    }
  }
  return null
}

export function validateDoc(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'document'
  if (!isPlainObject(raw.prefs)) return 'prefs'
  if (!isPlainObject(raw.nav)) return 'nav'

  const templatesBad = validateEntities(raw.templates, TEMPLATE_FIELDS, 'templates')
  if (templatesBad) return templatesBad

  // Required since schema 15 (MIGRATIONS[14] always creates it, and validateDoc
  // only ever sees a migrated doc). `ref` is checked structurally (a plain
  // object with a string `kind`); whether it still points at something real is
  // deliberately not checked — dead favorites are inert (core/favorites.ts).
  if (!Array.isArray(raw.favorites)) return 'favorites'
  for (let i = 0; i < raw.favorites.length; i++) {
    const fav: unknown = raw.favorites[i]
    const at = `favorites[${i}]`
    if (!isPlainObject(fav)) return at
    if (!fieldOk(fav.teamId, 'id')) return `${at}.teamId`
    if (!isPlainObject(fav.ref)) return `${at}.ref`
    if (!fieldOk(fav.ref.kind, 'string')) return `${at}.ref.kind`
  }

  if (!Array.isArray(raw.teams)) return 'teams'
  for (let i = 0; i < raw.teams.length; i++) {
    const team: unknown = raw.teams[i]
    const at = `teams[${i}]`
    if (!isPlainObject(team)) return at
    if (!fieldOk(team.id, 'id')) return `${at}.id`
    if (!fieldOk(team.name, 'string')) return `${at}.name`

    for (const [key, spec] of TEAM_COLLECTIONS) {
      const bad = validateEntities(team[key], spec, `${at}.${key}`)
      if (bad) return bad
    }

    // Optional since schema 12 — validated only when the team carries it.
    if (team.actionColumns !== undefined) {
      const bad = validateEntities(team.actionColumns, ACTION_COLUMN_FIELDS, `${at}.actionColumns`)
      if (bad) return bad
    }

    if (!isPlainObject(team.dailyNotes)) return `${at}.dailyNotes`
    for (const [date, body] of Object.entries(team.dailyNotes)) {
      if (typeof body !== 'string') return `${at}.dailyNotes["${date}"]`
    }
  }
  return null
}
