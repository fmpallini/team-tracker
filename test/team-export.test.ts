import {
  buildExport,
  parseImportFile,
  remapForImport,
  InvalidExportFileError,
  ExportTooNewError,
  type TeamExportFile,
} from '../src/core/team-export'
import { SCHEMA_VERSION, createEmptyTeam } from '../src/core/document'
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

  it('seeds an empty generalNotes, matching createEmptyTeam\'s default for brand-new teams', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    expect(imported!.generalNotes).toBe('')
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
    expect(imported!.actionTagNames?.rust).toBe('Process')
    expect(imported!.actionTagNames?.brass).toBe('People')
    expect(imported!.actionTagNames?.slate).toBe('Financial')
    expect(imported!.actionTagNames?.sage).toBe('Technical')
    expect(imported!.actionTagNames?.plum).toBe('Operations')
    expect(imported!.actionTagNames?.ledger).toBe('Legal')
  })

  it('seeds the same default actionColumns a brand-new team gets, not zero middle columns', () => {
    const file = buildExport([sampleTeam()])
    const [imported] = remapForImport(file.teams, 'en-US')
    const brandNew = createEmptyTeam('new-id', 'New Team', '🆕', 'en-US')
    expect(imported!.actionColumns).toEqual(brandNew.actionColumns)
  })
})

describe('parseImportFile validates the shape instead of trusting it', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
  const file = (teams: unknown[]) => enc({ kind: 'team-tracker-teams-export', schemaVersion: SCHEMA_VERSION, exportedAt: 'x', teams })
  const person = (over: Record<string, unknown> = {}) => ({ id: 'p', name: 'N', role: 'r', parentId: null, order: 0, ...over })
  const team = (over: Record<string, unknown> = {}) => ({ name: 'T', emoji: '🚀', stakeholders: [], members: [], ...over })

  test.each([
    ['a team that is not an object', [null]],
    ['a team without a name', [team({ name: undefined })]],
    ['a team whose name is not a string', [team({ name: 5 })]],
    ['a team missing its stakeholders list', [team({ stakeholders: undefined })]],
    ['a team whose members is not an array', [team({ members: {} })]],
    ['a person that is not an object', [team({ members: ['x'] })]],
    ['a person without an id', [team({ members: [person({ id: undefined })] })]],
    ['a person with an empty id', [team({ members: [person({ id: '' })] })]],
    ['a person whose name is not a string', [team({ members: [person({ name: 5 })] })]],
    ['a person without an order', [team({ members: [person({ order: undefined })] })]],
    ['a person with a non-finite order', [team({ members: [person({ order: null })] })]],
    ['a person whose parentId is a number', [team({ members: [person({ parentId: 3 })] })]],
  ])('rejects %s', (_label, teams) => {
    expect(() => parseImportFile(file(teams))).toThrow(InvalidExportFileError)
  })

  test('is lenient about what a teammate can reasonably omit: emoji, role, a missing parentId', () => {
    const parsed = parseImportFile(file([team({ emoji: undefined, members: [person({ role: undefined, parentId: undefined })] })]))
    expect(parsed.teams[0]!.emoji).toBe('')
    expect(parsed.teams[0]!.members[0]).toMatchObject({ role: '', parentId: null })
  })

  test('a file produced by buildExport still parses to exactly what was exported', () => {
    const exported = buildExport([sampleTeam()])
    const parsed = parseImportFile(enc(exported))
    expect(parsed.teams).toEqual(exported.teams)
  })
})

describe('remapForImport keeps the imported structure sound', () => {
  const t = (members: Array<{ id: string; parentId: string | null; name?: string }>) => [{
    name: 'T', emoji: '', stakeholders: [],
    members: members.map((m, i) => ({ id: m.id, name: m.name ?? m.id, role: '', parentId: m.parentId, order: i })),
  }]

  test('people sharing a source id still get distinct new ids', () => {
    const out = remapForImport(t([{ id: 'd', parentId: null, name: 'one' }, { id: 'd', parentId: null, name: 'two' }]), 'en-US')
    const ids = out[0]!.members.map((m) => m.id)
    expect(new Set(ids).size).toBe(2)
  })

  test('a person that is its own parent becomes a root', () => {
    const out = remapForImport(t([{ id: 'a', parentId: 'a' }]), 'en-US')
    expect(out[0]!.members[0]!.parentId).toBeNull()
  })

  test('a parent cycle is cut so nobody becomes unreachable from a root', () => {
    const out = remapForImport(t([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]), 'en-US')
    const m = out[0]!.members
    expect(m.filter((p) => p.parentId === null).length).toBeGreaterThanOrEqual(1)
    const byId = new Map(m.map((p) => [p.id, p]))
    for (const p of m) { // every person reaches a root
      let cur = p; const seen = new Set<string>()
      while (cur.parentId !== null) { expect(seen.has(cur.id)).toBe(false); seen.add(cur.id); cur = byId.get(cur.parentId)! }
    }
  })

  test('someone hanging off a cycle keeps their own parent', () => {
    const out = remapForImport(t([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'a' }]), 'en-US')
    const [a, , c] = out[0]!.members
    expect(c!.parentId).toBe(a!.id)
  })

  test('a parent pointing at nobody in the file becomes a root; valid parents still map', () => {
    const out = remapForImport(t([{ id: 'a', parentId: 'ghost' }, { id: 'b', parentId: 'a' }]), 'en-US')
    const [a, b] = out[0]!.members
    expect(a!.parentId).toBeNull()
    expect(b!.parentId).toBe(a!.id)
  })
})
