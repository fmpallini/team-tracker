import { unlinkRefsInText, unlinkRefsInTeam } from '../src/core/refs'
import type { Team } from '../src/core/types'

describe('unlinkRefsInText', () => {
  test('rewrites a matching ref to a muted ~title~ marker', () => {
    const text = 'see @[Fix bug](action:a1) for details'
    expect(unlinkRefsInText(text, 'action', new Map([['a1', 'Fix bug']]))).toBe('see ~Fix bug~ for details')
  })

  test('uses the passed-in current title, not the stale label frozen in the mention', () => {
    const text = 'see @[Fix bug](action:a1) for details'
    expect(unlinkRefsInText(text, 'action', new Map([['a1', 'Fix the bug for real']]))).toBe('see ~Fix the bug for real~ for details')
  })

  test('leaves refs of a different kind untouched', () => {
    const text = 'see @[Fix bug](action:a1) and @[Ana](person:a1)'
    expect(unlinkRefsInText(text, 'action', new Map([['a1', 'Fix bug']]))).toBe('see ~Fix bug~ and @[Ana](person:a1)')
  })

  test('leaves refs of the same kind but a different id untouched', () => {
    const text = 'see @[Fix bug](action:a1) and @[Other](action:a2)'
    expect(unlinkRefsInText(text, 'action', new Map([['a1', 'Fix bug']]))).toBe('see ~Fix bug~ and @[Other](action:a2)')
  })

  test('leaves day refs untouched regardless of kind (day is never a RefKind)', () => {
    const text = 'ver @[02/07/2026](day:2026-07-02)'
    expect(unlinkRefsInText(text, 'action', new Map([['2026-07-02', 'x']]))).toBe(text)
  })

  test('no-ops when titles is empty', () => {
    const text = 'see @[Fix bug](action:a1)'
    expect(unlinkRefsInText(text, 'action', new Map())).toBe(text)
  })

  test('no-ops on text with no refs', () => {
    expect(unlinkRefsInText('plain text', 'action', new Map([['a1', 'Fix bug']]))).toBe('plain text')
  })

  test('rewrites multiple matching refs in one pass', () => {
    const text = '@[A](risk:r1) and @[B](risk:r2) and @[C](risk:r3)'
    expect(unlinkRefsInText(text, 'risk', new Map([['r1', 'A'], ['r3', 'C']]))).toBe('~A~ and @[B](risk:r2) and ~C~')
  })

  test('sanitizes every markdown-special character in the title so the marker can never reactivate formatting or spoof another mention', () => {
    const text = 'see @[Fix bug](action:a1) for details'
    expect(unlinkRefsInText(text, 'action', new Map([['a1', 'Fix *bug* now <u>@[Ana](person:p1)</u>']])))
      .toBe('see ~Fix _bug_ now _u___Ana__person:p1__/u_~ for details')
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
      generalNotes: 'also see @[Fix bug](action:a1)',
    }
  }

  test('unlinks the given ids across every note-bearing field on the team, using the passed-in title as a muted ~title~ marker', () => {
    const tm = team()
    unlinkRefsInTeam(tm, 'action', new Map([['a1', 'Fix bug']]))
    expect(tm.stakeholders[0]!.notes).toBe('ping ~Fix bug~')
    expect(tm.members[0]!.notes).toBe('no refs here')
    expect(tm.actionItems[0]!.notes).toBe('see ~Fix bug~')
    expect(tm.milestones[0]!.followup).toBe('blocked by ~Fix bug~')
    expect(tm.risks[0]!.followup).toBe('linked to ~Fix bug~')
    expect(tm.dailyNotes['2026-07-01']).toBe('today: ~Fix bug~')
    expect(tm.generalNotes).toBe('also see ~Fix bug~')
  })

  test('unlinks to the current title even when it differs from the mention label frozen at creation time (rename-then-delete)', () => {
    const tm = team()
    unlinkRefsInTeam(tm, 'action', new Map([['a1', 'Fix the login bug']]))
    expect(tm.stakeholders[0]!.notes).toBe('ping ~Fix the login bug~')
    expect(tm.actionItems[0]!.notes).toBe('see ~Fix the login bug~')
  })

  test('leaves generalNotes as undefined when it was never set (no crash)', () => {
    const tm = team()
    delete (tm as { generalNotes?: string }).generalNotes
    expect(() => unlinkRefsInTeam(tm, 'action', new Map([['a1', 'Fix bug']]))).not.toThrow()
    expect(tm.generalNotes).toBe('')
  })

  test('no-ops when titles is empty', () => {
    const tm = team()
    const before = JSON.stringify(tm)
    unlinkRefsInTeam(tm, 'action', new Map())
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
