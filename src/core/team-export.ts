// src/core/team-export.ts — export/import a subset of teams as a plain,
// unencrypted JSON file. Deliberately narrower than a Team: only the org
// structure (name/emoji, stakeholders, members — hierarchy and roles, no
// notes) is included. Action items, milestones, risks, and all free-text
// content are intentionally excluded — this file is meant to be handed to
// teammates so they can skip re-entering the team/people structure, not to
// carry work content. See docs/superpowers/specs/2026-07-16-team-export-
// import-design.md and 2026-07-21-shell-layout-export-help-fixes-design.md.
import type { ActionItem, Person, Team } from './types'
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
  return d as TeamExportFile
}

function remapPersonList(people: ExportedPerson[]): Team['stakeholders'] {
  const idMap = new Map<string, string>()
  for (const p of people) idMap.set(p.id, crypto.randomUUID())
  return people.map((p) => ({
    id: idMap.get(p.id)!,
    name: p.name,
    role: p.role,
    parentId: p.parentId !== null ? (idMap.get(p.parentId) ?? null) : null,
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
function defaultActionTagNames(locale: Locale): Partial<Record<ActionItem['color'], string>> {
  const names: Partial<Record<ActionItem['color'], string>> = {}
  for (const [color, key] of Object.entries(SUGGESTED_TAG_NAME_KEYS) as [ActionItem['color'], MsgKey][]) {
    names[color] = t(locale, key)
  }
  return names
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
    actionTagNames: defaultActionTagNames(locale),
  }))
}
