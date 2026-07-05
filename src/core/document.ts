import type { Doc } from './types'
import { builtinTemplates } from './templates'

export const SCHEMA_VERSION = 1

export class SchemaTooNewError extends Error {}

export function createEmptyDocument(locale: 'pt-BR' | 'en-US'): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    prefs: { theme: 'system', locale, font: 'system', fontSize: 'M', autoSaveMin: 5 },
    templates: builtinTemplates(locale),
    nav: { activeTeamId: null, split: false, focusedPane: 0,
      panes: [{ history: [], index: -1 }, { history: [], index: -1 }] },
    teams: [],
  }
}

const MIGRATIONS: Record<number, (d: Record<string, unknown>) => void> = {
  // 1 → 2 entraria aqui como MIGRATIONS[1]
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
