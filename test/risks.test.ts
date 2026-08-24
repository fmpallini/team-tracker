import {
  renderRisks,
  computeExposure,
  exposureLevel,
  nextExposureSort,
  sortRisksForDisplay,
  moveRisk,
  computeQuadrantLayout,
  cellFromPoint,
  type ExposureSort,
} from '../src/modules/risks'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { PaneManager, ModuleCtx } from '../src/ui/panes'
import type { Loc, Risk, Team } from '../src/core/types'
import { SEARCH_FOCUS_ITEM_EVENT } from '../src/ui/search-highlight'

// jsdom has no layout engine, so Element.prototype.scrollIntoView doesn't
// exist at all (see test/scope-freshness.test.ts's identical guard).
// focusRiskFromQuadrant calls it unconditionally on every quadrant click/tap,
// which most tests here don't care to assert on — a no-op default keeps
// those from throwing; tests that DO want to assert the call still override
// it per-instance (`row.scrollIntoView = spy`), which shadows this default.
Element.prototype.scrollIntoView ??= () => {}

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
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex, saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} } }
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

  describe('computeQuadrantLayout', () => {
    test('empty input returns no dots', () => {
      expect(computeQuadrantLayout([])).toEqual([])
    })

    test('a single risk lands in its own (chance, impact) cell', () => {
      const [dot] = computeQuadrantLayout([{ id: 'a', chance: 1, impact: 1 }], 60)
      // chance=1 -> leftmost column (cx < 60); impact=1 -> bottom row (cy > 120, since impact
      // increases upward and the grid is 3 * 60 = 180 tall).
      expect(dot!.cx).toBeGreaterThan(0)
      expect(dot!.cx).toBeLessThan(60)
      expect(dot!.cy).toBeGreaterThan(120)
      expect(dot!.cy).toBeLessThan(180)
    })

    test('higher impact places the dot higher on screen (smaller cy) than lower impact, at the same chance', () => {
      const dots = computeQuadrantLayout([
        { id: 'lowImpact', chance: 2, impact: 1 },
        { id: 'highImpact', chance: 2, impact: 3 },
      ])
      const low = dots.find((d) => d.id === 'lowImpact')!
      const high = dots.find((d) => d.id === 'highImpact')!
      expect(high.cy).toBeLessThan(low.cy)
    })

    test('higher chance places the dot further right (larger cx) than lower chance, at the same impact', () => {
      const dots = computeQuadrantLayout([
        { id: 'lowChance', chance: 1, impact: 2 },
        { id: 'highChance', chance: 3, impact: 2 },
      ])
      const low = dots.find((d) => d.id === 'lowChance')!
      const high = dots.find((d) => d.id === 'highChance')!
      expect(high.cx).toBeGreaterThan(low.cx)
    })

    test('risks sharing a cell are packed apart, never landing on the exact same point', () => {
      const dots = computeQuadrantLayout([
        { id: 'a', chance: 2, impact: 2 },
        { id: 'b', chance: 2, impact: 2 },
        { id: 'c', chance: 2, impact: 2 },
      ])
      expect(dots).toHaveLength(3)
      const points = dots.map((d) => `${d.cx},${d.cy}`)
      expect(new Set(points).size).toBe(3)
    })

    test('a crowded cell shrinks its dot radius so the pack still fits', () => {
      const roomy = computeQuadrantLayout([{ id: 'a', chance: 1, impact: 1 }], 60)
      const crowded = computeQuadrantLayout(
        Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, chance: 1 as const, impact: 1 as const })),
        60
      )
      expect(crowded[0]!.r).toBeLessThan(roomy[0]!.r)
    })

    test('packing is deterministic: same input order always yields the same positions', () => {
      const input = [
        { id: 'a', chance: 3 as const, impact: 3 as const },
        { id: 'b', chance: 3 as const, impact: 3 as const },
      ]
      expect(computeQuadrantLayout(input)).toEqual(computeQuadrantLayout(input))
    })

    test('showLabel is true when a cell has room for its dots\' labels', () => {
      const dots = computeQuadrantLayout([
        { id: 'a', chance: 1, impact: 1 },
        { id: 'b', chance: 2, impact: 2 },
        { id: 'c', chance: 2, impact: 2 },
      ])
      expect(dots.every((d) => d.showLabel)).toBe(true)
    })

    test('showLabel turns false once a cell is too crowded for a label per row', () => {
      const dots = computeQuadrantLayout(
        Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, chance: 1 as const, impact: 1 as const })),
        60
      )
      expect(dots.every((d) => d.showLabel === false)).toBe(true)
    })

    test('a crowded (label-hidden) cell spreads its dots across both axes instead of a single cramped column', () => {
      const dots = computeQuadrantLayout(
        Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, chance: 1 as const, impact: 1 as const })),
        60
      )
      // A single-column layout would put every dot at the same cx; the
      // distributed pack should use more than one.
      expect(new Set(dots.map((d) => d.cx)).size).toBeGreaterThan(1)
    })
  })

  describe('cellFromPoint', () => {
    test.each([
      { x: 0, y: 0, chance: 1, impact: 3 }, // top-left corner
      { x: 170, y: 170, chance: 3, impact: 1 }, // bottom-right corner
      { x: 90, y: 90, chance: 2, impact: 2 }, // dead center
      { x: 60, y: 60, chance: 2, impact: 2 }, // exact cell boundary rounds into the next cell
    ] as const)('($x, $y) in a 60px-cell grid -> chance=$chance impact=$impact', ({ x, y, chance, impact }) => {
      expect(cellFromPoint(x, y, 60)).toEqual({ chance, impact })
    })

    test('clamps out-of-range points to the nearest edge cell instead of throwing', () => {
      expect(cellFromPoint(-50, -50, 60)).toEqual({ chance: 1, impact: 3 })
      expect(cellFromPoint(9999, 9999, 60)).toEqual({ chance: 3, impact: 1 })
    })

    test('is the exact inverse of computeQuadrantLayout\'s own cell placement for a lone dot in each cell', () => {
      for (const chance of [1, 2, 3] as const) {
        for (const impact of [1, 2, 3] as const) {
          const [dot] = computeQuadrantLayout([{ id: 'a', chance, impact }], 60)
          expect(cellFromPoint(dot!.cx, dot!.cy, 60)).toEqual({ chance, impact })
        }
      }
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

/** A plain tap: pointerdown then pointerup at the same client coordinates — below the drag threshold, so risks.ts's wireQuadrantDrag treats it as a click rather than a drag. */
function tapQuadrantDot(dot: Element, clientX = 0, clientY = 0): void {
  dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX, clientY }))
  dot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX, clientY }))
}

/** A drag: pointerdown at the start position, pointermove past the drag threshold at the target position, then pointerup there. */
function dragQuadrantDot(dot: Element, startX: number, startY: number, endX: number, endY: number): void {
  dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: startX, clientY: startY }))
  dot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: endX, clientY: endY }))
  dot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: endX, clientY: endY }))
}

/** Parses a quadrant dot's `<g transform="translate(x,y)">` into {x, y} — dots are positioned via this transform (see risks.ts's wireQuadrantDrag doc comment), not cx/cy attributes, so any shape (circle/polygon/rect) moves the same way. */
function dotTranslate(dot: Element): { x: number; y: number } {
  const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(dot.getAttribute('transform') ?? '')
  if (!match) throw new Error('dot has no translate transform')
  return { x: Number(match[1]), y: Number(match[2]) }
}

/** Reads the quadrant's grid origin and cell size straight from the rendered chance=1/impact=3 (top-left) cell rect — robust against risks.ts's internal padding/cell-size constants without needing to export them just for tests. clientX/clientY that should land in a given (chance, impact) cell can then be computed as gx0 + (chance-1)*cell + local offset, gy0 + (3-impact)*cell + local offset (jsdom's zero-size getBoundingClientRect means wireQuadrantDrag's own clientX/clientY-to-local-point conversion is 1:1, no scaling). */
function quadrantGeometry(container: Element): { gx0: number; gy0: number; cell: number } {
  const topLeft = container.querySelector('.tt-risk-quadrant-cell[data-chance="1"][data-impact="3"]')!
  return { gx0: Number(topLeft.getAttribute('x')), gy0: Number(topLeft.getAttribute('y')), cell: Number(topLeft.getAttribute('width')) }
}

describe('quadrant', () => {
  test('is hidden when there are no open risks', () => {
    const team = makeTeam()
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const quadrant = container.querySelector('.tt-risk-quadrant') as HTMLElement
    expect(quadrant.style.display).toBe('none')
  })

  test('is hidden when every risk is closed', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', closed: true })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    const quadrant = container.querySelector('.tt-risk-quadrant') as HTMLElement
    expect(quadrant.style.display).toBe('none')
  })

  test('renders one dot per open risk, excluding closed ones', () => {
    const team = makeTeam({
      risks: [risk({ id: 'a', title: 'Open one' }), risk({ id: 'b', title: 'Closed one', closed: true })],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const dots = container.querySelectorAll('.tt-risk-quadrant-dot')
    expect(dots).toHaveLength(1)
    expect(dots[0]!.getAttribute('data-quadrant-risk-id')).toBe('a')
  })

  test('a dot has the same flat color regardless of exposure level — only the cell background varies', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 }), risk({ id: 'b', chance: 3, impact: 3 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const dots = [...container.querySelectorAll('.tt-risk-quadrant-dot')]
    expect(dots).toHaveLength(2)
    for (const dot of dots) {
      expect(dot.getAttribute('class')).toBe('tt-risk-quadrant-dot')
    }
  })

  test('a dot is labelled with (a truncation of) its risk\'s title, short enough to stay inside the cell', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Vendor delivery delay past Q3' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const label = container.querySelector('.tt-risk-quadrant-label')!
    expect(label.firstChild!.textContent).toBe('Vendor deli…')
  })

  test('a label carries the untruncated title as its own tooltip, same as the dot next to it', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Vendor delivery delay past Q3' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const label = container.querySelector('.tt-risk-quadrant-label')!
    expect(label.querySelector('title')!.textContent).toBe('Vendor delivery delay past Q3')
  })

  test('a short title is not truncated', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'Short' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelector('.tt-risk-quadrant-label')!.firstChild!.textContent).toBe('Short')
  })

  test('labels are omitted once a cell is too crowded for them to stay legible, without dropping the dots', () => {
    const team = makeTeam({
      risks: Array.from({ length: 9 }, (_, i) => risk({ id: `r${i}`, title: `Risk ${i}`, chance: 1, impact: 1 })),
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelectorAll('.tt-risk-quadrant-dot')).toHaveLength(9)
    expect(container.querySelectorAll('.tt-risk-quadrant-label')).toHaveLength(0)
  })

  test('the quadrant carries all 9 exposure-tinted background cells', () => {
    const team = makeTeam({ risks: [risk({ id: 'a' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelectorAll('.tt-risk-quadrant-cell')).toHaveLength(9)
    expect(container.querySelectorAll('.tt-risk-quadrant-cell-low').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.tt-risk-quadrant-cell-high').length).toBeGreaterThan(0)
  })

  test('shows the sum of every open risk\'s exposure, excluding closed ones', () => {
    const team = makeTeam({
      risks: [
        risk({ id: 'a', chance: 2, impact: 3 }), // 6
        risk({ id: 'b', chance: 1, impact: 2 }), // 2
        risk({ id: 'c', chance: 3, impact: 3, closed: true }), // excluded
      ],
    })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    expect(container.querySelector('.tt-risk-exposure-total-value')!.textContent).toBe('8')
  })

  test('clicking a dot scrolls to and focuses its row', () => {
    // Clicking an already-expanded risk's dot doesn't trigger a rebuild
    // (see the next test for the collapsed case), so the row reference
    // stays valid for the scrollIntoView stub below.
    const team = makeTeam({ risks: [risk({ id: 'a', title: 'A', followup: 'x' }), risk({ id: 'b', title: 'B' })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)
    container.querySelector<HTMLButtonElement>('.tt-risk-expand-btn')!.click()

    const row = container.querySelector('[data-risk-id="a"].tt-risk-row') as HTMLElement
    const scrollSpy = vi.fn()
    row.scrollIntoView = scrollSpy

    const dot = container.querySelector('.tt-risk-quadrant-dot[data-quadrant-risk-id="a"]')!
    tapQuadrantDot(dot)

    expect(scrollSpy).toHaveBeenCalledWith({ block: 'center' })
    expect(document.activeElement).toBe(row)
  })

  test('clicking a dot for a collapsed risk expands its follow-up editor before jumping to it', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = () => {}
    try {
      const team = makeTeam({ risks: [risk({ id: 'a', title: 'A' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)

      expect(container.querySelector('.tt-risk-followup-row')).toBeNull()

      const dot = container.querySelector('.tt-risk-quadrant-dot[data-quadrant-risk-id="a"]')!
      tapQuadrantDot(dot)

      expect(container.querySelector('.tt-risk-followup-row')).not.toBeNull()
      expect(document.activeElement).toBe(container.querySelector('[data-risk-id="a"].tt-risk-row'))
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  test('re-renders live when chance/impact change elsewhere (e.g. via the select) — moving the dot to the high cell', () => {
    const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
    const { container, store, pm, loc } = setup(team)
    render(container, loc, store, pm)

    const dotXY = () => dotTranslate(container.querySelector('.tt-risk-quadrant-dot')!)
    const lowXY = dotXY()

    const chanceSelect = container.querySelector('.tt-risk-chance-select') as HTMLSelectElement
    chanceSelect.value = '3'
    chanceSelect.dispatchEvent(new Event('change'))
    const impactSelect = container.querySelector('.tt-risk-impact-select') as HTMLSelectElement
    impactSelect.value = '3'
    impactSelect.dispatchEvent(new Event('change'))

    // chance=1,impact=1 sits bottom-left; chance=3,impact=3 sits top-right —
    // moving there should shift the dot right (larger x) and up (smaller y).
    const highXY = dotXY()
    expect(highXY.x).toBeGreaterThan(lowXY.x)
    expect(highXY.y).toBeLessThan(lowXY.y)
  })

  describe('plan shapes', () => {
    test('mitigate renders a circle', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', plan: 'mitigate' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      expect(container.querySelector('.tt-risk-quadrant-dot')!.firstElementChild!.tagName).toBe('circle')
    })

    test('transfer renders a 4-point polygon (diamond)', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', plan: 'transfer' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const shape = container.querySelector('.tt-risk-quadrant-dot')!.firstElementChild!
      expect(shape.tagName).toBe('polygon')
      expect(shape.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4)
    })

    test('eliminate renders a square', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', plan: 'eliminate' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      expect(container.querySelector('.tt-risk-quadrant-dot')!.firstElementChild!.tagName).toBe('rect')
    })

    test('accept renders a 3-point polygon (triangle)', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', plan: 'accept' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const shape = container.querySelector('.tt-risk-quadrant-dot')!.firstElementChild!
      expect(shape.tagName).toBe('polygon')
      expect(shape.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(3)
    })
  })

  describe('plan legend', () => {
    test('shows one legend item per plan, in the same order as the plan dropdown, each labelled', () => {
      const team = makeTeam({ risks: [risk({ id: 'a' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const items = [...container.querySelectorAll('.tt-risk-quadrant-legend-item')]
      expect(items.map((i) => i.textContent)).toEqual(['Mitigate', 'Transfer', 'Eliminate', 'Accept'])
    })

    test('legend icon shapes are a distinct class from the real chart dots, so they are not counted as extra risks', () => {
      const team = makeTeam({ risks: [risk({ id: 'a' })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      expect(container.querySelectorAll('.tt-risk-quadrant-dot')).toHaveLength(1)
      expect(container.querySelectorAll('.tt-risk-quadrant-legend-shape')).toHaveLength(4)
    })
  })

  describe('drag to set chance/impact', () => {
    test('dragging a dot to another cell persists the new chance/impact', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const { gx0, gy0, cell } = quadrantGeometry(container)
      const dot = container.querySelector('.tt-risk-quadrant-dot')!

      dragQuadrantDot(dot, gx0 + 10, gy0 + 170, gx0 + 2 * cell + cell / 2, gy0 + cell / 2)

      expect(store.doc.teams[0]!.risks[0]!.chance).toBe(3)
      expect(store.doc.teams[0]!.risks[0]!.impact).toBe(3)
    })

    test('a tap that never crosses the drag threshold does not change chance/impact', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const { gx0, gy0 } = quadrantGeometry(container)
      const dot = container.querySelector('.tt-risk-quadrant-dot')!

      tapQuadrantDot(dot, gx0 + 10, gy0 + 170)

      expect(store.doc.teams[0]!.risks[0]!.chance).toBe(1)
      expect(store.doc.teams[0]!.risks[0]!.impact).toBe(1)
    })

    test('dragging past the grid edge clamps to the nearest edge cell instead of leaving chance/impact unresolved', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const { gx0, gy0 } = quadrantGeometry(container)
      const dot = container.querySelector('.tt-risk-quadrant-dot')!

      dragQuadrantDot(dot, gx0 + 10, gy0 + 170, gx0 + 9999, gy0 - 9999)

      expect(store.doc.teams[0]!.risks[0]!.chance).toBe(3)
      expect(store.doc.teams[0]!.risks[0]!.impact).toBe(3)
    })

    test('highlights the cell under the pointer while dragging, and clears the highlight on drop', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const { gx0, gy0, cell } = quadrantGeometry(container)
      const dot = container.querySelector('.tt-risk-quadrant-dot')!
      const targetX = gx0 + 2 * cell + cell / 2
      const targetY = gy0 + cell / 2

      dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: gx0 + 10, clientY: gy0 + 170 }))
      dot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: targetX, clientY: targetY }))

      const target = container.querySelector('.tt-risk-quadrant-cell-drag-target')
      expect(target?.getAttribute('data-chance')).toBe('3')
      expect(target?.getAttribute('data-impact')).toBe('3')

      dot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: targetX, clientY: targetY }))
      expect(container.querySelector('.tt-risk-quadrant-cell-drag-target')).toBeNull()
    })

    test('a cancelled drag (pointercancel) discards the move without persisting any change', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const { gx0, gy0, cell } = quadrantGeometry(container)
      const dot = container.querySelector('.tt-risk-quadrant-dot')!

      dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: gx0 + 10, clientY: gy0 + 170 }))
      dot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: gx0 + 2 * cell + cell / 2, clientY: gy0 + cell / 2 }))
      dot.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))

      expect(store.doc.teams[0]!.risks[0]!.chance).toBe(1)
      expect(store.doc.teams[0]!.risks[0]!.impact).toBe(1)
      expect(container.querySelector('.tt-risk-quadrant-cell-drag-target')).toBeNull()
    })

    test('dragging a risk into a cell that already holds another risk repacks both without overlap', () => {
      const team = makeTeam({ risks: [risk({ id: 'a', chance: 1, impact: 1 }), risk({ id: 'b', chance: 3, impact: 3 })] })
      const { container, store, pm, loc } = setup(team)
      render(container, loc, store, pm)
      const { gx0, gy0, cell } = quadrantGeometry(container)
      const dotA = container.querySelector('.tt-risk-quadrant-dot[data-quadrant-risk-id="a"]')!

      dragQuadrantDot(dotA, gx0 + 10, gy0 + 170, gx0 + 2 * cell + cell / 2, gy0 + cell / 2)

      const risks = store.doc.teams[0]!.risks
      expect(risks.find((r) => r.id === 'a')!.chance).toBe(3)
      expect(risks.find((r) => r.id === 'a')!.impact).toBe(3)
      expect(container.querySelectorAll('.tt-risk-quadrant-dot')).toHaveLength(2)
    })
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
