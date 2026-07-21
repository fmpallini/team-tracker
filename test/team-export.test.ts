import {
  buildExport,
  parseImportFile,
  remapForImport,
  InvalidExportFileError,
  ExportTooNewError,
  type TeamExportFile,
} from '../src/core/team-export'
import { SCHEMA_VERSION } from '../src/core/document'
import type { Team } from '../src/core/types'

function sampleTeam(): Team {
  return {
    id: 't1', name: 'Engineering', emoji: '🚀',
    dailyNotes: { '2026-07-16': 'private daily note' },
    stakeholders: [
      { id: 'p1', name: 'Priya', role: 'Sponsor', parentId: null, order: 0, notes: 'private person note' },
    ],
    members: [
      { id: 'p2', name: 'Marcus', role: 'Manager', parentId: null, order: 0, notes: 'private' },
      { id: 'p3', name: 'Dana', role: 'Eng', parentId: 'p2', order: 0, notes: '' },
    ],
    actionItems: [
      { id: 'a1', summary: 'Access review', notes: 'SOC2 audit detail', status: 'todo', dueDate: null, assignee: 'Marcus', color: 'slate', order: 0 },
    ],
    milestones: [
      { id: 'm1', date: '2026-08-01', title: 'Launch', done: false, followup: 'ship checklist' },
    ],
    risks: [
      { id: 'r1', title: 'Vendor lock-in', chance: 2, impact: 3, plan: 'mitigate', followup: 'quarterly review', order: 0, closed: false },
    ],
    actionTagNames: { rust: 'Blocked' },
  }
}

describe('buildExport', () => {
  it('strips dailyNotes and every person.notes, omits team id', () => {
    const file = buildExport([sampleTeam()])
    const team = file.teams[0]!
    expect((team as unknown as { dailyNotes?: unknown }).dailyNotes).toBeUndefined()
    expect((team as unknown as { id?: unknown }).id).toBeUndefined()
    for (const p of [...team.stakeholders, ...team.members]) {
      expect((p as unknown as { notes?: unknown }).notes).toBeUndefined()
    }
  })

  it('omits actionItems, milestones, risks, and actionTagNames entirely — only org structure is exported', () => {
    const file = buildExport([sampleTeam()])
    const team = file.teams[0]! as unknown as Record<string, unknown>
    expect(team.actionItems).toBeUndefined()
    expect(team.milestones).toBeUndefined()
    expect(team.risks).toBeUndefined()
    expect(team.actionTagNames).toBeUndefined()
  })

  it('stamps the current schema version and kind marker', () => {
    const file = buildExport([sampleTeam()])
    expect(file.kind).toBe('team-tracker-teams-export')
    expect(file.schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe('parseImportFile', () => {
  function bytesOf(obj: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj))
  }

  it('rejects malformed JSON', () => {
    expect(() => parseImportFile(new TextEncoder().encode('not json'))).toThrow(InvalidExportFileError)
  })

  it('rejects a file missing the kind marker', () => {
    expect(() => parseImportFile(bytesOf({ schemaVersion: 1, teams: [] }))).toThrow(InvalidExportFileError)
  })

  it('rejects a schemaVersion newer than the app understands', () => {
    const file = { kind: 'team-tracker-teams-export', schemaVersion: SCHEMA_VERSION + 1, exportedAt: '', teams: [] }
    expect(() => parseImportFile(bytesOf(file))).toThrow(ExportTooNewError)
  })

  it('accepts a valid file at or below the current schema version', () => {
    const file: TeamExportFile = buildExport([sampleTeam()])
    expect(parseImportFile(bytesOf(file))).toEqual(file)
  })
})

describe('remapForImport', () => {
  it('gives every team/person a fresh id, distinct from the source', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    expect(imported!.id).not.toBe('t1')
    const allNewPersonIds = [...imported!.stakeholders, ...imported!.members].map((p) => p.id)
    expect(allNewPersonIds).not.toContain('p1')
    expect(allNewPersonIds).not.toContain('p2')
    expect(allNewPersonIds).not.toContain('p3')
    expect(new Set(allNewPersonIds).size).toBe(allNewPersonIds.length)
  })

  it('rebuilds parentId chains against the new ids, not the old ones', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    const manager = imported!.members.find((p) => p.name === 'Marcus')!
    const report = imported!.members.find((p) => p.name === 'Dana')!
    expect(report.parentId).toBe(manager.id)
  })

  it('appends " (imported)" to the name unconditionally', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    expect(imported!.name).toBe('Engineering (imported)')
  })

  it('leaves dailyNotes empty and person notes empty on the reconstructed Team', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    expect(imported!.dailyNotes).toEqual({})
    expect(imported!.stakeholders[0]!.notes).toBe('')
  })

  it('starts with no action items, milestones, or risks — none were exported', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    expect(imported!.actionItems).toEqual([])
    expect(imported!.milestones).toEqual([])
    expect(imported!.risks).toEqual([])
  })

  it('seeds fresh default actionTagNames (locale-appropriate), ignoring the source team\'s own', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    expect(imported!.actionTagNames?.rust).toBe('Urgent')
    expect(imported!.actionTagNames?.brass).toBe('Blocked')
    expect(imported!.actionTagNames?.slate).toBe('In Review')
  })
})
