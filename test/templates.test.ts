import { isOneOnOneCandidate, builtinTemplates, resolveTemplate, reseedBuiltinTemplates, upgradeLegacySeedBodies, ONE_ON_ONE_SEED_NAME } from '../src/core/templates'
import { createEmptyDocument } from '../src/core/document'

test('eight builtins with scopes', () => {
  const ts = builtinTemplates('pt-BR')
  expect(ts).toHaveLength(8)
  expect(ts.map(t => t.scope).sort()).toEqual(['any', 'any', 'any', 'any', 'personal', 'personal', 'personal', 'personal'])
  expect(new Set(ts.map(t => t.id)).size).toBe(8)
})

test('resolveTemplate fills the English placeholders', () => {
  const out = resolveTemplate('## 1:1 — {date} {time} {person} {team}',
    { dateIso: '2026-07-02', time: '14:30', personName: 'Ana', teamName: 'Alpha', locale: 'pt-BR' })
  expect(out).toBe('## 1:1 — Qui, 02/07/2026 14:30 Ana Alpha')
})

test('the old Portuguese placeholders are no longer recognised', () => {
  const out = resolveTemplate('{data} {hora} {pessoa}', { dateIso: '2026-07-02', time: '14:30', personName: 'Ana', teamName: 'Alpha', locale: 'pt-BR' })
  expect(out).toBe('{data} {hora} {pessoa}')
})

test('{time} is now the wall-clock time, not the team name', () => {
  expect(resolveTemplate('{time}', { dateIso: '2026-07-02', time: '9:05 AM', teamName: 'Alpha', locale: 'en-US' })).toBe('9:05 AM')
})

test('placeholders resolve the same in either locale; only the weekday and date format follow the locale', () => {
  const ctx = { dateIso: '2026-07-02', time: '14:30', locale: 'en-US' as const }
  expect(resolveTemplate('{date}', ctx)).toBe('Thu, 07/02/2026')
  expect(resolveTemplate('{date}', { ...ctx, locale: 'pt-BR' })).toBe('Qui, 02/07/2026')
})

test('no built-in template, in either locale, still uses a Portuguese placeholder', () => {
  for (const locale of ['pt-BR', 'en-US'] as const) {
    for (const tpl of builtinTemplates(locale)) expect(tpl.body).not.toMatch(/\{(data|hora|pessoa)\}/)
  }
})

test('empty document seeds builtins', () => {
  expect(createEmptyDocument('pt-BR').templates).toHaveLength(8)
})

test('reseedBuiltinTemplates swaps an untouched builtin to the new locale', () => {
  const ts = builtinTemplates('en-US')
  const reseeded = reseedBuiltinTemplates(ts, 'en-US', 'pt-BR')
  const i = ts.findIndex(t => t.name === '1:1')
  const oneOnOne = reseeded.find(t => t.id === ts[i]!.id)!
  expect(oneOnOne.name).toBe('1:1')
  expect(oneOnOne.body).toContain('Como está / energia')
  // id, scope, and array position are preserved
  expect(reseeded.map(t => t.id)).toEqual(ts.map(t => t.id))
  expect(reseeded[i]!.scope).toBe(ts[i]!.scope)
})

test('reseedBuiltinTemplates leaves an edited template untouched', () => {
  const ts = builtinTemplates('en-US')
  const edited = ts.map(t => (t.name === '1:1' ? { ...t, body: 'my custom body' } : t))
  const reseeded = reseedBuiltinTemplates(edited, 'en-US', 'pt-BR')
  const oneOnOne = reseeded.find(t => t.id === ts.find(s => s.name === '1:1')!.id)!
  expect(oneOnOne.name).toBe('1:1') // name untouched too — partial edit means "leave the whole entry alone"
  expect(oneOnOne.body).toBe('my custom body')
  // the others, still exact matches, do get swapped
  expect(reseeded[0]!.body).not.toBe(ts[0]!.body)
})

test('reseedBuiltinTemplates leaves a user-authored template untouched', () => {
  const ts = builtinTemplates('en-US')
  const withCustom = [...ts, { id: 'custom-1', name: 'My own template', scope: 'any' as const, body: 'whatever I want' }]
  const reseeded = reseedBuiltinTemplates(withCustom, 'en-US', 'pt-BR')
  expect(reseeded.find(t => t.id === 'custom-1')).toEqual(withCustom[8])
})

const LEGACY_EN = '## 1:1 — {date}\n### How are they / energy\n- \n### Their topics\n- \n### My topics\n- \n### Feedback\n- \n### Agreed actions\n- '
const LEGACY_PT = '## 1:1 — {date}\n### Como está / energia\n- \n### Tópicos dela(e)\n- \n### Meus tópicos\n- \n### Feedback\n- \n### Ações combinadas\n- '
const ctx = { dateIso: '2026-07-02', time: '14:30', locale: 'en-US' as const }

test('the 1:1 seed name is exported', () => {
  expect(ONE_ON_ONE_SEED_NAME).toBe('1:1')
})

test('new 1:1 seed (en-US) is the spec body', () => {
  expect(builtinTemplates('en-US').find(t => t.name === '1:1')!.body).toBe(
    '### 1:1 — {date}\n**Carried over**\n{carryover}\n**How are they / energy**\n- \n**Their topics**\n- \n**My topics**\n- \n**Feedback (given / received)**\n- \n**Agreed actions**\n- [ ] ')
})

test('pt-BR seed labels the carried section "Pendências anteriores"', () => {
  expect(builtinTemplates('pt-BR').find(t => t.name === '1:1')!.body).toContain('**Pendências anteriores**\n{carryover}\n')
})

test('{carryover} fills in place', () => {
  expect(resolveTemplate('## A\n### C\n{carryover}\n### B', { ...ctx, carryover: '- [ ] x' })).toBe('## A\n### C\n- [ ] x\n### B')
})

test('empty {carryover} removes its line and the heading above it', () => {
  expect(resolveTemplate('## A\n### C\n{carryover}\n### B', ctx)).toBe('## A\n### B')
})

test('empty {carryover} never removes the first line', () => {
  expect(resolveTemplate('## A\n{carryover}\n- x', ctx)).toBe('## A\n- x')
  expect(resolveTemplate('### C\n{carryover}\n- x', ctx)).toBe('### C\n- x')
})

test('empty {carryover} removes a lone bold label above it', () => {
  expect(resolveTemplate('## A\n**C**\n{carryover}\n**B:** x', ctx)).toBe('## A\n**B:** x')
  expect(resolveTemplate('## A\n**C:**\n{carryover}\n- x', ctx)).toBe('## A\n- x')
})

test('empty {carryover} under a bold label with text keeps that line', () => {
  expect(resolveTemplate('## A\n**C:** note\n{carryover}\n- x', ctx)).toBe('## A\n**C:** note\n- x')
})

test('empty {carryover} under a non-heading line keeps that line', () => {
  expect(resolveTemplate('## A\ntext\n{carryover}\n- x', ctx)).toBe('## A\ntext\n- x')
})

test('empty {carryover} inline stays empty text, nothing removed', () => {
  expect(resolveTemplate('x {carryover} y', ctx)).toBe('x  y')
})

test('the rendered 1:1 seed with no carry-over drops the Carried over section', () => {
  const body = builtinTemplates('en-US').find(t => t.name === '1:1')!.body
  expect(resolveTemplate(body, ctx)).toBe('### 1:1 — Thu, 07/02/2026\n**How are they / energy**\n- \n**Their topics**\n- \n**My topics**\n- \n**Feedback (given / received)**\n- \n**Agreed actions**\n- [ ] ')
})

test('reseed recognizes the legacy 1:1 body', () => {
  const tpl = { id: 'a', name: '1:1', scope: 'personal' as const, body: LEGACY_EN }
  const [out] = reseedBuiltinTemplates([tpl], 'en-US', 'pt-BR')
  expect(out!.body).toBe(builtinTemplates('pt-BR').find(t => t.name === '1:1')!.body)
})

test('upgradeLegacySeedBodies upgrades only exact legacy bodies', () => {
  const legacyPt = { id: 'p', name: '1:1', scope: 'personal' as const, body: LEGACY_PT }
  const legacyEn = { id: 'e', name: '1:1', scope: 'personal' as const, body: LEGACY_EN }
  const edited = { id: 'x', name: '1:1', scope: 'personal' as const, body: LEGACY_PT + 'extra' }
  const [p, e, x] = upgradeLegacySeedBodies([legacyPt, legacyEn, edited])
  expect(p!.body).toBe(builtinTemplates('pt-BR').find(t => t.name === '1:1')!.body)
  expect(e!.body).toBe(builtinTemplates('en-US').find(t => t.name === '1:1')!.body)
  expect(x).toBe(edited)
})

// Meeting as 3.7.4 shipped it, before the bold-label restyle.
const MEETING_374_EN = '## Meeting — {time}\n**Attendees:** \n### Agenda\n- \n### Decisions\n- \n### Actions (who → what → when)\n- '

test('upgradeLegacySeedBodies leaves later built-in versions alone (only Restore defaults moves them)', () => {
  const tpl = { id: 'm', name: 'Meeting', scope: 'daily' as const, body: MEETING_374_EN }
  expect(upgradeLegacySeedBodies([tpl])[0]).toBe(tpl)
})

test('isOneOnOneCandidate accepts only person-note templates', () => {
  const tpl = (scope: 'personal' | 'daily' | 'any') => ({ id: 'x', name: 'x', scope, body: '' })
  expect(isOneOnOneCandidate(tpl('personal'))).toBe(true)
  expect(isOneOnOneCandidate(tpl('any'))).toBe(false)
  expect(isOneOnOneCandidate(tpl('daily'))).toBe(false)
})
