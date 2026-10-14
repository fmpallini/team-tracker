// src/core/team-export.ts — export/import a subset of teams as a plain,
// unencrypted JSON file. Deliberately narrower than a Team: only the org
// structure (name/emoji, stakeholders, members — hierarchy and roles, no
// notes) is included. Action items, milestones, risks, and all free-text
// content are intentionally excluded — this file is meant to be handed to
// teammates so they can skip re-entering the team/people structure, not to
// carry work content. See docs/superpowers/specs/2026-07-16-team-export-
// import-design.md and 2026-07-21-shell-layout-export-help-fixes-design.md.
import type { ActionColumn, ActionItemColor, Person, Team } from './types'
import { SCHEMA_VERSION, SUGGESTED_TAG_NAME_KEYS } from './document'
import { t, type Locale, type MsgKey } from './i18n'

export class InvalidExportFileError extends Error {}
export class ExportTooNewError extends Error {}

export interface ExportedPerson {
  id: string
  name: string
  role: string
  parentId: string | null
  order: number
}

export interface ExportedTeam {
  name: string
  emoji: string
  stakeholders: ExportedPerson[]
  members: ExportedPerson[]
}

export interface TeamExportFile {
  kind: 'team-tracker-teams-export'
  schemaVersion: number
  exportedAt: string
  teams: ExportedTeam[]
}

function stripPerson(p: Person): ExportedPerson {
  return { id: p.id, name: p.name, role: p.role, parentId: p.parentId, order: p.order }
}

export function buildExport(teams: Team[]): TeamExportFile {
  return {
    kind: 'team-tracker-teams-export',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    teams: teams.map((t) => ({
      name: t.name,
      emoji: t.emoji,
      stakeholders: t.stakeholders.map(stripPerson),
      members: t.members.map(stripPerson),
    })),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parsePeople(list: unknown): ExportedPerson[] {
  if (!Array.isArray(list)) throw new InvalidExportFileError()
  return list.map((raw: unknown): ExportedPerson => {
    if (!isRecord(raw)) throw new InvalidExportFileError()
    // id, name and order are what the rest of the app (and validateDoc, on
    // every save) cannot do without; role and the parent link are tolerated
    // when a hand-edited file omits them.
    if (typeof raw.id !== 'string' || raw.id === '') throw new InvalidExportFileError()
    if (typeof raw.name !== 'string') throw new InvalidExportFileError()
    if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) throw new InvalidExportFileError()
    if (raw.role !== undefined && typeof raw.role !== 'string') throw new InvalidExportFileError()
    const parentId = raw.parentId ?? null
    if (parentId !== null && typeof parentId !== 'string') throw new InvalidExportFileError()
    return { id: raw.id, name: raw.name, role: raw.role ?? '', parentId, order: raw.order }
  })
}

export function parseImportFile(bytes: Uint8Array): TeamExportFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new InvalidExportFileError()
  }
  const d = parsed as Partial<TeamExportFile> | null
  if (
    !d ||
    typeof d !== 'object' ||
    d.kind !== 'team-tracker-teams-export' ||
    typeof d.schemaVersion !== 'number' ||
    !Array.isArray(d.teams)
  ) {
    throw new InvalidExportFileError()
  }
  if (d.schemaVersion > SCHEMA_VERSION) throw new ExportTooNewError()
  // The file is handed between people, so its teams are untrusted input: a
  // team that merely LOOKS valid used to crash the import checklist, or worse
  // import cleanly and then make every later save fail validateDoc.
  const teams = d.teams.map((raw: unknown): ExportedTeam => {
    if (!isRecord(raw) || typeof raw.name !== 'string') throw new InvalidExportFileError()
    if (raw.emoji !== undefined && typeof raw.emoji !== 'string') throw new InvalidExportFileError()
    return {
      name: raw.name,
      emoji: raw.emoji ?? '',
      stakeholders: parsePeople(raw.stakeholders),
      members: parsePeople(raw.members),
    }
  })
  return { ...(d as TeamExportFile), teams }
}

function remapPersonList(people: ExportedPerson[]): Team['stakeholders'] {
  // One fresh id per PERSON (not per source id): two entries sharing a source
  // id must not collapse into one id. A parent link resolves to the first
  // entry carrying that id.
  const fresh = people.map(() => crypto.randomUUID())
  const idMap = new Map<string, string>()
  people.forEach((p, i) => { if (!idMap.has(p.id)) idMap.set(p.id, fresh[i]!) })
  const parentOf = new Map<string, string | null>()
  people.forEach((p, i) => parentOf.set(fresh[i]!, p.parentId !== null ? (idMap.get(p.parentId) ?? null) : null))
  // A self-parent or a parent cycle would leave its members unreachable from
  // any root in the tree view (hidden, yet still present everywhere else).
  for (const id of fresh) {
    const seen = new Set<string>()
    let cur = parentOf.get(id) ?? null
    while (cur !== null) {
      if (cur === id) { parentOf.set(id, null); break } // this person is part of the cycle
      if (seen.has(cur)) break // hangs off a cycle that another member's turn will cut
      seen.add(cur)
      cur = parentOf.get(cur) ?? null
    }
  }
  return people.map((p, i) => ({
    id: fresh[i]!,
    name: p.name,
    role: p.role,
    parentId: parentOf.get(fresh[i]!) ?? null,
    order: p.order,
    notes: '',
  }))
}

/**
 * Every team/person/action-item/milestone/risk gets a fresh ID — imported
 * data is always additive (see design doc decision 3), never merged into an
 * existing team, so reusing source IDs would risk colliding with the
 * current file's own. The name suffix makes that unconditional regardless
 * of whether a same-named team already exists, so there's no collision-
 * detection logic to get wrong.
 */
/** Same default seeding `createEmptyTeam` (document.ts) gives brand-new teams — an imported team has no action items of its own to carry tag names from, so it starts fresh like any other new team. */
function defaultActionTagNames(locale: Locale): Partial<Record<ActionItemColor, string>> {
  const names: Partial<Record<ActionItemColor, string>> = {}
  for (const [color, key] of Object.entries(SUGGESTED_TAG_NAME_KEYS) as [ActionItemColor, MsgKey][]) {
    names[color] = t(locale, key)
  }
  return names
}

/** Mirrors `createEmptyTeam`'s (document.ts) single default middle column literal — an imported team starts with the same "WIP" starter column any brand-new team gets, not zero middle columns. */
function defaultActionColumns(locale: Locale): ActionColumn[] {
  return [{ id: 'wip', name: t(locale, 'kanban_wip_default_name'), order: 0 }]
}

export function remapForImport(teams: ExportedTeam[], locale: Locale): Team[] {
  return teams.map((src) => ({
    id: crypto.randomUUID(),
    name: `${src.name} ${t(locale, 'team_imported_suffix')}`,
    emoji: src.emoji,
    stakeholders: remapPersonList(src.stakeholders),
    members: remapPersonList(src.members),
    actionItems: [],
    milestones: [],
    risks: [],
    dailyNotes: {},
    generalNotes: '',
    actionTagNames: defaultActionTagNames(locale),
    actionColumns: defaultActionColumns(locale),
  }))
}
