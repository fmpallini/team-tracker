import { builtinTemplates, resolveTemplate, reseedBuiltinTemplates } from '../src/core/templates'
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

test('reseedBuiltinTemplates swaps an untouched builtin to the new locale', () => {
  const ts = builtinTemplates('en-US')
  const reseeded = reseedBuiltinTemplates(ts, 'en-US', 'pt-BR')
  const oneOnOne = reseeded.find(t => t.id === ts[0]!.id)!
  expect(oneOnOne.name).toBe('1:1')
  expect(oneOnOne.body).toContain('Como está / energia')
  // id, scope, and array position are preserved
  expect(reseeded.map(t => t.id)).toEqual(ts.map(t => t.id))
  expect(reseeded[0]!.scope).toBe(ts[0]!.scope)
})

test('reseedBuiltinTemplates leaves an edited template untouched', () => {
  const ts = builtinTemplates('en-US')
  const edited = ts.map((t, i) => (i === 0 ? { ...t, body: 'my custom body' } : t))
  const reseeded = reseedBuiltinTemplates(edited, 'en-US', 'pt-BR')
  expect(reseeded[0]!.name).toBe('1:1') // name untouched too — partial edit means "leave the whole entry alone"
  expect(reseeded[0]!.body).toBe('my custom body')
  // the other 4, still exact matches, do get swapped
  expect(reseeded[1]!.body).not.toBe(ts[1]!.body)
})

test('reseedBuiltinTemplates leaves a user-authored template untouched', () => {
  const ts = builtinTemplates('en-US')
  const withCustom = [...ts, { id: 'custom-1', name: 'My own template', scope: 'any' as const, body: 'whatever I want' }]
  const reseeded = reseedBuiltinTemplates(withCustom, 'en-US', 'pt-BR')
  expect(reseeded.find(t => t.id === 'custom-1')).toEqual(withCustom[5])
})
