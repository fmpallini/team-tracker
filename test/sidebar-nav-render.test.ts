// Sidebar cost + behaviour on nav-only mutations (store.updateNav — pane focus
// click, history step, team switch, collapse toggle) and its row interaction
// wiring. Nav mutations never change the team list, so they should repaint the
// active highlight and the header indicator without rebuilding every row; and
// the per-row drag/click wiring should not cost listeners proportional to the
// number of teams. The behavioural tests here must hold before AND after that
// refactor; the metric tests print the numbers the refactor is judged by.
import { mountSidebar, type SidebarHandle } from '../src/ui/sidebar'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { todayIso } from '../src/core/i18n'
import { addDaysIso } from '../src/core/date'
import type { Loc } from '../src/core/types'
import type { PaneManager } from '../src/ui/panes'

function fakePM(): PaneManager {
  return {
    openInPane: () => {}, openBothPanes: () => {}, openInFocused: vi.fn<(loc: Loc) => void>(),
    openInSecondaryPane: () => 0, toggleSplit: () => {}, renderAll: () => {},
    registerModule: () => {}, setSpaceConstrained: () => {}, setSplitSpaceConstrained: () => {}, dispose: () => {},
  } as unknown as PaneManager
}

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

let handle: SidebarHandle | undefined

function setup(teams = 0): { shell: Shell; store: Store; selectTeam: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  for (let i = 0; i < teams; i++) {
    doc.teams.push({ id: `T${i}`, name: `Team ${i}`, emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} })
  }
  if (teams) doc.nav.activeTeamId = 'T0'
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const selectTeam = vi.fn((id: string) => { store.updateNav((d) => { d.nav.activeTeamId = id }) })
  handle = mountSidebar(shell, store, fakePM(), { selectTeam, renderPanes: vi.fn() })
  return { shell, store, selectTeam }
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tt-team-item'))
const activeNames = (): string[] => rows().filter((r) => r.classList.contains('active')).map((r) => r.querySelector('.tt-team-name')!.textContent!)

afterEach(() => {
  handle?.dispose()
  handle = undefined
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('nav-only mutations keep the sidebar correct', () => {
  test('active highlight follows nav.activeTeamId, exactly one row active', () => {
    const { store } = setup(5)
    expect(activeNames()).toEqual(['Team 0'])
    store.updateNav((d) => { d.nav.activeTeamId = 'T3' })
    expect(activeNames()).toEqual(['Team 3'])
    store.updateNav((d) => { d.nav.activeTeamId = null })
    expect(activeNames()).toEqual([])
    store.updateNav((d) => { d.nav.activeTeamId = 'T4' })
    expect(activeNames()).toEqual(['Team 4'])
  })

  test('header indicator label and visibility follow the active team while collapsed', () => {
    const { store, shell } = setup(3)
    store.updateNav((d) => { d.nav.sidebarCollapsed = true })
    const ind = shell.headerCenter.querySelector('.tt-header-team-indicator') as HTMLElement
    expect(ind.classList.contains('visible')).toBe(true)
    expect(ind.textContent).toContain('Team 0')
    store.updateNav((d) => { d.nav.activeTeamId = 'T2' })
    expect(ind.textContent).toContain('Team 2')
    store.updateNav((d) => { d.nav.sidebarCollapsed = false })
    expect(ind.classList.contains('visible')).toBe(false)
  })

  test('collapse toggle via nav updates data-collapsed', () => {
    const { store, shell } = setup(2)
    store.updateNav((d) => { d.nav.sidebarCollapsed = true })
    expect(shell.sidebar.dataset.collapsed).toBe('true')
    store.updateNav((d) => { d.nav.sidebarCollapsed = false })
    expect(shell.sidebar.dataset.collapsed).toBe('false')
  })

  test('the toggle glyph and header label are not rewritten by a nav mutation that changes neither', () => {
    const { store, shell } = setup(3)
    store.updateNav((d) => { d.nav.sidebarCollapsed = true })
    const glyph = document.querySelector('.tt-sidebar-toggle-icon svg')
    const label = shell.headerCenter.querySelector('.tt-header-team-indicator-label')!
    const labelText = label.firstChild
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    expect(document.querySelector('.tt-sidebar-toggle-icon svg')).toBe(glyph)
    expect(label.firstChild).toBe(labelText) // same text node, not replaced
    store.updateNav((d) => { d.nav.sidebarCollapsed = false })
    expect(document.querySelector('.tt-sidebar-toggle-icon svg')).not.toBe(glyph) // state flipped: glyph changes
    store.updateNav((d) => { d.nav.activeTeamId = 'T2' })
    store.updateNav((d) => { d.nav.sidebarCollapsed = true })
    expect(label.textContent).toContain('Team 2')
  })

  test('rows still select the team after nav-only mutations', () => {
    const { store, selectTeam } = setup(4)
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    store.updateNav((d) => { d.nav.focusedPane = 0 })
    rows()[2]!.click()
    expect(selectTeam).toHaveBeenCalledWith('T2')
  })

  test('the due badge and edit button of a row do not select the team', () => {
    const { store, selectTeam } = setup(2)
    store.update((d) => {
      d.teams[0]!.actionItems.push({ id: 'a', summary: 'x', status: 'todo', notes: '', assignee: '', dueDate: todayIso(), color: 'ledger', order: 0 })
    }, { teamId: 'T0', sections: ['actions'] })
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    const badge = rows()[0]!.querySelector('.tt-team-due-badge') as HTMLElement
    badge.click()
    expect(selectTeam).not.toHaveBeenCalled()
    document.querySelectorAll('.tt-modal-overlay, .tt-due-panel').forEach((n) => n.remove())
    ;(rows()[1]!.querySelector('.tt-team-edit-btn') as HTMLElement).click()
    expect(selectTeam).not.toHaveBeenCalled()
    expect(document.querySelector('input[name="tt-team-name"]')).not.toBeNull()
  })

  test('due badges roll over with the calendar day on the next nav mutation', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0))
    const { store, shell } = setup(1)
    const dueIn10 = addDaysIso(todayIso(), 10)
    store.update((d) => {
      d.teams[0]!.actionItems.push({ id: 'a', summary: 'x', status: 'todo', notes: '', assignee: '', dueDate: dueIn10, color: 'ledger', order: 0 })
    }, { teamId: 'T0', sections: ['actions'] })
    expect(rows()[0]!.querySelector('.tt-team-due-badge')).toBeNull() // 10 days out > dueSoonDays (7)

    vi.setSystemTime(new Date(2026, 5, 6, 12, 0, 0)) // 5 days later: now due soon
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    expect(rows()[0]!.querySelector('.tt-team-due-badge')?.textContent).toBe('1')
    expect(shell.sidebar.querySelector('.tt-due-btn')!.classList.contains('tt-due-empty')).toBe(false)
  })

  test('a content change after nav mutations still rebuilds and keeps the right highlight', () => {
    const { store } = setup(3)
    store.updateNav((d) => { d.nav.activeTeamId = 'T1' })
    store.update((d) => { d.teams[1]!.name = 'Renamed' })
    expect(activeNames()).toEqual(['Renamed'])
  })

  test('replaceDoc with a different team list repaints the rows', () => {
    const { store } = setup(3)
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    const next = createEmptyDocument('en-US')
    next.teams.push({ id: 'Z', name: 'Zed', emoji: '⚡', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} })
    next.nav.activeTeamId = 'Z'
    store.replaceDoc(next)
    expect(rows().map((r) => r.querySelector('.tt-team-name')!.textContent)).toEqual(['Zed'])
    expect(activeNames()).toEqual(['Zed'])
  })
})

describe('row drag wiring', () => {
  const drag = (el: Element, type: string, clientY = 0): void => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY })) }

  test('dragover marks the hovered row top/bottom half and clears the previous mark', () => {
    setup(3)
    const [a, b, c] = rows() as [HTMLElement, HTMLElement, HTMLElement]
    drag(a, 'dragstart')
    drag(b, 'dragover', 5) // zero-size rect in jsdom: clientY>0 => bottom half
    expect(b.classList.contains('drag-over-bottom')).toBe(true)
    drag(c, 'dragover', -5)
    expect(c.classList.contains('drag-over-top')).toBe(true)
    expect(b.classList.contains('drag-over-bottom')).toBe(false)
  })

  test('dragover without a drag in flight marks nothing', () => {
    setup(2)
    const [a] = rows()
    drag(a!, 'dragover', 5)
    expect(a!.className).not.toMatch(/drag-over/)
  })

  test('dragleave clears the row mark, dragend clears everything and cancels the drag', () => {
    const { store } = setup(3)
    store.markSaved()
    const [a, b] = rows() as [HTMLElement, HTMLElement]
    drag(a, 'dragstart')
    drag(b, 'dragover', 5)
    drag(b, 'dragleave')
    expect(b.className).not.toMatch(/drag-over/)
    drag(b, 'dragover', 5)
    drag(a, 'dragend')
    expect(b.className).not.toMatch(/drag-over/)
    drag(b, 'drop', 5) // drag was ended: a stray drop must not reorder
    expect(store.doc.teams.map((t) => t.id)).toEqual(['T0', 'T1', 'T2'])
    expect(store.dirty).toBe(false)
  })

  test('a drag started before a nav-only mutation still drops correctly', () => {
    const { store } = setup(3)
    const [a] = rows() as [HTMLElement]
    drag(a, 'dragstart')
    store.updateNav((d) => { d.nav.focusedPane = 1 }) // e.g. a click lands mid-drag
    drag(rows()[2]!, 'drop', 5)
    expect(store.doc.teams.map((t) => t.id)).toEqual(['T1', 'T2', 'T0'])
  })

  test('reorder after earlier reorders targets the row currently at that index', () => {
    const { store } = setup(4)
    drag(rows()[0]!, 'dragstart'); drag(rows()[3]!, 'drop', 5) // T1 T2 T3 T0
    drag(rows()[3]!, 'dragstart'); drag(rows()[0]!, 'drop', -5) // T0 T1 T2 T3
    expect(store.doc.teams.map((t) => t.id)).toEqual(['T0', 'T1', 'T2', 'T3'])
  })

  test('events on non-row space inside the list do nothing', () => {
    const { store } = setup(2)
    store.markSaved()
    const list = document.querySelector('.tt-team-list')!
    expect(() => { drag(list, 'dragover', 5); drag(list, 'drop', 5); drag(list, 'dragleave'); drag(list, 'dragend') }).not.toThrow()
    expect(store.dirty).toBe(false)
  })
})

describe('metrics', () => {
  const TEAMS = 50

  test('a nav-only mutation: DOM nodes added/removed in the sidebar', () => {
    const { store, shell } = setup(TEAMS)
    const log: MutationRecord[] = []
    const mo = new MutationObserver((r) => { log.push(...r) })
    mo.observe(shell.sidebar, { childList: true, subtree: true })
    store.updateNav((d) => { d.nav.focusedPane = 1 })
    log.push(...mo.takeRecords())
    mo.disconnect()
    const countEls = (nl: NodeList): number => Array.from(nl).reduce((n, x) => n + (x instanceof Element ? 1 + x.querySelectorAll('*').length : 0), 0)
    const added = log.reduce((n, r) => n + countEls(r.addedNodes), 0)
    const removed = log.reduce((n, r) => n + r.removedNodes.length, 0)
    console.log(`[metric] nav mutation, ${TEAMS} teams: ${added} nodes added, ${removed} removed`)
    expect(added).toBe(0)
  })

  test('a nav-only mutation: wall time for 300 mutations', () => {
    const { store } = setup(TEAMS)
    const t0 = performance.now()
    for (let i = 0; i < 300; i++) store.updateNav((d) => { d.nav.focusedPane = i % 2 === 0 ? 1 : 0 })
    console.log(`[metric] 300 nav mutations, ${TEAMS} teams: ${(performance.now() - t0).toFixed(1)}ms`)
  })

  test('listeners attached while rendering the team list', () => {
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    setup(TEAMS)
    const total = spy.mock.calls.length
    const onRows = spy.mock.calls.filter((_c, i) => spy.mock.contexts[i] instanceof HTMLElement && (spy.mock.contexts[i] as HTMLElement).classList?.contains('tt-team-item')).length
    spy.mockRestore()
    console.log(`[metric] ${TEAMS} teams: ${total} addEventListener calls total, ${onRows} directly on team rows`)
  })
})
