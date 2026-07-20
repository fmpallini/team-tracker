import { unlinkRefsInText, unlinkRefsInTeam } from '../src/core/refs'
import type { Team } from '../src/core/types'

describe('unlinkRefsInText', () => {
  test('rewrites a matching ref to its plain label', () => {
    const text = 'see @[Fix bug](action:a1) for details'
    expect(unlinkRefsInText(text, 'action', new Set(['a1']))).toBe('see Fix bug for details')
  })

  test('leaves refs of a different kind untouched', () => {
    const text = 'see @[Fix bug](action:a1) and @[Ana](person:a1)'
    expect(unlinkRefsInText(text, 'action', new Set(['a1']))).toBe('see Fix bug and @[Ana](person:a1)')
  })

  test('leaves refs of the same kind but a different id untouched', () => {
    const text = 'see @[Fix bug](action:a1) and @[Other](action:a2)'
    expect(unlinkRefsInText(text, 'action', new Set(['a1']))).toBe('see Fix bug and @[Other](action:a2)')
  })

  test('leaves day refs untouched regardless of kind (day is never a RefKind)', () => {
    const text = 'ver @[02/07/2026](day:2026-07-02)'
    expect(unlinkRefsInText(text, 'action', new Set(['2026-07-02']))).toBe(text)
  })

  test('no-ops when ids is empty', () => {
    const text = 'see @[Fix bug](action:a1)'
    expect(unlinkRefsInText(text, 'action', new Set())).toBe(text)
  })

  test('no-ops on text with no refs', () => {
    expect(unlinkRefsInText('plain text', 'action', new Set(['a1']))).toBe('plain text')
  })

  test('rewrites multiple matching refs in one pass', () => {
    const text = '@[A](risk:r1) and @[B](risk:r2) and @[C](risk:r3)'
    expect(unlinkRefsInText(text, 'risk', new Set(['r1', 'r3']))).toBe('A and @[B](risk:r2) and C')
  })
})

describe('unlinkRefsInTeam', () => {
  function team(): Team {
    return {
      id: 't1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: 'ping @[Fix bug](action:a1)' }],
      members: [{ id: 'm1', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'no refs here' }],
      actionItems: [{ id: 'a2', summary: 'Other', notes: 'see @[Fix bug](action:a1)', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'mi1', date: '2026-08-01', title: 'Ship', done: false, followup: 'blocked by @[Fix bug](action:a1)' }],
      risks: [{ id: 'r1', title: 'Risk', chance: 1, impact: 1, plan: 'accept', followup: 'linked to @[Fix bug](action:a1)', order: 0, closed: false }],
      dailyNotes: { '2026-07-01': 'today: @[Fix bug](action:a1)' },
    }
  }

  test('unlinks the given ids across every note-bearing field on the team', () => {
    const tm = team()
    unlinkRefsInTeam(tm, 'action', ['a1'])
    expect(tm.stakeholders[0]!.notes).toBe('ping Fix bug')
    expect(tm.members[0]!.notes).toBe('no refs here')
    expect(tm.actionItems[0]!.notes).toBe('see Fix bug')
    expect(tm.milestones[0]!.followup).toBe('blocked by Fix bug')
    expect(tm.risks[0]!.followup).toBe('linked to Fix bug')
    expect(tm.dailyNotes['2026-07-01']).toBe('today: Fix bug')
  })

  test('no-ops when ids is empty', () => {
    const tm = team()
    const before = JSON.stringify(tm)
    unlinkRefsInTeam(tm, 'action', [])
    expect(JSON.stringify(tm)).toBe(before)
  })
})

import { stripAllRefs } from '../src/core/refs'

describe('stripAllRefs', () => {
  test('flattens every ref kind to its plain label', () => {
    const text = 'ping @[Ana](person:p1) about @[Fix bug](action:a1) before @[Ship](milestone:m1) and @[Vendor](risk:r1)'
    expect(stripAllRefs(text)).toBe('ping Ana about Fix bug before Ship and Vendor')
  })

  test('leaves day refs and plain text untouched aside from person/action/milestone/risk', () => {
    const text = 'see you @[02/07/2026](day:2026-07-02), no other refs here'
    expect(stripAllRefs(text)).toBe('see you 02/07/2026, no other refs here')
  })

  test('no-ops on text with no refs', () => {
    expect(stripAllRefs('plain text, nothing to strip')).toBe('plain text, nothing to strip')
  })
})
