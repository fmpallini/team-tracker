import { mountSearch } from '../src/ui/search-ui'
import { createShell, type Shell } from '../src/ui/shell'
import { createPaneManager } from '../src/ui/panes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { renderMilestones } from '../src/modules/milestones'
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
  mountSearch(shell, store, pm, () => {})
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
  vi.advanceTimersByTime(200) // past the 150ms debounce
  vi.useRealTimers()

  let raf: FrameRequestCallback | null = null
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { raf = cb; return 0 }) as typeof window.requestAnimationFrame

  const row = document.querySelector('.tt-search-row') as HTMLElement
  if (!row) throw new Error(`no search result for "${query}"`)
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

  if (!raf) throw new Error('commit() did not schedule a requestAnimationFrame callback')
  return raf
}

afterEach(() => {
  document.body.innerHTML = ''
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
  // currently in the DOM. Stub at the prototype level rather than on this
  // stale instance so whichever node the rebuild produces is covered.
  Element.prototype.scrollIntoView = vi.fn()

  raf(0)

  const editorEl = document.querySelector('.tt-milestone-followup-row .editor') as HTMLElement
  expect(editorEl).not.toBeNull()
  expect(editorEl.textContent).toContain('buried-unique-term')
  expect(store.doc.nav.focusedPane).toBe(0)
})
