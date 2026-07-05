import { searchDocument, normalize } from '../src/core/search'
import { createEmptyDocument } from '../src/core/document'
import type { Team } from '../src/core/types'

const team = (id: string, name: string): Team => ({ id, name, emoji: '🧭', stakeholders: [], members: [],
  actionItems: [], milestones: [], risks: [], dailyNotes: {} })

function fixture() {
  const d = createEmptyDocument('pt-BR')
  const t1 = team('t1', 'Alpha'), t2 = team('t2', 'Beta')
  t1.dailyNotes['2026-07-01'] = '# Reunião\nDiscussão sobre **orçamento** anual'
  t1.members.push({ id: 'p1', name: 'Ana', role: 'Dev', parentId: null, order: 0, notes: 'Promoção pendente' })
  t2.risks.push({ id: 'r1', title: 'Atraso fornecedor', chance: 2, impact: 3, plan: 'mitigate', followup: 'orcamento extra aprovado', order: 0, closed: false })
  d.teams.push(t1, t2)
  return d
}

test('normalize strips accents and case', () => {
  expect(normalize('Reunião ORÇAMENTO')).toBe('reuniao orcamento')
})

test('finds accent-insensitive within team scope', () => {
  const r = searchDocument(fixture(), 'orcamento', 't1')
  expect(r).toHaveLength(1)
  expect(r[0]!.loc.ref).toEqual({ kind: 'daily', date: '2026-07-01' })
  expect(r[0]!.snippet).toContain('orçamento')
  expect(r[0]!.snippet).not.toContain('**')
})

test('all-teams scope and AND terms', () => {
  expect(searchDocument(fixture(), 'orcamento', null)).toHaveLength(2)
  expect(searchDocument(fixture(), 'orcamento extra', null)).toHaveLength(1)
  expect(searchDocument(fixture(), 'orcamento zzz', null)).toHaveLength(0)
})

test('person notes searchable', () => {
  const r = searchDocument(fixture(), 'promocao', 't1')
  expect(r[0]!.loc.ref.kind).toBe('person')
  expect(r[0]!.title).toBe('Ana')
})
