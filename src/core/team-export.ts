// src/core/team-export.ts — export/import a subset of teams as a plain,
// unencrypted JSON file. Deliberately narrower than a Team: strips
// `Team.dailyNotes` and every `Person.notes` structurally (the types below
// have no field to carry them), while keeping ActionItem/Milestone/Risk in
// full — their free-text fields (notes/followup) are intrinsic to the item,
// not personal journaling. See docs/superpowers/specs/2026-07-16-team-
// export-import-design.md for the full rationale.
import type { ActionItem, Milestone, Person, Risk, Team } from './types'
import { SCHEMA_VERSION } from './document'

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
  actionItems: ActionItem[]
  milestones: Milestone[]
  risks: Risk[]
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
      actionItems: t.actionItems,
      milestones: t.milestones,
      risks: t.risks,
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
export function remapForImport(teams: ExportedTeam[]): Team[] {
  return teams.map((t) => ({
    id: crypto.randomUUID(),
    name: `${t.name} (imported)`,
    emoji: t.emoji,
    stakeholders: remapPersonList(t.stakeholders),
    members: remapPersonList(t.members),
    actionItems: t.actionItems.map((a) => ({ ...a, id: crypto.randomUUID() })),
    milestones: t.milestones.map((m) => ({ ...m, id: crypto.randomUUID() })),
    risks: t.risks.map((r) => ({ ...r, id: crypto.randomUUID() })),
    dailyNotes: {},
  }))
}
