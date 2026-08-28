import { t, formatDate, parseLocaleDate } from '../src/core/i18n'

test('t interpolates', () => {
  expect(t('pt-BR', 'app_name')).toBe('Team Tracker')
})

test('t substitutes a named {param}', () => {
  expect(t('pt-BR', 'backlinks_badge_title', { count: '5' })).toBe('5 referências')
})

test('t substitutes every distinct placeholder in one message', () => {
  expect(
    t('pt-BR', 'data_cleanup_confirm_body', { actions: '1', milestones: '2', risks: '3', dailyNotes: '4' })
  ).toContain('1 tarefas, 2 marcos, 3 riscos e 4 notas diárias')
})

test('t leaves placeholder-shaped text alone when no params are given', () => {
  // This hint string literally describes the template placeholders, so its
  // own "{data}" etc. must survive verbatim.
  expect(t('pt-BR', 'prefs_templates_placeholders_hint')).toContain('{data}')
})

test('t ignores an unused param and a message with no placeholders', () => {
  expect(t('pt-BR', 'app_name', { foo: 'bar' })).toBe('Team Tracker')
})

test('t leaves an unmatched placeholder untouched', () => {
  // 'milestone_delete_confirm' is "Excluir \"{title}\"?" — passing only an
  // unrelated param must not disturb {title}.
  expect(t('pt-BR', 'milestone_delete_confirm', { name: 'x' })).toBe('Excluir "{title}"?')
})
test('formatDate per locale', () => {
  expect(formatDate('2026-07-02', 'pt-BR')).toBe('02/07/2026')
  expect(formatDate('2026-07-02', 'en-US')).toBe('07/02/2026')
})
test('parseLocaleDate valid and invalid', () => {
  expect(parseLocaleDate('02/07/2026', 'pt-BR')).toBe('2026-07-02')
  expect(parseLocaleDate('07/02/2026', 'en-US')).toBe('2026-07-02')
  expect(parseLocaleDate('31/02/2026', 'pt-BR')).toBeNull()
  expect(parseLocaleDate('junk', 'pt-BR')).toBeNull()
})
