import { t, formatDate, parseLocaleDate } from '../src/core/i18n'

test('t interpolates', () => {
  expect(t('pt-BR', 'app_name')).toBe('Team Tracker')
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
