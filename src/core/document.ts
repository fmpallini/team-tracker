import type { Doc } from './types'
import { builtinTemplates } from './templates'

export const SCHEMA_VERSION = 5

export class SchemaTooNewError extends Error {}

export function createEmptyDocument(locale: 'pt-BR' | 'en-US'): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 10, palette: 'ledger' },
    templates: builtinTemplates(locale),
    nav: { activeTeamId: null, split: false, focusedPane: 0,
      panes: [{ history: [], index: -1 }, { history: [], index: -1 }], teamSplit: {} },
    teams: [],
  }
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
