import {
  renderRisks,
  computeExposure,
  exposureLevel,
  nextExposureSort,
  sortRisksForDisplay,
  moveRisk,
  type ExposureSort,
} from '../src/modules/risks'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Risk, Team } from '../src/core/types'
import { SEARCH_FOCUS_ITEM_EVENT } from '../src/ui/search-highlight'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
  const calls: { idx: 0 | 1; loc: Loc }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
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
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex }
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
  describe('computeExposure / exposureLevel', () => {
    const cases: { chance: 1 | 2 | 3; impact: 1 | 2 | 3; exposure: number; level: 'low' | 'medium' | 'high' }[] = [
      { chance: 1, impact: 1, exposure: 1, level: 'low' },
      { chance: 1, impact: 2, exposure: 2, level: 'low' },
      { chance: 2, impact: 1, exposure: 2, level: 'low' },
      { chance: 1, impact: 3, exposure: 3, level: 'medium' },
      { chance: 3, impact: 1, exposure: 3, level: 'medium' },
      { chance: 2, impact: 2, exposure: 4, level: 'medium' },
      { chance: 2, impact: 3, exposure: 6, level: 'high' },
      { chance: 3, impact: 2, exposure: 6, level: 'high' },
      { chance: 3, impact: 3, exposure: 9, level: 'high' },
    ]
    // The stamp's color is no longer computed in JS — the level class the
    // badge carries resolves `--exposure-{level}` in styles.css, so a palette
    // switch reaches it. The level→class mapping is what's asserted here; the
    // rendering tests below assert the class actually lands on the badge.
    test.each(cases)('chance=$chance impact=$impact -> exposure=$exposure ($level)', ({ chance, impact, exposure, level }) => {
      expect(computeExposure(chance, impact)).toBe(exposure)
      expect(exposureLevel(exposure)).toBe(level)
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
    expect(row.title).toBe('Right-click for more actions (duplicate, copy/move to team) · Row menu (Space) · Expand (Enter) · Navigate (arrows)')
  })

  // Regression for the accessibility gap the row actions used to have: they
  // are `tabindex="-1"` *and* used to rest at `opacity: 0`, so there was no
  // pointer-free route to expand/close/delete at all. The row is now a Tab
  // stop that opens the same menu the right-click does.
  describe('keyboard route to the row actions', () => {
    test('the row is focusable', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const row = container.querySelector('[data-risk-id="a"]') as HTMLElement
      expect(row.getAttribute('tabindex')).toBe('0')
    })

    test('Space on the row opens the context menu', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const row = container.querySelector('[data-risk-id="a"]') as HTMLElement

      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      expect(document.querySelector('.tt-context-menu')).not.toBeNull()
    })

    test('Enter on the row expands its follow-up editor and focuses it, not the context menu', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const row = container.querySelector('[data-risk-id="a"]') as HTMLElement

      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

      expect(document.querySelector('.tt-context-menu')).toBeNull()
      expect(container.querySelector('.tt-risk-followup-row')).not.toBeNull()
      expect(document.activeElement).toBe(container.querySelector('[data-risk-followup-id="a"] .editor'))
    })

    test('Enter again collapses the follow-up editor and returns focus to the row', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      let row = container.querySelector('[data-risk-id="a"]') as HTMLElement
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

      row = container.querySelector('[data-risk-id="a"]') as HTMLElement // renderAll rebuilt the row node
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

      expect(container.querySelector('.tt-risk-followup-row')).toBeNull()
      expect(document.activeElement).toBe(container.querySelector('[data-risk-id="a"]'))
    })

    // The guard that keeps Enter meaning "commit and blur" in the title input
    // and Space meaning "open the dropdown" in a select.
    test('the same keys inside a row field do not open the menu or toggle expand', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      const titleInput = container.querySelector('.tt-risk-title-input') as HTMLInputElement
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const select = container.querySelector('.tt-risk-chance-select') as HTMLSelectElement
      select.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

      expect(document.querySelector('.tt-context-menu')).toBeNull()
      expect(container.querySelector('.tt-risk-followup-row')).toBeNull()
    })
  })

  test('the first row is focused as soon as the module opens', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 }), risk({ id: 'b', title: 'B', order: 1 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    expect(document.activeElement).toBe(container.querySelector('[data-risk-id="a"]'))
  })

  // Regression: a team switch remounts both panes in the same tick
  // (PaneManager.renderAll's default renders pane 0 then pane 1), and this
  // module has no idea it's mounting into the pane that ISN'T
  // nav.focusedPane — without this guard, whichever pane happened to mount
  // second (always pane 1) would silently steal focus from pane 0's row.
  test('mounting into a pane that is not the focused pane does not steal focus', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 })] })
    const { container, store, pm, loc } = setup(team)
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    render(container, loc, store, pm, 0) // mounting into pane 0, but pane 1 is focused

    expect(document.activeElement).not.toBe(container.querySelector('[data-risk-id="a"]'))
  })

  describe('ArrowUp/ArrowDown row navigation', () => {
    test('ArrowDown/ArrowUp move focus between rows, and no-op at the list ends', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 }), risk({ id: 'b', title: 'B', order: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const rowA = container.querySelector('[data-risk-id="a"]') as HTMLElement
      const rowB = container.querySelector('[data-risk-id="b"]') as HTMLElement

      rowA.focus()
      rowA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(document.activeElement).toBe(rowB)

      rowB.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(document.activeElement).toBe(rowB) // already last row, no-op

      rowB.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(document.activeElement).toBe(rowA)

      rowA.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(document.activeElement).toBe(rowA) // already first row, no-op
    })

    test('arrows inside a row field do not move focus between rows', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 }), risk({ id: 'b', title: 'B', order: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const titleInput = container.querySelector('[data-risk-id="a"] .tt-risk-title-input') as HTMLInputElement

      titleInput.focus()
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

      expect(document.activeElement).toBe(titleInput)
    })

    // The document-level fallback: if the user clicked away entirely (focus
    // landed on document.body, not some other field) and then presses an
    // arrow key, the first row is selected instead of the keypress doing
    // nothing.
    test('ArrowDown/ArrowUp with nothing focused at all selects the first row', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 }), risk({ id: 'b', title: 'B', order: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      ;(document.activeElement as HTMLElement | null)?.blur()
      expect(document.activeElement).toBe(document.body)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

      expect(document.activeElement).toBe(container.querySelector('[data-risk-id="a"]'))
    })

    test('the fallback does nothing while a field elsewhere has focus, or while a modal is open', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      ;(document.activeElement as HTMLElement | null)?.blur()

      const outside = document.createElement('input')
      document.body.appendChild(outside)
      outside.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(document.activeElement).toBe(outside)
      outside.blur()
      outside.remove()
      expect(document.activeElement).toBe(document.body)

      document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tt-modal-overlay' }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(document.activeElement).toBe(document.body)
    })

    test('Alt+ArrowRight (pane-select hotkey) does not trigger the fallback', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', order: 0 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      ;(document.activeElement as HTMLElement | null)?.blur()

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }))

      expect(document.activeElement).toBe(document.body)
    })
  })

  test('the chance/impact/plan selects carry their column name as an accessible label', () => {
    const team = makeTeam({ risks: [risk({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    for (const [cls, label] of [
      ['.tt-risk-chance-select', 'Chance'],
      ['.tt-risk-impact-select', 'Impact'],
      ['.tt-risk-plan-select', 'Plan'],
    ] as const) {
      expect((container.querySelector(cls) as HTMLElement).getAttribute('aria-label')).toBe(label)
    }
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

  // The stored value stays the bare number; only the visible label gained the
  // word, so nothing on screen leaves the reader guessing whether 3 is high
  // chance or high confidence.
  test('chance/impact options are labelled while still storing 1/2/3', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    for (const cls of ['.tt-risk-chance-select', '.tt-risk-impact-select']) {
      const select = container.querySelector(cls) as HTMLSelectElement
      expect([...select.options].map((o) => o.value)).toEqual(['1', '2', '3'])
      expect([...select.options].map((o) => o.textContent)).toEqual(['1 · Low', '2 · Medium', '3 · High'])
    }

    const chanceSelect = container.querySelector('.tt-risk-chance-select') as HTMLSelectElement
    chanceSelect.value = '3'
    chanceSelect.dispatchEvent(new Event('change'))
    expect(store.doc.teams[0]!.risks[0]!.chance).toBe(3)
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
    expect(remaining[0]!.followup).toBe('related to ~Vendor delay~ closely')
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

    test('renaming an action item mentioned in an expanded follow-up live-updates its @mention chip', () => {
      const team = makeTeam({
        risks: [risk({ id: 'a', title: 'A', followup: 'Blocked by @[Old Task](action:x1)' })],
        actionItems: [{ id: 'x1', summary: 'Old Task', status: 'todo', color: null, dueDate: null, assignee: '', order: 0, notes: '' }],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

      const chip = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:x1"]')!
      expect(chip.textContent).toBe('@Old Task')

      store.update((d) => {
        d.teams[0]!.actionItems.find((i) => i.id === 'x1')!.summary = 'New Task'
      }, { teamId: 'T1', sections: ['actions'] })

      expect(container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:x1"]')?.textContent).toBe('@New Task')
    })

    test('the chip still live-updates while an unrelated title input elsewhere is focused (the deferred-rebuild path)', () => {
      const team = makeTeam({
        risks: [risk({ id: 'a', title: 'A', followup: 'Blocked by @[Old Task](action:x1)' }), risk({ id: 'b', title: 'B' })],
        actionItems: [{ id: 'x1', summary: 'Old Task', status: 'todo', color: null, dueDate: null, assignee: '', order: 0, notes: '' }],
      })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

      const chip = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:x1"]')!
      expect(chip.textContent).toBe('@Old Task')

      const bInput = Array.from(container.querySelectorAll<HTMLInputElement>('.tt-risk-title-input')).find((i) => i.value === 'B')!
      bInput.focus()

      store.update((d) => {
        d.teams[0]!.actionItems.find((i) => i.id === 'x1')!.summary = 'New Task'
      }, { teamId: 'T1', sections: ['actions'] })

      // Full rebuild deferred to blur (caret preserved)...
      expect(document.activeElement).toBe(bInput)
      // ...but the chip patch is not: it isn't gated behind the deferral.
      expect(container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:x1"]')?.textContent).toBe('@New Task')

      bInput.dispatchEvent(new Event('blur'))
      expect(container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:x1"]')?.textContent).toBe('@New Task')
    })
  })

  describe('search-focus-item event', () => {
    test('expands a collapsed risk and mounts its follow-up editor', () => {
      const team = makeTeam({ risks: [risk({ id: 'r1', followup: 'buried text' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      expect(container.querySelector('.tt-risk-followup-row')).toBeNull()

      container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'r1' }))

      const editorEl = container.querySelector('.tt-risk-followup-row .editor') as HTMLElement
      expect(editorEl).not.toBeNull()
      expect(editorEl.textContent).toContain('buried text')
    })

    test('is a no-op for an id that is not one of this team\'s risks', () => {
      const team = makeTeam({ risks: [risk({ id: 'r1' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'does-not-exist' }))

      expect(container.querySelector('.tt-risk-followup-row')).toBeNull()
    })

    test('is a no-op (no duplicate row) when the risk is already expanded', () => {
      const team = makeTeam({ risks: [risk({ id: 'r1' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

      container.dispatchEvent(new CustomEvent(SEARCH_FOCUS_ITEM_EVENT, { detail: 'r1' }))

      expect(container.querySelectorAll('.tt-risk-followup-row').length).toBe(1)
    })

    test('the follow-up row carries the same data-item-id as its title row', () => {
      const team = makeTeam({ risks: [risk({ id: 'r1' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

      const followupRow = container.querySelector('.tt-risk-followup-row') as HTMLElement
      expect(followupRow.getAttribute('data-item-id')).toBe('r1')
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

  test('Delete opens the same confirm dialog as the row delete button, and removes the row on confirm', () => {
    const team = makeTeam({ risks: [risk({ id: 'r1', order: 0 })] })
    const { container, store, pm } = setup(team)
    render(container, { teamId: team.id, ref: { kind: 'risks' } }, store, pm)

    rightClick(rows(container)[0]!)
    contextMenuItem('Delete').click()

    const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-dialog button')).find((b) => b.textContent === 'Delete')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()

    expect(store.doc.teams[0]!.risks).toHaveLength(0)
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

// Regression: the deferred-rebuild path used to arm a fresh `blur` listener on
// EVERY skipped mutation, all on the same focused element — so a field held
// focused across N mutations fired N full renderAll() rebuilds on one blur.
describe('deferred rebuild while a field is focused', () => {
  test('arms exactly one blur listener regardless of how many mutations are skipped', () => {
    const { container, store, pm, loc } = setup(makeTeam({ risks: [risk({})] }))
    render(container, loc, store, pm)

    const input = container.querySelector<HTMLInputElement>('.tt-risk-title-input')!
    input.focus()
    expect(document.activeElement).toBe(input)

    let armed = 0
    const origAdd = input.addEventListener.bind(input)
    input.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'blur') armed++
      return (origAdd as (t: string, ...a: unknown[]) => void)(type, ...rest)
    }) as typeof input.addEventListener

    for (let i = 0; i < 20; i++) {
      store.update((d) => { d.teams[0]!.risks[0]!.order = i }, { teamId: 'T1', sections: ['risks'] })
    }

    expect(armed).toBe(1)
  })

  test('the deferred rebuild still runs on blur', () => {
    const { container, store, pm, loc } = setup(makeTeam({ risks: [risk({ id: 'r1', title: 'First' })] }))
    render(container, loc, store, pm)

    const input = container.querySelector<HTMLInputElement>('.tt-risk-title-input')!
    input.focus()

    // A change made elsewhere while this field holds focus is deferred...
    store.update((d) => { d.teams[0]!.risks.push(risk({ id: 'r2', title: 'Second', order: 1 })) }, { teamId: 'T1', sections: ['risks'] })
    expect(titles(container)).toEqual(['First'])

    // ...and lands once the field blurs.
    input.dispatchEvent(new FocusEvent('blur'))
    expect(titles(container)).toEqual(['First', 'Second'])
  })
})

test('a backlink chip renders before the expand button when another field mentions this risk', () => {
  const team = makeTeam()
  team.risks.push(risk({ id: 'r1', title: 'Backlog' }))
  team.milestones.push({ id: 'm1', date: '2026-08-01', title: 'Beta', done: false, followup: 'Watch @[Backlog](risk:r1)' })
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  const chip = container.querySelector('[data-risk-id="r1"] .tt-backlinks-chip')
  expect(chip?.textContent).toBe('↩ 1')
})

test('no chip when nothing mentions this risk', () => {
  const team = makeTeam()
  team.risks.push(risk({ id: 'r1', title: 'Backlog' }))
  const { container, store, pm, loc } = setup(team)
  render(container, loc, store, pm)
  expect(container.querySelector('[data-risk-id="r1"] .tt-backlinks-chip')).toBeNull()
})
