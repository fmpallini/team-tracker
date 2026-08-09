import { mountSearch } from '../src/ui/search-ui'
import { createShell, type Shell } from '../src/ui/shell'
import { createPaneManager } from '../src/ui/panes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { renderMilestones } from '../src/modules/milestones'
import { renderActionItems } from '../src/modules/action-items'
import type { Team } from '../src/core/types'

// jsdom does not implement matchMedia; createShell() needs it to watch the
// OS theme preference (same stub as test/panes.test.ts and test/search-ui.test.ts).
function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function buildTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team One', emoji: '🚀',
    stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

function setup(team: Team): { shell: Shell; store: Store; input: HTMLInputElement } {
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('milestones', renderMilestones)
  mountSearch(shell, store, pm, () => {}, pm.searchIndex)
  const input = shell.headerLeft.querySelector('.tt-search-input') as HTMLInputElement
  return { shell, store, input }
}

/** Runs a search, captures the requestAnimationFrame callback commit() schedules (without letting it fire yet), and clicks the first result. Returns the captured callback so the test can inspect DOM state *before* the highlight/expand pass runs, then invoke it.
 *
 * The rAF stub is installed *after* `vi.useRealTimers()` rather than before
 * `vi.advanceTimersByTime()`: vitest's fake-timers implementation marks the
 * global it fakes with an internal `hadOwnProperty` flag it consults on
 * restore; overwriting `window.requestAnimationFrame` with our own stub
 * while fake timers are still installed replaces that marked value, so
 * `useRealTimers()` sees an unmarked function and `delete`s the global
 * instead of restoring it — leaving `requestAnimationFrame` undefined for
 * the rest of the test. Installing the stub only once real timers are back
 * avoids that clobber; nothing before this point calls
 * `requestAnimationFrame` (only `commit()`, triggered below, does). */
function search(input: HTMLInputElement, query: string): FrameRequestCallback {
  vi.useFakeTimers()
  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true }))
  vi.advanceTimersByTime(350) // past the 300ms debounce
  vi.useRealTimers()

  let raf: FrameRequestCallback | null = null
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { raf = cb; return 0 }) as typeof window.requestAnimationFrame

  const row = document.querySelector('.tt-search-row') as HTMLElement
  if (!row) throw new Error(`no search result for "${query}"`)
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  if (!raf) throw new Error('commit() did not schedule a requestAnimationFrame callback')
  return raf
}

// Captured once so afterEach can restore them — search() and the tests below
// overwrite window.requestAnimationFrame / Element.prototype.scrollIntoView
// (jsdom implements neither), and without restoring them the stubs would
// leak into whichever test file runs next in the same worker.
const originalRAF = window.requestAnimationFrame
const originalScrollIntoView = Element.prototype.scrollIntoView

afterEach(() => {
  document.body.innerHTML = ''
  window.requestAnimationFrame = originalRAF
  Element.prototype.scrollIntoView = originalScrollIntoView
})

test('a search result matching only a milestone\'s follow-up text expands that row and scrolls to it', () => {
  const team = buildTeam({ milestones: [{ id: 'm1', date: '2026-01-01', title: 'Kickoff', done: false, followup: 'buried-unique-term' }] })
  const { store, input } = setup(team)

  const raf = search(input, 'buried-unique-term')

  // Before the deferred highlight pass runs, the row is still collapsed —
  // the search-focus-item dispatch (and the resulting expand) happens inside it.
  expect(document.querySelector('.tt-milestone-followup-row')).toBeNull()

  // jsdom implements no scrollIntoView at all, and milestones.ts's
  // onSearchFocusItem listener calls renderAll() (a full list rebuild) before
  // the anchor lookup in search-ui.ts's commit() runs — so the element that
  // ends up as the scroll target is a freshly-built node, not the one
  // currently in the DOM. Spy at the prototype level rather than on this
  // stale instance so whichever node the rebuild produces is covered.
  // vi.spyOn requires the property to already exist, so define a no-op first.
  Element.prototype.scrollIntoView = () => {}
  const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})

  raf(0)

  const editorEl = document.querySelector('.tt-milestone-followup-row .editor') as HTMLElement
  expect(editorEl).not.toBeNull()
  expect(editorEl.textContent).toContain('buried-unique-term')
  expect(store.doc.nav.focusedPane).toBe(0)

  // commit()'s anchors are resolved via querySelectorAll *after* the expand
  // happens, and the title row precedes the follow-up row in document order
  // (renderList()'s append order in milestones.ts) — so it's anchors[0], the
  // correct scroll target. Query fresh (post-raf) rather than reusing any
  // earlier reference, since the rebuild replaces the node. Vitest tracks the
  // `this` binding per call in mock.contexts, index-aligned with mock.calls.
  expect(scrollSpy).toHaveBeenCalledTimes(1)
  const anchor = document.querySelector('[data-item-id="m1"]')
  expect(anchor).not.toBeNull()
  expect(scrollSpy.mock.contexts[0]).toBe(anchor)
})

test('a search result matching only an action item\'s notes (modal-only field) still scrolls the card into view (regression: previously did nothing — no scroll, no focus, no highlight)', () => {
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  doc.teams.push(buildTeam({
    actionItems: [{
      id: 'a1', summary: 'Ship v2', notes: 'blocked-on-xyz-vendor',
      status: 'todo', dueDate: null, assignee: '', color: 'slate', order: 0,
    }],
  }))
  doc.nav.activeTeamId = 'T1'
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('actions', renderActionItems)
  mountSearch(shell, store, pm, () => {}, pm.searchIndex)
  const input = shell.headerLeft.querySelector('.tt-search-input') as HTMLInputElement

  const raf = search(input, 'blocked-on-xyz-vendor')

  const card = document.querySelector('[data-item-id="a1"]') as HTMLElement
  expect(card).not.toBeNull()
  card.scrollIntoView = vi.fn()

  raf(0)

  expect(card.scrollIntoView).toHaveBeenCalled()
})
