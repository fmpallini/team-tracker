import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { toggleFavorite } from '../src/core/favorites'
import { allocateRows, buildSwitcher, SWITCHER_MAX_ROWS } from '../src/core/switcher'
import type { Doc } from '../src/core/types'

const TODAY = '2026-10-07'

function person(id: string, name: string) {
  return { id, name, role: '', parentId: null, order: 0, notes: '' }
}

/** Alpha (active, 🅰️) with Carla + a risk; Beta (🅱️) with José, Bruno + a risk. */
function twoTeamDoc(): Doc {
  const doc = createEmptyDocument('en-US')
  const a = createEmptyTeam('a', 'Alpha', '🅰️', 'en-US')
  const b = createEmptyTeam('b', 'Beta', '🅱️', 'en-US')
  a.stakeholders.push(person('p-carla', 'Carla'))
  a.risks.push({ id: 'r-a', title: 'Alpha slip', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
  b.members.push(person('p-jose', 'José'), person('p-bruno', 'Bruno'))
  b.risks.push({ id: 'r-b', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false })
  doc.teams.push(a, b)
  doc.nav.activeTeamId = 'a'
  return doc
}

const ids = (doc: Doc, q = '') => buildSwitcher(doc, q, 'en-US', TODAY).map((s) => s.id)
const rowsOf = (doc: Doc, q: string, id: string) => buildSwitcher(doc, q, 'en-US', TODAY).find((s) => s.id === id)?.rows ?? []

describe('allocateRows', () => {
  test('every section full: minimum 4 each, leftovers round-robin → 5/5/5/5', () => {
    expect(allocateRows([10, 10, 10, 10])).toEqual([5, 5, 5, 5])
  })
  test('leftovers skip sections that ran out', () => {
    expect(allocateRows([30, 0, 2, 30])).toEqual([9, 0, 2, 9])
  })
  test('small sections show everything', () => {
    expect(allocateRows([1, 2, 3])).toEqual([1, 2, 3])
  })
  test('a single section may use all 20', () => {
    expect(allocateRows([50])).toEqual([20])
  })
  test('two big sections split 10/10', () => {
    expect(allocateRows([40, 40])).toEqual([10, 10])
  })
})

describe('buildSwitcher sections', () => {
  test('order is favorites, due, current; others stay hidden on an empty query', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    doc.teams[1]!.actionItems.push({ id: 'a1', summary: 'Pay vendor', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 0 })
    expect(ids(doc)).toEqual(['favorites', 'due', 'current'])
  })

  test('a query reveals Other teams and finds people there', () => {
    const doc = twoTeamDoc()
    expect(ids(doc, 'bruno')).toEqual(['others'])
    const [row] = rowsOf(doc, 'bruno', 'others')
    expect(row!.label).toContain('Bruno')
    expect(row!.teamId).toBe('b')
    expect(row!.teamBadge).toBe('🅱️ Beta')
  })

  test('review focus: whitespace-only query counts as empty', () => {
    const doc = twoTeamDoc()
    expect(ids(doc, '   ')).toEqual(ids(doc, ''))
    expect(ids(doc, '   ')).not.toContain('others')
  })

  test('review focus: matching ignores case and accents across teams', () => {
    const doc = twoTeamDoc()
    const rows = rowsOf(doc, 'JOSE', 'others')
    expect(rows.map((r) => r.label).join()).toContain('José')
  })

  test('a team name plus a word narrows to that team', () => {
    const doc = twoTeamDoc()
    const all = buildSwitcher(doc, 'beta risks', 'en-US', TODAY).flatMap((s) => s.rows)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((r) => r.teamId === 'b')).toBe(true)
    expect(all.some((r) => r.ref.kind === 'risks' && !('itemId' in r.ref))).toBe(true) // Beta's Risks list row
  })

  test('badges: set on favorites, due and other teams; absent on the current team', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    doc.teams[1]!.actionItems.push({ id: 'a1', summary: 'Pay vendor', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 0 })
    expect(rowsOf(doc, '', 'favorites')[0]!.teamBadge).toBe('🅱️ Beta')
    expect(rowsOf(doc, '', 'due')[0]!.teamBadge).toBe('🅱️ Beta')
    expect(rowsOf(doc, '', 'current').every((r) => r.teamBadge === undefined)).toBe(true)
    expect(rowsOf(doc, 'vendor', 'others')[0]!.teamBadge).toBe('🅱️ Beta')
  })

  test('review focus: a team with no emoji gets a trimmed badge', () => {
    const doc = twoTeamDoc()
    doc.teams[1]!.emoji = ''
    expect(rowsOf(doc, 'bruno', 'others')[0]!.teamBadge).toBe('Beta')
  })

  test('headings: favorites, due, current team (emoji + name) and others', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    doc.teams[1]!.actionItems.push({ id: 'a1', summary: 'Pay vendor', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 0 })
    const s = buildSwitcher(doc, 'a', 'en-US', TODAY)
    const byId = Object.fromEntries(s.map((x) => [x.id, x.heading]))
    expect(byId['favorites']).toContain('Favorites')
    expect(byId['due']).toContain('Due dates')
    expect(byId['current']).toBe('🅰️ Alpha')
    expect(byId['others']).toContain('Other teams')
  })

  test('no active team: no current section, and others show even with an empty query', () => {
    const doc = twoTeamDoc()
    doc.nav.activeTeamId = null
    expect(ids(doc)).toEqual(['others'])
  })
})

describe('buildSwitcher favorites', () => {
  test('a module-level favorite is removed from Current team but its cards stay', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'a', ref: { kind: 'risks' } })
    toggleFavorite(doc, { teamId: 'a', ref: { kind: 'person', personId: 'p-carla', group: 'stakeholders' } })
    const current = rowsOf(doc, '', 'current')
    expect(current.some((r) => r.ref.kind === 'risks' && !('itemId' in r.ref))).toBe(false)
    expect(current.some((r) => r.ref.kind === 'risks' && 'itemId' in r.ref && r.ref.itemId === 'r-a')).toBe(true)
    expect(current.some((r) => r.ref.kind === 'person')).toBe(false)
    expect(rowsOf(doc, '', 'favorites')).toHaveLength(2)
  })

  test('favorite rows carry the favorite so ✕ can remove it', () => {
    const doc = twoTeamDoc()
    toggleFavorite(doc, { teamId: 'b', ref: { kind: 'risks' } })
    expect(rowsOf(doc, '', 'favorites')[0]!.favorite).toEqual({ teamId: 'b', ref: { kind: 'risks' } })
  })

  test('orphaned favorites (team gone) are not listed', () => {
    const doc = twoTeamDoc()
    doc.favorites.push({ teamId: 'gone', ref: { kind: 'risks' } })
    expect(ids(doc)).not.toContain('favorites')
  })
})

describe('buildSwitcher due dates', () => {
  test('overdue first, then due soon, with relative labels', () => {
    const doc = twoTeamDoc()
    doc.teams[1]!.actionItems.push(
      { id: 'soon', summary: 'Soon task', notes: '', status: 'todo', dueDate: '2026-10-09', assignee: '', color: null, order: 0 },
      { id: 'late', summary: 'Late task', notes: '', status: 'todo', dueDate: '2026-10-01', assignee: '', color: null, order: 1 },
      { id: 'done', summary: 'Done task', notes: '', status: 'done', dueDate: '2026-10-01', assignee: '', color: null, order: 2 },
    )
    const rows = rowsOf(doc, '', 'due')
    expect(rows.map((r) => r.label)).toEqual(['✅ Late task', '✅ Soon task'])
    expect(rows.map((r) => r.dueLabel)).toEqual(['overdue by 6d', 'in 2d'])
    expect(rows[0]!.ref).toEqual({ kind: 'actions', itemId: 'late' })
    expect(rows[0]!.teamId).toBe('b')
  })

  test('no due items → no due section', () => {
    expect(ids(twoTeamDoc())).not.toContain('due')
  })
})

describe('buildSwitcher row cap', () => {
  test('never more than 20 rows; total reports the uncapped match count', () => {
    const doc = twoTeamDoc()
    for (let i = 0; i < 30; i++) doc.teams[0]!.members.push(person(`m${i}`, `Person ${i}`))
    const sections = buildSwitcher(doc, 'person', 'en-US', TODAY)
    const rows = sections.flatMap((s) => s.rows)
    expect(rows.length).toBeLessThanOrEqual(SWITCHER_MAX_ROWS)
    const current = sections.find((s) => s.id === 'current')!
    expect(current.total).toBe(30)
    expect(current.rows).toHaveLength(20)
  })

  test('every section with matches keeps at least 4 rows even when one is huge', () => {
    const doc = twoTeamDoc()
    for (let i = 0; i < 30; i++) {
      doc.teams[0]!.members.push(person(`m${i}`, `Person ${i}`))
      doc.teams[1]!.members.push(person(`n${i}`, `Person ${i}`))
    }
    const sections = buildSwitcher(doc, 'person', 'en-US', TODAY)
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.rows.length]))
    expect(byId['current']).toBeGreaterThanOrEqual(4)
    expect(byId['others']).toBeGreaterThanOrEqual(4)
  })
})
