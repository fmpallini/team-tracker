import { defaultCadenceDays, effectiveCadenceDays, oneOnOneDueDate } from '../src/core/cadence'
import { createEmptyDocument } from '../src/core/document'
import type { Person } from '../src/core/types'

function p(overrides: Partial<Person>): Person {
  return { id: 'p1', name: 'Ana', role: '', parentId: null, order: 0, notes: '', ...overrides }
}
const prefs = createEmptyDocument('en-US').prefs

describe('defaultCadenceDays', () => {
  test('members follow the preference (0 = none), stakeholders have none', () => {
    expect(defaultCadenceDays('members', prefs)).toBe(14)
    expect(defaultCadenceDays('members', { ...prefs, oneOnOneDefaultDays: 0 })).toBeNull()
    expect(defaultCadenceDays('stakeholders', prefs)).toBeNull()
  })
})

describe('effectiveCadenceDays', () => {
  test('members default 14, stakeholders none', () => {
    expect(effectiveCadenceDays(p({}), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({}), 'stakeholders', prefs)).toBeNull()
  })
  test('override and explicit none', () => {
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 7 }), 'stakeholders', prefs)).toBe(7)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 365 }), 'members', prefs)).toBe(365)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: null }), 'members', prefs)).toBeNull()
  })
  test('default 0 turns members off, an override still wins', () => {
    const off = { ...prefs, oneOnOneDefaultDays: 0 }
    expect(effectiveCadenceDays(p({}), 'members', off)).toBeNull()
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 7 }), 'members', off)).toBe(7)
  })
  test('ignores malformed cadence fields', () => {
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: -3 as number }), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 0 as number }), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 366 as number }), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: 2.5 as number }), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: NaN as number }), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: '7' as unknown as number }), 'members', prefs)).toBe(14)
    expect(effectiveCadenceDays(p({ oneOnOneEveryDays: -3 as number }), 'stakeholders', prefs)).toBeNull()
  })
  test('a malformed default means no default', () => {
    for (const bad of [-1, 2.5, 1000, NaN, '14' as unknown as number]) {
      expect(effectiveCadenceDays(p({}), 'members', { ...prefs, oneOnOneDefaultDays: bad })).toBeNull()
    }
  })
})

describe('oneOnOneDueDate', () => {
  test('no lastOneOnOne → never due', () => expect(oneOnOneDueDate(p({}), 'members', prefs)).toBeNull())
  test('no cadence → never due', () => {
    expect(oneOnOneDueDate(p({ lastOneOnOne: '2026-11-01' }), 'stakeholders', prefs)).toBeNull()
    expect(oneOnOneDueDate(p({ lastOneOnOne: '2026-11-01', oneOnOneEveryDays: null }), 'members', prefs)).toBeNull()
  })
  test('due date = last + cadence', () => {
    expect(oneOnOneDueDate(p({ lastOneOnOne: '2026-11-01' }), 'members', prefs)).toBe('2026-11-15')
    expect(oneOnOneDueDate(p({ lastOneOnOne: '2026-12-28', oneOnOneEveryDays: 7 }), 'stakeholders', prefs)).toBe('2027-01-04')
  })
  test('ignores malformed cadence fields', () => {
    for (const bad of ['nope', '', '2026-13-01', '2026-02-31', '2026-1-1', '2026-11-01T00:00', 5 as unknown as string]) {
      expect(oneOnOneDueDate(p({ lastOneOnOne: bad }), 'members', prefs)).toBeNull()
    }
  })
})
