import { createBacklinksChip } from '../src/ui/backlinks-panel'
import type { Backlink } from '../src/core/search'
import type { Loc } from '../src/core/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function bl(overrides: Partial<Backlink> = {}): Backlink {
  return {
    loc: { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } },
    moduleKind: 'person',
    title: 'Ana',
    snippet: 'flagged @[Ship it](action:a1) as blocking',
    ...overrides,
  }
}

test('empty backlinks -> null, nothing rendered', () => {
  expect(createBacklinksChip([], 'en-US', () => {})).toBeNull()
})

test('non-empty backlinks -> a pill showing the count', () => {
  const chip = createBacklinksChip([bl(), bl({ moduleKind: 'risks', title: 'Queue backlog' })], 'en-US', () => {})
  expect(chip).not.toBeNull()
  expect(chip!.textContent).toBe('↩ 2')
  expect(chip!.className).toBe('tt-backlinks-chip')
})

test('clicking the chip opens a panel with one row per backlink, grouped by kind with a header', () => {
  document.body.appendChild(document.createElement('div')) // ensure body has layout context
  const chip = createBacklinksChip([bl(), bl({ moduleKind: 'risks', title: 'Queue backlog', snippet: 'no mention' })], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  const panel = document.querySelector('.tt-backlinks-panel')
  expect(panel).not.toBeNull()
  expect(panel!.querySelectorAll('.tt-backlinks-group-header')).toHaveLength(2)
  expect(panel!.querySelectorAll('.tt-backlinks-row')).toHaveLength(2)
  expect(panel!.textContent).toContain('Ana')
  expect(panel!.textContent).toContain('Queue backlog')
})

test('clicking a row navigates with the row\'s loc and secondary computed from the click', () => {
  const calls: { loc: Loc; opts: { secondary: boolean } }[] = []
  const chip = createBacklinksChip([bl()], 'en-US', (loc, opts) => calls.push({ loc, opts }))!
  document.body.appendChild(chip)
  chip.click()
  const row = document.querySelector<HTMLElement>('.tt-backlinks-row')!
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  expect(calls).toEqual([{ loc: bl().loc, opts: { secondary: true } }])
  // clicking a row also closes the panel
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('outside click and Escape both close the panel', () => {
  const chip = createBacklinksChip([bl()], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()

  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('opening a second chip\'s panel closes the first', () => {
  const chipA = createBacklinksChip([bl()], 'en-US', () => {})!
  const chipB = createBacklinksChip([bl({ moduleKind: 'risks' })], 'en-US', () => {})!
  document.body.append(chipA, chipB)
  chipA.click()
  chipB.click()
  expect(document.querySelectorAll('.tt-backlinks-panel')).toHaveLength(1)
})
