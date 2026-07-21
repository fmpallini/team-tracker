import {
  renderRisks,
  computeExposure,
  exposureLevel,
  exposureColor,
  nextExposureSort,
  sortRisksForDisplay,
  moveRisk,
  type ExposureSort,
} from '../src/modules/risks'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Risk, Team } from '../src/core/types'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
  const calls: { idx: 0 | 1; loc: Loc }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
    openBothPanes: () => {},
    openInFocused: () => {},
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
  }
}

function risk(overrides: Partial<Risk>): Risk {
  return { id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false, ...overrides }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀',
    stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }],
    members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM>; loc: Loc } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const loc: Loc = { teamId: team.id, ref: { kind: 'risks' } }
  return { container, store, pm, loc }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US' }
  renderRisks(container, loc, ctx)
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.tt-risk-row'))
}

function titles(container: HTMLElement): string[] {
  return rows(container).map((r) => (r.querySelector('.tt-risk-title-input') as HTMLInputElement).value)
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
  describe('computeExposure / exposureLevel / exposureColor', () => {
    const cases: { chance: 1 | 2 | 3; impact: 1 | 2 | 3; exposure: number; level: 'low' | 'medium' | 'high'; color: string }[] = [
      { chance: 1, impact: 1, exposure: 1, level: 'low', color: '#16a34a' },
      { chance: 1, impact: 2, exposure: 2, level: 'low', color: '#16a34a' },
      { chance: 2, impact: 1, exposure: 2, level: 'low', color: '#16a34a' },
      { chance: 1, impact: 3, exposure: 3, level: 'medium', color: '#ca8a04' },
      { chance: 3, impact: 1, exposure: 3, level: 'medium', color: '#ca8a04' },
      { chance: 2, impact: 2, exposure: 4, level: 'medium', color: '#ca8a04' },
      { chance: 2, impact: 3, exposure: 6, level: 'high', color: '#dc2626' },
      { chance: 3, impact: 2, exposure: 6, level: 'high', color: '#dc2626' },
      { chance: 3, impact: 3, exposure: 9, level: 'high', color: '#dc2626' },
    ]
    test.each(cases)('chance=$chance impact=$impact -> exposure=$exposure ($level, $color)', ({ chance, impact, exposure, level, color }) => {
      expect(computeExposure(chance, impact)).toBe(exposure)
      expect(exposureLevel(exposure)).toBe(level)
      expect(exposureColor(exposure)).toBe(color)
    })
  })

  describe('nextExposureSort', () => {
    test('cycles unsorted -> desc -> asc -> unsorted', () => {
      let s: ExposureSort = 'none'
      s = nextExposureSort(s); expect(s).toBe('desc')
      s = nextExposureSort(s); expect(s).toBe('asc')
      s = nextExposureSort(s); expect(s).toBe('none')
    })
  })

  describe('sortRisksForDisplay', () => {
    test("'none' returns manual order (by .order), independent of array/storage order", () => {
      const risks = [
        risk({ id: 'b', order: 1 }),
        risk({ id: 'a', order: 0 }),
        risk({ id: 'c', order: 2 }),
      ]
      expect(sortRisksForDisplay(risks, 'none').map((r) => r.id)).toEqual(['a', 'b', 'c'])
    })

    test("'desc' sorts by computed exposure, ties broken by preserved manual order", () => {
      const clean = [
        risk({ id: 'a', order: 0, chance: 2, impact: 2 }), // exposure 4
        risk({ id: 'b', order: 1, chance: 3, impact: 2 }), // exposure 6
        risk({ id: 'c', order: 2, chance: 2, impact: 2 }), // exposure 4 (tie with a)
      ]
      expect(sortRisksForDisplay(clean, 'desc').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    })

    test("'asc' sorts by computed exposure ascending, ties broken by preserved manual order", () => {
      const clean = [
        risk({ id: 'a', order: 0, chance: 2, impact: 2 }), // exposure 4
        risk({ id: 'b', order: 1, chance: 1, impact: 1 }), // exposure 1
        risk({ id: 'c', order: 2, chance: 2, impact: 2 }), // exposure 4 (tie with a)
      ]
      expect(sortRisksForDisplay(clean, 'asc').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    })

    test('sorting never mutates the underlying .order field', () => {
      const risks = [risk({ id: 'a', order: 0, chance: 1, impact: 1 }), risk({ id: 'b', order: 1, chance: 3, impact: 3 })]
      sortRisksForDisplay(risks, 'desc')
      expect(risks.map((r) => r.order)).toEqual([0, 1])
    })
  })

  describe('moveRisk', () => {
    test('moves a risk before another, renumbering densely', () => {
      const risks = [risk({ id: 'a', order: 0 }), risk({ id: 'b', order: 1 }), risk({ id: 'c', order: 2 })]
      moveRisk(risks, 'c', 'a', 'before')
      const sorted = [...risks].sort((x, y) => x.order - y.order)
      expect(sorted.map((r) => r.id)).toEqual(['c', 'a', 'b'])
      expect(sorted.map((r) => r.order)).toEqual([0, 1, 2])
    })

    test('moves a risk after another', () => {
      const risks = [risk({ id: 'a', order: 0 }), risk({ id: 'b', order: 1 }), risk({ id: 'c', order: 2 })]
      moveRisk(risks, 'a', 'b', 'after')
      const sorted = [...risks].sort((x, y) => x.order - y.order)
      expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    })

    test('no-op when dragging a risk onto itself', () => {
      const risks = [risk({ id: 'a', order: 0 }), risk({ id: 'b', order: 1 })]
      moveRisk(risks, 'a', 'a', 'before')
      expect(risks.map((r) => r.order)).toEqual([0, 1])
    })

    test('no-op when the target id does not exist', () => {
      const risks = [risk({ id: 'a', order: 0 })]
      moveRisk(risks, 'a', 'ghost', 'before')
      expect(risks[0]!.order).toBe(0)
    })

    test('no-op when the dragged id does not exist', () => {
      const risks = [risk({ id: 'a', order: 0 })]
      moveRisk(risks, 'ghost', 'a', 'before')
      expect(risks[0]!.order).toBe(0)
    })
  })
})

describe('renderRisks', () => {
  test('shows an empty-state message when there are no risks', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-risk-empty')?.textContent).toBe('No risks')
  })

  test('renders rows in manual order by default', () => {
    const team = makeTeam({
      risks: [risk({ id: 'b', title: 'B', order: 1 }), risk({ id: 'a', title: 'A', order: 0 })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(titles(container)).toEqual(['A', 'B'])
  })

  test('a row carries a hover hint that right-click opens more actions', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const row = container.querySelector('[data-risk-id="a"]') as HTMLElement
    expect(row.title).toBe('Right-click for more actions (duplicate, copy/move to team)')
  })

  test('"+ Risk" appends a risk with default fields and focuses its title input', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', order: 0 }), risk({ id: 'b', order: 3 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, '+ Risk')

    const all = store.doc.teams[0]!.risks
    expect(all).toHaveLength(3)
    const added = all[2]!
    expect(added.order).toBe(4)
    expect(added.title).toBe('')
    expect(added.chance).toBe(1)
    expect(added.impact).toBe(1)
    expect(added.plan).toBe('mitigate')
    expect(added.followup).toBe('')

    const focused = document.activeElement as HTMLInputElement
    expect(focused.classList.contains('tt-risk-title-input')).toBe(true)
    expect(focused.closest('.tt-risk-row')?.getAttribute('data-risk-id')).toBe(added.id)
  })

  test('editing the title persists on change', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const input = container.querySelector('.tt-risk-title-input') as HTMLInputElement
    input.value = 'New title'
    input.dispatchEvent(new Event('change'))

    expect(store.doc.teams[0]!.risks[0]!.title).toBe('New title')
  })

  test('changing chance/impact persists and recomputes the exposure badge', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const badge = () => container.querySelector('.tt-risk-exposure-badge') as HTMLElement
    expect(badge().textContent).toBe('1')
    expect(badge().classList.contains('tt-risk-exposure-low')).toBe(true)

    const chanceSelect = container.querySelector('.tt-risk-chance-select') as HTMLSelectElement
    chanceSelect.value = '3'
    chanceSelect.dispatchEvent(new Event('change'))
    expect(store.doc.teams[0]!.risks[0]!.chance).toBe(3)

    const impactSelect = container.querySelector('.tt-risk-impact-select') as HTMLSelectElement
    impactSelect.value = '3'
    impactSelect.dispatchEvent(new Event('change'))
    expect(store.doc.teams[0]!.risks[0]!.impact).toBe(3)

    expect(badge().textContent).toBe('9')
    expect(badge().classList.contains('tt-risk-exposure-high')).toBe(true)
  })

  test('changing the plan select persists the RiskPlan value', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', plan: 'mitigate' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const planSelect = container.querySelector('.tt-risk-plan-select') as HTMLSelectElement
    expect(planSelect.value).toBe('mitigate')

    for (const plan of ['transfer', 'eliminate', 'accept', 'mitigate'] as const) {
      planSelect.value = plan
      planSelect.dispatchEvent(new Event('change'))
      expect(store.doc.teams[0]!.risks[0]!.plan).toBe(plan)
    }
  })

  test('deleting a risk with an empty title removes it immediately with no confirmation', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: '' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete risk')

    expect(store.doc.teams[0]!.risks).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
  })

  test('deleting a risk with a non-empty title requires confirmation', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete risk')
    expect(store.doc.teams[0]!.risks).toHaveLength(1)
    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Important"?')

    clickByTitleOrText(document.body, 'Delete')
    expect(store.doc.teams[0]!.risks).toHaveLength(0)
  })

  test('canceling the delete confirmation keeps the risk', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Important' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(container, 'Delete risk')
    clickByTitleOrText(document.body, 'Cancel')
    expect(store.doc.teams[0]!.risks).toHaveLength(1)
  })

  test('deleting a risk unlinks every reference to it across the team\'s notes', () => {
    const team = makeTeam({
      risks: [
        risk({ id: 'r1', title: 'Vendor delay', order: 0 }),
        risk({ id: 'r2', title: 'Other risk', order: 1, followup: 'related to @[Vendor delay](risk:r1) closely' }),
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    clickByTitleOrText(rows(container)[0]!, 'Delete risk')
    clickByTitleOrText(document.body, 'Delete')

    const remaining = store.doc.teams[0]!.risks
    expect(remaining.map((r) => r.id)).toEqual(['r2'])
    expect(remaining[0]!.followup).toBe('related to Vendor delay closely')
  })

  test('close button moves risk to the closed section; reopen brings it back', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1', title: 'Vendor delay' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    ;(container.querySelector('.tt-risk-close-btn') as HTMLButtonElement).click()
    expect(store.doc.teams[0]!.risks[0]!.closed).toBe(true)
    expect(container.querySelectorAll('.tt-risk-list .tt-risk-row')).toHaveLength(0)
    expect(container.querySelectorAll('.tt-risks-closed .tt-risk-row')).toHaveLength(1)

    ;(container.querySelector('.tt-risk-reopen-btn') as HTMLButtonElement).click()
    expect(store.doc.teams[0]!.risks[0]!.closed).toBe(false)
    expect(container.querySelectorAll('.tt-risk-list .tt-risk-row')).toHaveLength(1)
    expect(container.querySelectorAll('.tt-risks-closed .tt-risk-row')).toHaveLength(0)
  })

  test('clicking the "Exposição" header cycles display order (unsorted -> desc -> asc -> unsorted) without touching stored .order', () => {
    const team = makeTeam({
      risks: [
        risk({ id: 'a', title: 'A', order: 0, chance: 2, impact: 2 }), // exposure 4
        risk({ id: 'b', title: 'B', order: 1, chance: 1, impact: 1 }), // exposure 1
        risk({ id: 'c', title: 'C', order: 2, chance: 3, impact: 3 }), // exposure 9
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(titles(container)).toEqual(['A', 'B', 'C']) // unsorted: manual order

    const header = container.querySelector('.tt-risk-header-exposure') as HTMLButtonElement
    header.click()
    expect(titles(container)).toEqual(['C', 'A', 'B']) // desc: 9, 4, 1

    header.click()
    expect(titles(container)).toEqual(['B', 'A', 'C']) // asc: 1, 4, 9

    header.click()
    expect(titles(container)).toEqual(['A', 'B', 'C']) // back to unsorted manual order

    const orders = store.doc.teams[0]!.risks.map((r) => r.order)
    expect(orders).toEqual([0, 1, 2]) // display sorting never touched the stored order
  })

  test('rows are not draggable while an exposure sort is active', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(rows(container)[0]!.getAttribute('draggable')).toBe('true')
    ;(container.querySelector('.tt-risk-header-exposure') as HTMLButtonElement).click()
    expect(rows(container)[0]!.getAttribute('draggable')).toBe('false')
  })

  describe('follow-up editor', () => {
    test('expanding a row mounts a rich editor pre-loaded with the risk\'s follow-up markdown', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', followup: '## Plan' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      expect(container.querySelector('.editor')).toBeNull()
      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

      const editorEl = container.querySelector('.editor') as HTMLElement
      expect(editorEl).not.toBeNull()
      expect(editorEl.querySelector('h2')?.textContent).toBe('Plan')
    })

    test('editing follow-up content persists into risk.followup via the debounced onChange', () => {
      vi.useFakeTimers()
      const team = makeTeam({ risks: [risk({ id: 'a', followup: '' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
      const editorEl = container.querySelector('.editor') as HTMLElement
      setBlockText(editorEl, 'Escalate to sponsor')
      fireInput(editorEl)
      vi.advanceTimersByTime(400)

      expect(store.doc.teams[0]!.risks[0]!.followup).toBe('Escalate to sponsor')
    })

    test('collapsing a row disposes its editor', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', followup: 'x' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const toggle = () => container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!
      toggle().click()
      expect(container.querySelector('.editor')).not.toBeNull()
      toggle().click()
      expect(container.querySelector('.editor')).toBeNull()
    })

    test('multiple rows can have their follow-up editors expanded simultaneously', () => {
      const team = makeTeam({
        risks: [risk({ id: 'a', title: 'A', followup: 'follow A' }), risk({ id: 'b', title: 'B', followup: 'follow B' })],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const rowFor = (id: string) => container.querySelector(`[data-risk-id="${id}"]`) as HTMLElement
      rowFor('a').querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
      expect(container.querySelectorAll('.editor')).toHaveLength(1)
      expect(container.querySelector('.editor')!.textContent).toBe('follow A')

      rowFor('b').querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
      const editors = [...container.querySelectorAll('.editor')]
      expect(editors).toHaveLength(2)
      expect(editors.map((e) => e.textContent)).toEqual(['follow A', 'follow B'])
    })

    test('expand-all button expands every open risk\'s follow-up and flips to "Collapse all"; clicking again collapses all', () => {
      const team = makeTeam({
        risks: [risk({ id: 'a', title: 'A', followup: 'follow A' }), risk({ id: 'b', title: 'B', followup: 'follow B' })],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const expandAllBtn = container.querySelector<HTMLButtonElement>('.tt-risk-expand-all-btn')!
      expect(expandAllBtn.textContent).toBe('Expand all')

      expandAllBtn.click()
      expect(container.querySelectorAll('.editor')).toHaveLength(2)
      expect(expandAllBtn.textContent).toBe('Collapse all')

      expandAllBtn.click()
      expect(container.querySelectorAll('.editor')).toHaveLength(0)
      expect(expandAllBtn.textContent).toBe('Expand all')
    })

    test('expand-all label reverts to "Expand all" as soon as one row is collapsed out of an all-expanded state', () => {
      const team = makeTeam({
        risks: [risk({ id: 'a', title: 'A', followup: 'follow A' }), risk({ id: 'b', title: 'B', followup: 'follow B' })],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const expandAllBtn = container.querySelector<HTMLButtonElement>('.tt-risk-expand-all-btn')!
      expandAllBtn.click()
      expect(expandAllBtn.textContent).toBe('Collapse all')

      const rowFor = (id: string) => container.querySelector(`[data-risk-id="${id}"]`) as HTMLElement
      rowFor('a').querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
      expect(container.querySelectorAll('.editor')).toHaveLength(1)
      expect(expandAllBtn.textContent).toBe('Expand all')
    })

    test('clicking a ref chip in the follow-up navigates via makeRefClickHandler using the pane it was mounted in', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', followup: '@[Carla](person:stk-1) ' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm, 1)

      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
      const chip = container.querySelector<HTMLAnchorElement>('a.ref')!
      chip.click()

      expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
    })
  })

  test('preserves an in-progress title edit (skips rebuild, defers to blur) when the store changes elsewhere while focused', () => {
    const team = makeTeam({
      risks: [risk({ id: 'a', title: 'A' }), risk({ id: 'b', title: 'B', order: 1 })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const titleInputs = (): HTMLInputElement[] => Array.from(container.querySelectorAll<HTMLInputElement>('.tt-risk-title-input'))
    const aInput = titleInputs().find((i) => i.value === 'A')!
    aInput.focus()

    store.update((d) => { d.teams[0]!.risks[1]!.title = 'B changed' })

    expect(document.activeElement).toBe(aInput)
    expect(titleInputs().find((i) => i.value === 'B changed')).toBeUndefined()

    aInput.dispatchEvent(new Event('blur'))
    expect(titleInputs().find((i) => i.value === 'B changed')).not.toBeUndefined()
  })

  test('double render into the same container disposes the previous store subscription and any expanded editor', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', followup: 'x' })] })
    const { container, store, pm, loc } = setup(team)

    render(container, loc, store, pm)
    container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()
    expect(container.querySelectorAll('.editor')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)

    expect(() => store.update((d) => { d.teams[0]!.risks[0]!.title = 'A2' })).not.toThrow()
    expect(rows(container)).toHaveLength(1)
    expect(container.querySelectorAll('.editor')).toHaveLength(0)
  })

  test('a defensive no-op when loc.ref.kind is not "risks"', () => {
    const team = makeTeam({ risks: [risk({ id: 'a' })] })
    const { container, store, pm } = setup(team)
    const wrongLoc: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
    render(container, wrongLoc, store, pm)
    expect(container.children).toHaveLength(0)
  })

  test('Enter in the title field blurs it, committing via onchange', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Old' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const titleInput = container.querySelector('.tt-risk-title-input') as HTMLInputElement
    titleInput.focus()
    expect(document.activeElement).toBe(titleInput)
    titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.activeElement).not.toBe(titleInput)
  })

  test('Tab navigation skips the row\'s icon buttons, moving cleanly between data fields', () => {
    const team = makeTeam({ risks: [risk({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const row = container.querySelector('.tt-risk-row')!
    expect(row.querySelector('.tt-risk-title-input')!.getAttribute('tabindex')).toBeNull()
    expect(row.querySelector('.tt-risk-chance-select')!.getAttribute('tabindex')).toBeNull()
    expect((row.querySelector('.tt-risk-expand-btn') as HTMLElement).tabIndex).toBe(-1)
    expect((row.querySelector('.tt-risk-close-btn') as HTMLElement).tabIndex).toBe(-1)
    expect((row.querySelector('.tt-risk-delete-btn') as HTMLElement).tabIndex).toBe(-1)
  })
})

describe('row context menu', () => {
  test('Duplicate appends a copy to the same team', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'risks' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Duplicate').click()

    expect(store.doc.teams[0]!.risks).toHaveLength(2)
  })

  test('Move to team… removes the row from the source team', () => {
    const from = makeTeam({ id: 'from', risks: [risk({ id: 'r1', order: 0 })] })
    const to = makeTeam({ id: 'to', name: 'Team 2' })
    const doc = createEmptyDocument('en-US')
    doc.teams.push(from, to)
    doc.nav.activeTeamId = from.id
    const store = createStore(doc)
    const pm = fakePM()
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(container, { teamId: from.id, ref: { kind: 'risks' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Move to team…').click()
    const select = document.querySelector('select') as HTMLSelectElement
    select.value = 'to'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Confirm')!.click()

    expect(store.doc.teams.find((t) => t.id === 'from')!.risks).toHaveLength(0)
    expect(store.doc.teams.find((t) => t.id === 'to')!.risks).toHaveLength(1)
  })
})
