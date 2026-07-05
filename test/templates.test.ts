import { builtinTemplates, resolveTemplate } from '../src/core/templates'
import { createEmptyDocument } from '../src/core/document'

test('five builtins with scopes', () => {
  const ts = builtinTemplates('pt-BR')
  expect(ts).toHaveLength(5)
  expect(ts.map(t => t.scope).sort()).toEqual(['any', 'daily', 'daily', 'personal', 'personal'])
  expect(new Set(ts.map(t => t.id)).size).toBe(5)
})

test('resolveTemplate fills placeholders', () => {
  const out = resolveTemplate('## 1:1 — {data} {hora} {pessoa} {time}',
    { dateIso: '2026-07-02', time: '14:30', personName: 'Ana', teamName: 'Alpha', locale: 'pt-BR' })
  expect(out).toBe('## 1:1 — 02/07/2026 14:30 Ana Alpha')
})

test('empty document seeds builtins', () => {
  expect(createEmptyDocument('pt-BR').templates).toHaveLength(5)
})
