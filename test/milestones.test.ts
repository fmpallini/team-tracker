import {
  renderMilestones,
  computeTimelineLayout,
  sortByDate,
  truncateTitle,
} from '../src/modules/milestones'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Milestone, Team } from '../src/core/types'

function fakePM(): PaneManager {
  return {
    openInPane: () => {},
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
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
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
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

  test('renders one SVG circle per milestone, with a <title> carrying the full text', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a', title: 'A very long milestone title indeed' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const circle = container.querySelector('.tt-milestone-dot')!
    expect(circle.querySelector('title')?.textContent).toBe('A very long milestone title indeed')
    const label = container.querySelector('.tt-milestone-title-label')!
    expect(label.textContent).toBe(`${'A very long milestone title indeed'.slice(0, 16)}…`)
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

    const dateInput = rows(container)[0]!.querySelector('.tt-milestone-date-input') as HTMLInputElement
    dateInput.value = '2026-03-01'
    dateInput.dispatchEvent(new Event('change'))

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
  })

  test('a defensive no-op when loc.ref.kind is not "milestones"', () => {
    const team = makeTeam({ milestones: [milestone({ id: 'a' })] })
    const { container, store, pm } = setup(team)
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    render(container, wrongLoc, store, pm)
    expect(container.children).toHaveLength(0)
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
