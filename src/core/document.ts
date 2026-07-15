import type { Doc } from './types'
import { builtinTemplates } from './templates'

export const SCHEMA_VERSION = 4

export class SchemaTooNewError extends Error {}

export function createEmptyDocument(locale: 'pt-BR' | 'en-US'): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 10 },
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
