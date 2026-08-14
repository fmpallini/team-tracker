import { openDuePanel, filterBucketsByTeam } from '../src/ui/due-panel'
import type { DueItem, DueBuckets } from '../src/core/due'
import type { Loc } from '../src/core/types'

function makeItem(overrides: Partial<DueItem> = {}): DueItem {
  return {
    loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } },
    title: 'Task A',
    teamName: 'Alpha',
    date: '2000-01-01',
    kind: 'action',
    ...overrides,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('filterBucketsByTeam', () => {
  test('returns the same buckets when teamId is undefined', () => {
    const buckets: DueBuckets = { overdue: [makeItem()], dueSoon: [] }
    expect(filterBucketsByTeam(buckets, undefined)).toEqual(buckets)
  })

  test('filters overdue and dueSoon down to the given team', () => {
    const t1 = makeItem({ loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } } })
    const t2 = makeItem({ loc: { teamId: 'T2', ref: { kind: 'actions', itemId: 'a2' } }, teamName: 'Beta' })
    const buckets: DueBuckets = { overdue: [t1, t2], dueSoon: [t2] }
    expect(filterBucketsByTeam(buckets, 'T1')).toEqual({ overdue: [t1], dueSoon: [] })
  })

  test('a team with no matching items yields empty arrays, not a crash', () => {
    const buckets: DueBuckets = { overdue: [makeItem()], dueSoon: [] }
    expect(filterBucketsByTeam(buckets, 'nonexistent')).toEqual({ overdue: [], dueSoon: [] })
  })
})

describe('openDuePanel', () => {
  test('shows the empty state when both buckets are empty', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [], dueSoon: [] }, onOpenItem: () => {} })
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Nothing overdue or due soon.')
  })

  test('renders overdue/due-soon sections and titles the modal "Due" when unfiltered', () => {
    const overdueItem = makeItem({ title: 'Overdue task' })
    const soonItem = makeItem({ title: 'Soon task', date: '2999-01-01' })
    openDuePanel({ locale: 'en-US', buckets: { overdue: [overdueItem], dueSoon: [soonItem] }, onOpenItem: () => {} })
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due')
    const headings = Array.from(document.querySelectorAll('.tt-due-section-heading')).map((n) => n.textContent)
    expect(headings).toEqual(['Overdue', 'Due soon'])
  })

  test('titles the modal with the team name when filtered', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem()], dueSoon: [] }, teamId: 'T1', teamName: 'Alpha', onOpenItem: () => {} })
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Due · Alpha')
  })

  test('shows each row\'s team name when unfiltered (multiple teams in view)', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem()], dueSoon: [] }, onOpenItem: () => {} })
    expect(document.querySelector('.tt-due-row-team')?.textContent).toBe('Alpha')
  })

  test('omits the redundant team name from rows when filtered to a single team (already named in the modal title)', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem()], dueSoon: [] }, teamId: 'T1', teamName: 'Alpha', onOpenItem: () => {} })
    expect(document.querySelector('.tt-due-row-team')).toBeNull()
  })

  test('clicking a row calls onOpenItem with its loc and closes the modal', () => {
    const loc: Loc = { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } }
    const onOpenItem = vi.fn()
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem({ loc })], dueSoon: [] }, onOpenItem })
    ;(document.querySelector('.tt-due-row') as HTMLElement).click()
    expect(onOpenItem).toHaveBeenCalledWith(loc)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('rows are keyboard-focusable', () => {
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem()], dueSoon: [] }, onOpenItem: () => {} })
    const row = document.querySelector('.tt-due-row') as HTMLElement
    expect(row.tabIndex).toBe(0)
  })

  test('Enter on a focused row calls onOpenItem and closes the modal', () => {
    const loc: Loc = { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } }
    const onOpenItem = vi.fn()
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem({ loc })], dueSoon: [] }, onOpenItem })
    const row = document.querySelector('.tt-due-row') as HTMLElement
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onOpenItem).toHaveBeenCalledWith(loc)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('Space on a focused row calls onOpenItem and closes the modal', () => {
    const loc: Loc = { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } }
    const onOpenItem = vi.fn()
    openDuePanel({ locale: 'en-US', buckets: { overdue: [makeItem({ loc })], dueSoon: [] }, onOpenItem })
    const row = document.querySelector('.tt-due-row') as HTMLElement
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(onOpenItem).toHaveBeenCalledWith(loc)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('ArrowDown/ArrowUp move focus between rows without activating them', () => {
    const first = makeItem({ title: 'First', loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } } })
    const second = makeItem({ title: 'Second', loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a2' } } })
    const onOpenItem = vi.fn()
    openDuePanel({ locale: 'en-US', buckets: { overdue: [first, second], dueSoon: [] }, onOpenItem })
    const rows = document.querySelectorAll<HTMLElement>('.tt-due-row')
    rows[0]!.focus()
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(rows[1])
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(rows[0])
    expect(onOpenItem).not.toHaveBeenCalled()
  })

  test('ArrowDown on the last row and ArrowUp on the first row are no-ops', () => {
    const first = makeItem({ title: 'First', loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } } })
    const second = makeItem({ title: 'Second', loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a2' } } })
    openDuePanel({ locale: 'en-US', buckets: { overdue: [first, second], dueSoon: [] }, onOpenItem: () => {} })
    const rows = document.querySelectorAll<HTMLElement>('.tt-due-row')
    rows[1]!.focus()
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(rows[1])
    rows[0]!.focus()
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(rows[0])
  })
})
