import type { Mock } from 'vitest'
import { revealLoc } from '../src/ui/reveal-loc'
import { showModal, type ModalHandle } from '../src/ui/modal'
import { SEARCH_FOCUS_ITEM_EVENT } from '../src/ui/search-highlight'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Loc } from '../src/core/types'

let frames: FrameRequestCallback[] = []
const originalRAF = window.requestAnimationFrame
let card: { handle: ModalHandle; allow: () => void } | null = null

beforeEach(() => {
  frames = []
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { frames.push(cb); return frames.length }) as typeof window.requestAnimationFrame
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  window.requestAnimationFrame = originalRAF
  // Never leave a modal (and its document keydown listener) behind for the next test.
  card?.allow()
  card?.handle.close()
  card = null
  document.body.innerHTML = ''
})

function setup(): { store: Store; deps: { store: Store; pm: { openInFocused: Mock<(loc: Loc) => void> }; selectTeam: Mock<(teamId: string) => void> } } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(createEmptyTeam('A', 'Alpha', '', 'en-US'), createEmptyTeam('B', 'Beta', '', 'en-US'))
  doc.nav.activeTeamId = 'A'
  const store = createStore(doc)
  return { store, deps: { store, pm: { openInFocused: vi.fn<(loc: Loc) => void>() }, selectTeam: vi.fn<(teamId: string) => void>() } }
}

/** A modeless card modal, like action-items.ts's; `refuse` makes its required-name guard veto closing. */
function openCard(refuse: boolean): void {
  let blocked = refuse
  const handle = showModal({ title: 'card', body: document.createElement('div'), buttons: [], modeless: true, beforeClose: () => !blocked })
  card = { handle, allow: () => { blocked = false } }
}

const riskLoc: Loc = { teamId: 'B', ref: { kind: 'risks', itemId: 'r1' } }

test('a location on another team: switches team first, then opens it in the focused pane', () => {
  const { deps } = setup()
  expect(revealLoc(deps, riskLoc)).toBe(true)
  expect(deps.selectTeam).toHaveBeenCalledWith('B')
  expect(deps.pm.openInFocused).toHaveBeenCalledWith(riskLoc)
  expect(deps.selectTeam.mock.invocationCallOrder[0]!).toBeLessThan(deps.pm.openInFocused.mock.invocationCallOrder[0]!)
})

test('a location on the active team: does not switch team', () => {
  const { deps } = setup()
  revealLoc(deps, { teamId: 'A', ref: { kind: 'general' } })
  expect(deps.selectTeam).not.toHaveBeenCalled()
  expect(deps.pm.openInFocused).toHaveBeenCalledWith({ teamId: 'A', ref: { kind: 'general' } })
})

test('closes an open card first', () => {
  const { deps } = setup()
  openCard(false)
  expect(revealLoc(deps, riskLoc)).toBe(true)
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})

test('a card that refuses to close aborts everything and returns false', () => {
  const { deps } = setup()
  openCard(true)
  expect(revealLoc(deps, riskLoc)).toBe(false)
  expect(deps.selectTeam).not.toHaveBeenCalled()
  expect(deps.pm.openInFocused).not.toHaveBeenCalled()
  expect(frames).toHaveLength(0)
})

test('with an itemId, flashes that item in the focused pane on the next frame', () => {
  const { store, deps } = setup()
  store.updateNav((d) => { d.nav.focusedPane = 1 })
  document.body.innerHTML = '<div class="tt-pane-body"></div><div class="tt-pane-body"><div data-item-id="r1" tabindex="0">r</div></div>'
  const seen: string[] = []
  document.querySelectorAll('.tt-pane-body')[1]!.addEventListener(SEARCH_FOCUS_ITEM_EVENT, (e) => seen.push((e as CustomEvent<string>).detail))

  revealLoc(deps, riskLoc)
  frames.forEach((f) => f(0))

  expect(seen).toEqual(['r1'])
  expect(document.querySelector('[data-item-id="r1"]')!.classList.contains('tt-search-target-flash')).toBe(true)
})

test('no itemId and no terms: schedules nothing', () => {
  const { deps } = setup()
  revealLoc(deps, { teamId: 'A', ref: { kind: 'general' } })
  expect(frames).toHaveLength(0)
})
