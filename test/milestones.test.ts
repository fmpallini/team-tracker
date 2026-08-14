import {
  renderMilestones,
  computeTimelineLayout,
  sortByDate,
  truncateTitle,
} from '../src/modules/milestones'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Milestone, Team } from '../src/core/types'
import { SEARCH_FOCUS_ITEM_EVENT } from '../src/ui/search-highlight'

function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openBothPanes: () => {},
    openInFocused: () => {},
    openInSecondaryPane: () => 0,
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
    dispose: () => {},
  }
}

function milestone(overrides: Partial<Milestone>): Milestone {
  return { id: 'm1', date: '2026-01-01', title: 'Kickoff', done: false, followup: '', ...overrides }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: PaneManager; loc: Loc } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const loc: Loc = { teamId: team.id, ref: { kind: 'milestones' } }
  return { container, store, pm, loc }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex }
  renderMilestones(container, loc, ctx)
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-milestone-row'))
}

function clickByTitleOrText(root: ParentNode, text: string): void {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text || b.title === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

function setBlockText(editor: HTMLElement, text: string): void {
  editor.innerHTML = `<div>${text}</div>`
  const textNode = editor.firstChild!.firstChild as Text | null
  const range = document.createRange()
  if (textNode) range.setStart(textNode, textNode.textContent!.length)
  else range.setStart(editor.firstChild!, 0)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function fireInput(editor: HTMLElement): void {
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function rightClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
}

function contextMenuItem(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-context-menu-item')).find((b) => b.textContent === text)!
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('pure helpers', () => {
  test('sortByDate sorts ascending and keeps ties in original order', () => {
    const items = [milestone({ id: 'b', date: '2026-02-01' }), milestone({ id: 'a', date: '2026-01-01' }), milestone({ id: 'c', date: '2026-01-01' })]
    expect(sortByDate(items).map((m) => m.id)).toEqual(['a', 'c', 'b'])
  })

  describe('truncateTitle', () => {
    test('leaves short titles untouched', () => {
      expect(truncateTitle('Launch')).toBe('Launch')
    })
    test('truncates to 16 chars and appends an ellipsis', () => {
      const long = 'This title is definitely too long'
      const result = truncateTitle(long)
      expect(result).toBe(`${long.slice(0, 16)}…`)
      expect(result.length).toBe(17)
    })
    test('exactly 16 chars is left untouched', () => {
      const exact = '0123456789012345'
      expect(exact.length).toBe(16)
      expect(truncateTitle(exact)).toBe(exact)
    })
  })

  describe('computeTimelineLayout', () => {
    test('zero milestones hides the timeline (empty map, no today marker)', () => {
      const layout = computeTimelineLayout([], 24, 1000, '2026-01-01')
      expect(layout.x).toEqual({})
      expect(layout.innerWidth).toBe(1000)
      expect(layout.todayX).toBeNull()
    })

    test('a single milestone is centered, with no proportional math', () => {
      const layout = computeTimelineLayout([{ id: 'a', date: '2026-01-01' }], 24, 1000, '2026-06-01')
      expect(layout.x).toEqual({ a: 500 })
      expect(layout.innerWidth).toBe(1000)
      expect(layout.todayX).toBeNull() // today != the only milestone's date
    })

    test('a single milestone shows the today marker at its own position when today matches its date', () => {
      const layout = computeTimelineLayout([{ id: 'a', date: '2026-01-01' }], 24, 1000, '2026-01-01')
      expect(layout.todayX).toBe(500)
    })

    test('positions are proportional to elapsed time between the first and last date', () => {
      // span = 10 days; middle milestone is 1 day (10%) past the first.
      const layout = computeTimelineLayout(
        [
          { id: 'a', date: '2026-01-01' },
          { id: 'b', date: '2026-01-02' },
          { id: 'c', date: '2026-01-11' },
        ],
        24,
        1000,
        '2026-01-01'
      )
      expect(layout.x['a']).toBeCloseTo(0)
      expect(layout.x['b']).toBeCloseTo(100)
      expect(layout.x['c']).toBeCloseTo(1000)
      expect(layout.innerWidth).toBe(1000) // no growth needed; gaps (100, 900) both clear minGap
    })

    test('grows innerWidth when proportional spacing would violate minGap, preserving proportionality', () => {
      // span = 100 days; b sits 1% of the way in, so at width=50 the a-b gap
      // would be 0.5px — far under a 24px minGap.
      const layout = computeTimelineLayout(
        [
          { id: 'a', date: '2026-01-01' },
          { id: 'b', date: '2026-01-02' },
          { id: 'c', date: '2026-04-11' }, // +100 days
        ],
        24,
        50,
        '2026-01-01'
      )
      // needed = minGap / minFrac = 24 / 0.01 = 2400
      expect(layout.innerWidth).toBe(2400)
      expect(layout.x['a']).toBeCloseTo(0)
      expect(layout.x['b']).toBeCloseTo(24) // exactly the enforced minimum gap
      expect(layout.x['c']).toBeCloseTo(2400)
    })

    test('milestones sharing the exact same date are still separated by at least minGap', () => {
      const layout = computeTimelineLayout(
        [
          { id: 'a', date: '2026-01-01' },
          { id: 'b', date: '2026-01-01' },
          { id: 'c', date: '2026-01-01' },
        ],
        24,
        1000,
        '2026-01-01'
      )
      expect(layout.x['b']! - layout.x['a']!).toBeGreaterThanOrEqual(24)
      expect(layout.x['c']! - layout.x['b']!).toBeGreaterThanOrEqual(24)
    })

    test('today marker sits proportionally between min and max when in range', () => {
      const layout = computeTimelineLayout(
        [
          { id: 'a', date: '2026-01-01' },
          { id: 'b', date: '2026-01-11' },
        ],
        24,
        1000,
        '2026-01-06' // halfway
      )
      expect(layout.todayX).toBeCloseTo(500)
    })

    test('today marker is null when today is before the earliest milestone', () => {
      const layout = computeTimelineLayout(
        [{ id: 'a', date: '2026-01-01' }, { id: 'b', date: '2026-01-11' }],
        24, 1000, '2025-12-31'
      )
      expect(layout.todayX).toBeNull()
    })

    test('today marker is null when today is after the latest milestone', () => {
      const layout = computeTimelineLayout(
        [{ id: 'a', date: '2026-01-01' }, { id: 'b', date: '2026-01-11' }],
        24, 1000, '2026-02-01'
      )
      expect(layout.todayX).toBeNull()
    })

    test('today marker at the exact boundary dates counts as in range', () => {
      const layout1 = computeTimelineLayout(
        [{ id: 'a', date: '2026-01-01' }, { id: 'b', date: '2026-01-11' }],
        24, 1000, '2026-01-01'
      )
      expect(layout1.todayX).toBeCloseTo(0)
      const layout2 = computeTimelineLayout(
        [{ id: 'a', date: '2026-01-01' }, { id: 'b', date: '2026-01-11' }],
        24, 1000, '2026-01-11'
      )
      expect(layout2.todayX).toBeCloseTo(1000)
    })
  })
})

describe('renderMilestones', () => {
  test('hides the timeline when there are no milestones, and shows an empty list message', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const timeline = container.querySelector('.tt-milestone-timeline') as HTMLElement
    expect(timeline.style.display).toBe('none')
    expect(container.querySelector('.tt-milestone-empty')?.textContent).toBe('No milestones')
  })

  test('renders the list sorted by date ascending, independent of storage order', () => {
    const team = makeTeam({
      milestones: [
        milestone({ id: 'b', date: '2026-03-01', title: 'B' }),
        milestone({ id: 'a', date: '2026-01-01', title: 'A' }),
        milestone({ id: 'c', date: '2026-02-01', title: 'C' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const titles = Array.from(container.querySelectorAll<HTMLInputElement>('.tt-milestone-title-input')).map((i) => i.value)
    expect(titles).toEqual(['A', 'C', 'B'])
  })

  test('a backlink chip renders before the expand button when another field mentions this milestone', () => {
    const team = makeTeam()
    team.milestones.push(milestone({ id: 'm1', title: 'Beta' }))
    team.risks.push({ id: 'r1', title: 'Backlog', chance: 1, impact: 1, plan: 'accept', followup: 'Blocks @[Beta](milestone:m1)', order: 0, closed: false })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const chip = container.querySelector('[data-milestone-id="m1"] .tt-backlinks-chip')
    expect(chip?.textContent).toBe('↩ 1')
  })

  test('no chip when nothing mentions this milestone', () => {
    const team = makeTeam()
    team.milestones.push(milestone({ id: 'm1', title: 'Beta' }))
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('[data-milestone-id="m1"] .tt-backlinks-chip')).toBeNull()
  })

  test('renders one SVG circle per milestone, with a <title> carrying the full text', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'A very long milestone title indeed' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const circle = container.querySelector('.tt-milestone-dot')!
    expect(circle.querySelector('title')?.textContent).toBe('A very long milestone title indeed')
    const label = container.querySelector('.tt-milestone-title-label')!
    expect(label.textContent).toBe(`${'A very long milestone title indeed'.slice(0, 16)}…`)
  })

  // Regression: three same-day milestones used to print their labels through
  // each other ("Auth cutBetarewith GA release") because the minimum gap was
  // sized against the dots (24px) rather than the labels under them.
  test('title labels alternate between two rows so neighbours never share a baseline', () => {
    const team = makeTeam({
      milestones: [
        milestone({ id: 'a', date: '2026-08-02', title: 'Auth cutover complete' }),
        milestone({ id: 'b', date: '2026-08-02', title: 'Beta with 3 pilots' }),
        milestone({ id: 'c', date: '2026-08-02', title: 'GA release' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const ys = [...container.querySelectorAll('.tt-milestone-title-label')].map((n) => Number(n.getAttribute('y')))
    expect(ys).toHaveLength(3)
    expect(ys[0]).not.toBe(ys[1])
    expect(ys[1]).not.toBe(ys[2])
    expect(ys[0]).toBe(ys[2]) // alternating, so every other one shares a row

    // ...and each dot keeps a leader line down to its own label.
    expect(container.querySelectorAll('.tt-milestone-leader')).toHaveLength(3)
  })

  test('same-day milestones are spread far enough apart for their date labels to clear', () => {
    const team = makeTeam({
      milestones: [
        milestone({ id: 'a', date: '2026-08-02', title: 'A' }),
        milestone({ id: 'b', date: '2026-08-02', title: 'B' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const xs = [...container.querySelectorAll('.tt-milestone-dot')].map((n) => Number(n.getAttribute('cx')))
    // A dd/mm/yyyy label at 9px is roughly 55px wide; anything under that
    // overprints its neighbour.
    expect(Math.abs(xs[1]! - xs[0]!)).toBeGreaterThanOrEqual(56)
  })

  test('circle classes/fill: done is filled solid, overdue-and-not-done is muted, future-and-not-done is accent', () => {
    const team = makeTeam({
      milestones: [
        milestone({ id: 'done', date: '2020-01-01', title: 'Done', done: true }),
        milestone({ id: 'overdue', date: '2020-01-02', title: 'Late', done: false }),
        milestone({ id: 'future', date: '2999-01-01', title: 'Future', done: false }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const dots = Array.from(container.querySelectorAll('.tt-milestone-dot'))
    const done = dots.find((d) => d.querySelector('title')?.textContent === 'Done')!
    const overdue = dots.find((d) => d.querySelector('title')?.textContent === 'Late')!
    const future = dots.find((d) => d.querySelector('title')?.textContent === 'Future')!

    expect(done.classList.contains('tt-milestone-dot-done')).toBe(true)
    expect(done.getAttribute('fill')).toBe('var(--accent)')

    expect(overdue.classList.contains('tt-milestone-dot-overdue')).toBe(true)
    expect(overdue.getAttribute('fill')).toBe('none')
    expect(overdue.getAttribute('stroke')).toBe('var(--muted)')

    expect(future.classList.contains('tt-milestone-dot-future')).toBe(true)
    expect(future.getAttribute('fill')).toBe('none')
    expect(future.getAttribute('stroke')).toBe('var(--accent)')
  })

  test('"+ Milestone" appends a milestone dated today with an empty title and focuses it', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Milestone')

    const all = store.doc.teams[0]!.milestones
    expect(all).toHaveLength(1)
    expect(all[0]!.title).toBe('')
    expect(all[0]!.done).toBe(false)

    const focused = document.activeElement as HTMLInputElement
    expect(focused.classList.contains('tt-milestone-title-input')).toBe(true)
    expect(focused.closest('.tt-milestone-row')?.getAttribute('data-milestone-id')).toBe(all[0]!.id)
  })

  test('editing the title persists on change', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const titleInput = container.querySelector('.tt-milestone-title-input') as HTMLInputElement
    titleInput.value = 'New title'
    titleInput.dispatchEvent(new Event('change'))

    expect(store.doc.teams[0]!.milestones[0]!.title).toBe('New title')
  })

  test('editing the date persists and re-sorts the list', () => {
    const team = makeTeam({
      milestones: [milestone({ id: 'a', date: '2026-01-01', title: 'A' }), milestone({ id: 'b', date: '2026-02-01', title: 'B' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const dateInput = rows(container)[0]!.querySelector('.tt-date-picker-input') as HTMLInputElement
    dateInput.dispatchEvent(new MouseEvent('click', { bubbles: true })) // opens on the row's current date: Jan 2026
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-calendar-nav-btn')).find((b) => b.textContent === '›')!.click() // -> Feb
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-calendar-nav-btn')).find((b) => b.textContent === '›')!.click() // -> Mar
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)'))
      .find((b) => b.textContent === '1')!
      .click()

    expect(store.doc.teams[0]!.milestones.find((m) => m.id === 'a')!.date).toBe('2026-03-01')
    const titlesAfter = Array.from(container.querySelectorAll<HTMLInputElement>('.tt-milestone-title-input')).map((i) => i.value)
    expect(titlesAfter).toEqual(['B', 'A'])
  })

  test('the done checkbox persists to the store and marks the row done', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'A' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const checkbox = container.querySelector('.tt-milestone-done-checkbox') as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))

    expect(store.doc.teams[0]!.milestones[0]!.done).toBe(true)
    expect(rows(container)[0]!.classList.contains('tt-milestone-done-row')).toBe(true)
  })

  test('deleting a milestone with an empty title removes it immediately with no confirmation', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: '' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete milestone')

    expect(store.doc.teams[0]!.milestones).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('deleting a milestone with a non-empty title requires confirmation', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete milestone')
    expect(store.doc.teams[0]!.milestones).toHaveLength(1)
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')

    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.milestones).toHaveLength(0)
  })

  test('canceling the delete confirmation keeps the milestone', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete milestone')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.milestones).toHaveLength(1)
  })

  test('deleting a milestone unlinks every reference to it across the team\'s notes', () => {
    const team = makeTeam({
      milestones: [
        milestone({ id: 'a', title: 'Launch', date: '2026-01-01' }),
        milestone({ id: 'b', title: 'Follow-up', date: '2026-02-01', followup: 'depends on @[Launch](milestone:a) landing first' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    // Milestones render sorted by date ascending, so row 0 is 'Launch'.
    clickByTitleOrText(rows(container)[0]!, 'Delete milestone')
    clickByTitleOrText(document.body, 'Delete')

    const remaining = store.doc.teams[0]!.milestones
    expect(remaining.map((m) => m.id)).toEqual(['b'])
    expect(remaining[0]!.followup).toBe('depends on ~Launch~ landing first')
  })

  test('preserves an in-progress title edit (skips rebuild, defers to blur) when the store changes elsewhere while focused', () => {
    const team = makeTeam({
      milestones: [milestone({ id: 'a', date: '2026-01-01', title: 'A' }), milestone({ id: 'b', date: '2026-02-01', title: 'B' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const titleInputs = (): HTMLInputElement[] => Array.from(container.querySelectorAll<HTMLInputElement>('.tt-milestone-title-input'))
    const aInput = titleInputs().find((i) => i.value === 'A')!
    aInput.focus()

    store.update((d) => { d.teams[0]!.milestones[1]!.title = 'B changed' })

    expect(document.activeElement).toBe(aInput)
    expect(titleInputs().find((i) => i.value === 'B changed')).toBeUndefined()

    aInput.dispatchEvent(new Event('blur'))
    expect(titleInputs().find((i) => i.value === 'B changed')).not.toBeUndefined()
  })

  test('double render into the same container disposes the previous store subscription (no duplicate rebuilds/leaks)', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'A' })] })
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)

    expect(() => store.update((d) => { d.teams[0]!.milestones[0]!.title = 'A2' })).not.toThrow()
    expect(rows(container)).toHaveLength(1)
  })

  describe('follow-up editor', () => {
    test('expand button reveals a follow-up editor that persists to milestone.followup', () => {
      vi.useFakeTimers()
      const team = makeTeam({ milestones: [milestone({ id: 'a', followup: '' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      expect(container.querySelector('.editor')).toBeNull()
      container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

      const editorEl = container.querySelector('.tt-milestone-followup-row .editor') as HTMLElement
      expect(editorEl).not.toBeNull()
      setBlockText(editorEl, 'segue o baile')
      fireInput(editorEl)
      vi.advanceTimersByTime(400)

      expect(store.doc.teams[0]!.milestones[0]!.followup).toContain('segue o baile')
    })

    test('expanding pre-loads the editor with the milestone\'s existing follow-up', () => {
      const team = makeTeam({ milestones: [milestone({ id: 'a', followup: '## Plan' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()
      const editorEl = container.querySelector('.editor') as HTMLElement
      expect(editorEl.querySelector('h2')?.textContent).toBe('Plan')
    })

    test('collapsing a row disposes its editor', () => {
      const team = makeTeam({ milestones: [milestone({ id: 'a', followup: 'x' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const toggle = () => container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!
      toggle().click()
      expect(container.querySelector('.editor')).not.toBeNull()
      toggle().click()
      expect(container.querySelector('.editor')).toBeNull()
    })

    test('multiple rows can have their follow-up editors expanded simultaneously', () => {
      const team = makeTeam({
        milestones: [
          milestone({ id: 'a', title: 'A', date: '2026-01-01', followup: 'follow A' }),
          milestone({ id: 'b', title: 'B', date: '2026-02-01', followup: 'follow B' }),
        ],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const rowFor = (id: string) => container.querySelector(`[data-milestone-id="${id}"]`) as HTMLElement
      rowFor('a').querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()
      rowFor('b').querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

      const editors = [...container.querySelectorAll('.editor')]
      expect(editors).toHaveLength(2)
      expect(editors.map((e) => e.textContent)).toEqual(['follow A', 'follow B'])
    })

    test('expand-all button expands every milestone\'s follow-up and flips to "Collapse all"; clicking again collapses all', () => {
      const team = makeTeam({
        milestones: [
          milestone({ id: 'a', title: 'A', date: '2026-01-01', followup: 'follow A' }),
          milestone({ id: 'b', title: 'B', date: '2026-02-01', followup: 'follow B' }),
        ],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const expandAllBtn = container.querySelector<HTMLButtonElement>('.tt-milestone-expand-all-btn')!
      expect(expandAllBtn.textContent).toBe('Expand all')

      expandAllBtn.click()
      expect(container.querySelectorAll('.editor')).toHaveLength(2)
      expect(expandAllBtn.textContent).toBe('Collapse all')

      expandAllBtn.click()
      expect(container.querySelectorAll('.editor')).toHaveLength(0)
      expect(expandAllBtn.textContent).toBe('Expand all')
    })

    test('renaming a risk mentioned in an expanded follow-up live-updates its @mention chip', () => {
      const team = makeTeam({
        milestones: [milestone({ id: 'a', title: 'A', followup: 'Blocks @[Old Risk](risk:r1)' })],
        risks: [{ id: 'r1', title: 'Old Risk', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

      const chip = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="risk:r1"]')!
      expect(chip.textContent).toBe('@Old Risk')

      store.update((d) => {
        d.teams[0]!.risks.find((r) => r.id === 'r1')!.title = 'New Risk'
      }, { teamId: 'T1', sections: ['risks'] })

      expect(container.querySelector<HTMLAnchorElement>('a.ref[data-ref="risk:r1"]')?.textContent).toBe('@New Risk')
    })

    test('the chip still live-updates while an unrelated title input elsewhere is focused (the deferred-rebuild path)', () => {
      const team = makeTeam({
        milestones: [
          milestone({ id: 'a', title: 'A', date: '2026-01-01', followup: 'Blocks @[Old Risk](risk:r1)' }),
          milestone({ id: 'b', title: 'B', date: '2026-02-01' }),
        ],
        risks: [{ id: 'r1', title: 'Old Risk', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

      const chip = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="risk:r1"]')!
      expect(chip.textContent).toBe('@Old Risk')

      const bInput = Array.from(container.querySelectorAll<HTMLInputElement>('.tt-milestone-title-input')).find((i) => i.value === 'B')!
      bInput.focus()

      store.update((d) => {
        d.teams[0]!.risks.find((r) => r.id === 'r1')!.title = 'New Risk'
      }, { teamId: 'T1', sections: ['risks'] })

      // Full rebuild deferred to blur (caret preserved)...
      expect(document.activeElement).toBe(bInput)
      // ...but the chip patch is not: it isn't gated behind the deferral.
      expect(container.querySelector<HTMLAnchorElement>('a.ref[data-ref="risk:r1"]')?.textContent).toBe('@New Risk')

      bInput.dispatchEvent(new Event('blur'))
      expect(container.querySelector<HTMLAnchorElement>('a.ref[data-ref="risk:r1"]')?.textContent).toBe('@New Risk')
    })
  })

  test('a row carries a hover hint that right-click opens more actions', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'A' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const row = container.querySelector('[data-milestone-id="a"]') as HTMLElement
    expect(row.title).toBe('Right-click for more actions (duplicate, copy/move to team) · Row menu (Space) · Expand (Enter) · Navigate (arrows)')
  })

  // The timeline already distinguished done / overdue / upcoming through dot
  // fill and stroke; the list rendered every row identically. Same three
  // states, same vocabulary, now on the half you actually edit.
  test('each row carries a state class matching the timeline dot vocabulary', () => {
    const team = makeTeam({
      milestones: [
        milestone({ id: 'done', date: '2020-01-01', done: true }),
        milestone({ id: 'late', date: '2020-01-02', done: false }),
        milestone({ id: 'soon', date: '2099-01-01', done: false }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const stateOf = (id: string): string[] =>
      [...(container.querySelector(`[data-milestone-id="${id}"]`) as HTMLElement).classList]
        .filter((c) => c.startsWith('tt-milestone-state-'))

    expect(stateOf('done')).toEqual(['tt-milestone-state-done'])
    expect(stateOf('late')).toEqual(['tt-milestone-state-overdue'])
    expect(stateOf('soon')).toEqual(['tt-milestone-state-future'])
  })

  test('Space on a milestone row opens the context menu', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const row = container.querySelector('[data-milestone-id="a"]') as HTMLElement
    expect(row.getAttribute('tabindex')).toBe('0')
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(document.querySelector('.tt-context-menu')).not.toBeNull()
  })

  test('Enter on a milestone row expands its follow-up editor and focuses it, not the context menu', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const row = container.querySelector('[data-milestone-id="a"]') as HTMLElement

    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(document.querySelector('.tt-context-menu')).toBeNull()
    expect(container.querySelector('.tt-milestone-followup-row')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-milestone-followup-id="a"] .editor'))
  })

  test('Enter again collapses the follow-up editor and returns focus to the row', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    let row = container.querySelector('[data-milestone-id="a"]') as HTMLElement
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    row = container.querySelector('[data-milestone-id="a"]') as HTMLElement // renderList rebuilt the row node
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(container.querySelector('.tt-milestone-followup-row')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-milestone-id="a"]'))
  })

  test('the first row is focused as soon as the module opens', () => {
    const team = makeTeam({
      milestones: [milestone({ id: 'a', date: '2020-01-01' }), milestone({ id: 'b', date: '2020-02-01' })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(document.activeElement).toBe(container.querySelector('[data-milestone-id="a"]'))
  })

  // Regression: a team switch remounts both panes in the same tick
  // (PaneManager.renderAll's default renders pane 0 then pane 1), and this
  // module has no idea it's mounting into the pane that ISN'T
  // nav.focusedPane — without this guard, whichever pane happened to mount
  // second (always pane 1) would silently steal focus from pane 0's row.
  test('mounting into a pane that is not the focused pane does not steal focus', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    render(container, loc, store, pm, 0) // mounting into pane 0, but pane 1 is focused

    expect(document.activeElement).not.toBe(container.querySelector('[data-milestone-id="a"]'))
  })

  describe('ArrowUp/ArrowDown row navigation', () => {
    test('ArrowDown/ArrowUp move focus between rows, and no-op at the list ends', () => {
      const team = makeTeam({
        milestones: [milestone({ id: 'a', date: '2020-01-01' }), milestone({ id: 'b', date: '2020-02-01' })],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const rowA = container.querySelector('[data-milestone-id="a"]') as HTMLElement
      const rowB = container.querySelector('[data-milestone-id="b"]') as HTMLElement

      rowA.focus()
      rowA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(document.activeElement).toBe(rowB)

      rowB.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(document.activeElement).toBe(rowB) // already last row, no-op

      rowB.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(document.activeElement).toBe(rowA)
    })

    // The document-level fallback: if the user clicked away entirely (focus
    // landed on document.body, not some other field) and then presses an
    // arrow key, the first row is selected instead of the keypress doing
    // nothing.
    test('ArrowDown/ArrowUp with nothing focused at all selects the first row', () => {
      const team = makeTeam({
        milestones: [milestone({ id: 'a', date: '2020-01-01' }), milestone({ id: 'b', date: '2020-02-01' })],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      ;(document.activeElement as HTMLElement | null)?.blur()
      expect(document.activeElement).toBe(document.body)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

      expect(document.activeElement).toBe(container.querySelector('[data-milestone-id="a"]'))
    })
  })

  test('a defensive no-op when loc.ref.kind is not "milestones"', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm } = setup(team)
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    render(container, wrongLoc, store, pm)
    expect(container.children).toHaveLength(0)
  })

  test('expand button uses the same ▸/▾ arrow glyph as risks (not a 📝 icon)', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const btn = container.querySelector('.tt-milestone-expand-btn') as HTMLButtonElement
    expect(btn.textContent).toBe('▸')
    btn.click()
    expect(container.querySelector('.tt-milestone-expand-btn')!.textContent).toBe('▾')
  })

  describe('search-focus-item event', () => {
    test('expands a collapsed milestone and mounts its follow-up editor', () => {
      const team = makeTeam({ milestones: [milestone({ id: 'm1', followup: 'buried text' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      expect(container.querySelector('.tt-milestone-followup-row')).toBeNull()

      container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'm1' }))

      const editorEl = container.querySelector('.tt-milestone-followup-row .editor') as HTMLElement
      expect(editorEl).not.toBeNull()
      expect(editorEl.textContent).toContain('buried text')
    })

    test('is a no-op for an id that is not one of this team\'s milestones', () => {
      const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'does-not-exist' }))

      expect(container.querySelector('.tt-milestone-followup-row')).toBeNull()
    })

    test('is a no-op (no duplicate row) when the milestone is already expanded', () => {
      const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

      container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'm1' }))

      expect(container.querySelectorAll('.tt-milestone-followup-row').length).toBe(1)
    })

    test('the follow-up row carries the same data-item-id as its title row', () => {
      const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-milestone-expand-btn')!.click()

      const followupRow = container.querySelector('.tt-milestone-followup-row') as HTMLElement
      expect(followupRow.getAttribute('data-item-id')).toBe('m1')
    })
  })

  test('Enter in the title field blurs it, committing via onchange', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const titleInput = container.querySelector('.tt-milestone-title-input') as HTMLInputElement
    titleInput.focus()
    expect(document.activeElement).toBe(titleInput)
    titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.activeElement).not.toBe(titleInput)
  })

  test('Tab navigation skips the row\'s icon buttons, moving cleanly between data fields', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const row = container.querySelector('.tt-milestone-row')!
    expect(row.querySelector('.tt-milestone-date-input')!.getAttribute('tabindex')).toBeNull()
    expect(row.querySelector('.tt-milestone-title-input')!.getAttribute('tabindex')).toBeNull()
    expect((row.querySelector('.tt-milestone-expand-btn') as HTMLElement).tabIndex).toBe(-1)
    expect((row.querySelector('.tt-milestone-delete-btn') as HTMLElement).tabIndex).toBe(-1)
  })
})

describe('row context menu', () => {
  test('Duplicate appends a copy to the same team', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'milestones' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Duplicate').click()

    expect(store.doc.teams[0]!.milestones).toHaveLength(2)
  })

  test('Copy to team… copies into the target team with refs stripped, source untouched', () => {
    const from = makeTeam({ id: 'from', milestones: [milestone({ id: 'm1', followup: 'blocked by @[Fix](action:a1)' })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'milestones' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Copy to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.milestones).toHaveLength(1)
    const copied = store.doc.teams.find((t) => t.id === 'to')!.milestones
    expect(copied).toHaveLength(1)
    expect(copied[0]!.followup).toBe('blocked by Fix')
  })

  test('Delete opens the same confirm dialog as the row delete button, and removes the row on confirm', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'm1' })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'milestones' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Delete').click()

    const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Delete')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()

    expect(store.doc.teams[0]!.milestones).toHaveLength(0)
  })
})

// Regression: same stacking bug as risks.ts — the deferred-rebuild path armed
// a fresh `blur` listener on EVERY skipped mutation, all on the same focused
// element, so one blur fired N full renderAll() rebuilds.
describe('deferred rebuild while a field is focused', () => {
  test('arms exactly one blur listener regardless of how many mutations are skipped', () => {
    const { container, store, pm, loc } = setup(makeTeam({ milestones: [milestone({})] }))
    render(container, loc, store, pm)

    const input = container.querySelector<HTMLInputElement>('.tt-milestone-title-input')!
    input.focus()
    expect(document.activeElement).toBe(input)

    let armed = 0
    const origAdd = input.addEventListener.bind(input)
    input.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'blur') armed++
      return (origAdd as (t: string, ...a: unknown[]) => void)(type, ...rest)
    }) as typeof input.addEventListener

    for (let i = 0; i < 20; i++) {
      store.update((d) => { d.teams[0]!.milestones[0]!.title = `Kickoff ${i}` }, { teamId: 'T1', sections: ['milestones'] })
    }

    expect(armed).toBe(1)
  })

  test('the deferred rebuild still runs on blur', () => {
    const { container, store, pm, loc } = setup(makeTeam({ milestones: [milestone({ id: 'm1', title: 'Kickoff' })] }))
    render(container, loc, store, pm)

    const input = container.querySelector<HTMLInputElement>('.tt-milestone-title-input')!
    input.focus()

    store.update((d) => { d.teams[0]!.milestones.push(milestone({ id: 'm2', title: 'Launch', date: '2026-02-01' })) }, { teamId: 'T1', sections: ['milestones'] })
    expect(rows(container)).toHaveLength(1)

    input.dispatchEvent(new FocusEvent('blur'))
    expect(rows(container)).toHaveLength(2)
  })

  test('tearing down the module while a row\'s date-picker popover is open closes the popover instead of stranding it', () => {
    const { container, store, pm, loc } = setup(makeTeam({ milestones: [milestone({})] }))
    render(container, loc, store, pm)

    const dateInput = rows(container)[0]!.querySelector('.tt-date-picker-input') as HTMLInputElement
    dateInput.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.tt-date-picker-popover')).not.toBeNull()

    // Re-rendering into the same container is how withDisposal (modules/
    // lifecycle.ts) tears down the previously-mounted instance — the same
    // path a real module switch, team switch, or file close takes. The
    // popover lives in document.body, not inside `container`, so nothing
    // about this re-render's own DOM rebuild would touch it on its own.
    render(container, loc, store, pm)

    expect(document.querySelector('.tt-date-picker-popover')).toBeNull()
  })

  test('rebuilding the row list while a date-picker popover is open (e.g. a store change from another pane) closes it instead of stranding it', () => {
    const { container, store, pm, loc } = setup(makeTeam({ milestones: [milestone({ id: 'a' })] }))
    render(container, loc, store, pm)

    const dateInput = rows(container)[0]!.querySelector('.tt-date-picker-input') as HTMLInputElement
    dateInput.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.tt-date-picker-popover')).not.toBeNull()

    // A milestones-scoped store.update from elsewhere (not this row's own
    // date field) triggers renderAll()'s full rebuild — focusedCaretInput()
    // only defers for the row's *text/date inputs*, not for focus that has
    // already moved into the popover's own calendar buttons.
    document.querySelector<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)')?.focus()
    store.update((d) => { d.teams[0]!.milestones.push(milestone({ id: 'b', date: '2026-02-01', title: 'Launch' })) }, { teamId: 'T1', sections: ['milestones'] })

    expect(document.querySelector('.tt-date-picker-popover')).toBeNull()
  })
})
