import { matchRelativeWeekdays } from '../src/core/relative-date'

// 2026-10-06 is a Tuesday: "today's weekday" is the interesting edge case, since
// "next/last <same weekday>" must skip today and land exactly a week away.
const TODAY = '2026-10-06'

describe('matchRelativeWeekdays — en-US', () => {
  test('"next tuesday" said on a Tuesday is a week later (strictly after today)', () => {
    expect(matchRelativeWeekdays('next tuesday', TODAY, 'en-US')).toEqual([{ date: '2026-10-13', word: 'next tuesday' }])
  })

  test('"last tuesday" said on a Tuesday is a week earlier (strictly before today)', () => {
    expect(matchRelativeWeekdays('last tuesday', TODAY, 'en-US')).toEqual([{ date: '2026-09-29', word: 'last tuesday' }])
  })

  test('"next" is the directly following occurrence, "last" the directly preceding one', () => {
    expect(matchRelativeWeekdays('next wednesday', TODAY, 'en-US')).toEqual([{ date: '2026-10-07', word: 'next wednesday' }])
    expect(matchRelativeWeekdays('next monday', TODAY, 'en-US')).toEqual([{ date: '2026-10-12', word: 'next monday' }])
    expect(matchRelativeWeekdays('last monday', TODAY, 'en-US')).toEqual([{ date: '2026-10-05', word: 'last monday' }])
    expect(matchRelativeWeekdays('last wednesday', TODAY, 'en-US')).toEqual([{ date: '2026-09-30', word: 'last wednesday' }])
  })

  test('"previous" and "past" are synonyms for "last", shown as typed', () => {
    expect(matchRelativeWeekdays('previous monday', TODAY, 'en-US')).toEqual([{ date: '2026-10-05', word: 'previous monday' }])
    expect(matchRelativeWeekdays('past tue', TODAY, 'en-US')).toEqual([{ date: '2026-09-29', word: 'past tuesday' }])
    expect(matchRelativeWeekdays('prev', TODAY, 'en-US').map((r) => r.date)).toEqual(
      ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29'])
  })

  test('a bare weekday still offers exactly one past entry, worded "last"', () => {
    expect(matchRelativeWeekdays('mon', TODAY, 'en-US')).toEqual([
      { date: '2026-10-12', word: 'next monday' },
      { date: '2026-10-05', word: 'last monday' },
    ])
  })

  test('weekday prefixes match, case- and whitespace-insensitively', () => {
    expect(matchRelativeWeekdays('  Next   FRI ', TODAY, 'en-US')).toEqual([{ date: '2026-10-09', word: 'next friday' }])
  })

  test('a bare weekday prefix offers both the next and the last occurrence', () => {
    expect(matchRelativeWeekdays('tue', TODAY, 'en-US')).toEqual([
      { date: '2026-10-13', word: 'next tuesday' },
      { date: '2026-09-29', word: 'last tuesday' },
    ])
  })

  test('"next" alone lists the coming 7 days nearest-first; "last" the previous 7 nearest-first', () => {
    const next = matchRelativeWeekdays('next', TODAY, 'en-US')
    expect(next.map((r) => r.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'])
    const last = matchRelativeWeekdays('last', TODAY, 'en-US')
    expect(last.map((r) => r.date)).toEqual(['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29'])
  })

  test('empty or unrelated text matches nothing', () => {
    expect(matchRelativeWeekdays('', TODAY, 'en-US')).toEqual([])
    expect(matchRelativeWeekdays('   ', TODAY, 'en-US')).toEqual([])
    expect(matchRelativeWeekdays('zzz', TODAY, 'en-US')).toEqual([])
  })

  test('rolls over month and year boundaries', () => {
    expect(matchRelativeWeekdays('next friday', '2026-12-30', 'en-US')).toEqual([{ date: '2027-01-01', word: 'next friday' }])
    expect(matchRelativeWeekdays('last sunday', '2026-03-02', 'en-US')).toEqual([{ date: '2026-03-01', word: 'last sunday' }])
  })
})

describe('matchRelativeWeekdays — pt-BR', () => {
  test('"próxima terça" / "terça passada" resolve strictly after / before today', () => {
    expect(matchRelativeWeekdays('próxima terça', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-13', word: 'próxima terça' }])
    expect(matchRelativeWeekdays('terça passada', TODAY, 'pt-BR')).toEqual([{ date: '2026-09-29', word: 'terça passada' }])
  })

  test('accents are optional', () => {
    expect(matchRelativeWeekdays('proxima terca', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-13', word: 'próxima terça' }])
  })

  test('masculine weekdays (sábado, domingo) take próximo / passado', () => {
    expect(matchRelativeWeekdays('próximo sábado', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-10', word: 'próximo sábado' }])
    expect(matchRelativeWeekdays('sábado passado', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-03', word: 'sábado passado' }])
  })

  test('"última/último <weekday>" and "<weekday> anterior" are alternatives for last', () => {
    expect(matchRelativeWeekdays('última terça', TODAY, 'pt-BR')).toEqual([{ date: '2026-09-29', word: 'última terça' }])
    expect(matchRelativeWeekdays('ultimo sabado', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-03', word: 'último sábado' }])
    expect(matchRelativeWeekdays('segunda anterior', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-05', word: 'segunda anterior' }])
  })

  test('"<weekday> que vem" is an alternative for next', () => {
    expect(matchRelativeWeekdays('quarta que vem', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-07', word: 'quarta que vem' }])
  })

  test('"<weekday> próxima" and "seguinte" forms are alternatives for next', () => {
    expect(matchRelativeWeekdays('terça prox', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-13', word: 'terça próxima' }])
    expect(matchRelativeWeekdays('sábado próximo', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-10', word: 'sábado próximo' }])
    expect(matchRelativeWeekdays('quarta seguinte', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-07', word: 'quarta seguinte' }])
    expect(matchRelativeWeekdays('seguinte sexta', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-09', word: 'seguinte sexta' }])
  })

  test('-feira forms are accepted', () => {
    expect(matchRelativeWeekdays('próxima sexta-feira', TODAY, 'pt-BR')).toEqual([{ date: '2026-10-09', word: 'próxima sexta-feira' }])
  })

  test('a bare weekday offers both directions, one entry per direction', () => {
    expect(matchRelativeWeekdays('terça', TODAY, 'pt-BR')).toEqual([
      { date: '2026-10-13', word: 'próxima terça' },
      { date: '2026-09-29', word: 'terça passada' },
    ])
  })

  test('empty or unrelated text matches nothing', () => {
    expect(matchRelativeWeekdays('', TODAY, 'pt-BR')).toEqual([])
    expect(matchRelativeWeekdays('zzz', TODAY, 'pt-BR')).toEqual([])
  })
})
