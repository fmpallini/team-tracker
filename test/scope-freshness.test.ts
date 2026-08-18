// test/scope-freshness.test.ts — ties each module's ChangeScope to what other
// panes actually READ, which is the invariant the whole scoped-update design
// rests on and the one nothing else in the suite constrains.
//
// Two failure modes live here, and neither is visible to a test that only
// inspects freshly-rendered DOM:
//
//  1. A *write* scoped too narrowly. `@[Label](kind:id)` mentions do not render
//     from the label stored in the markdown — ui/atref.ts's
//     makeRefLabelResolver reads the store live at render time — so renaming an
//     item changes how it is displayed in every pane that mentions it, not just
//     the pane that owns it. Same for deletes, which call unlinkRefsInTeam()
//     across every content section.
//  2. A *WATCHED* list missing a section its render path reads. The subscriber
//     then filters out an update it needed, and the pane paints stale data
//     until something unrelated forces it to re-render.
//
// Every test here drives the real module UI end to end rather than calling
// store.update() by hand, so re-narrowing a call site or trimming a WATCHED
// list is caught at the place the mistake would actually be made.
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createShell, type Shell } from '../src/ui/shell'
import { createPaneManager, type PaneManager } from '../src/ui/panes'
import { renderActionItems } from '../src/modules/action-items'
import { renderDailyNotes } from '../src/modules/daily-notes'
import { renderMilestones } from '../src/modules/milestones'
import { renderRisks } from '../src/modules/risks'
import { renderPeopleTree } from '../src/modules/people-tree'
import { todayIso } from '../src/core/i18n'
import type { Loc, Team } from '../src/core/types'

function stubMatchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom has no layout engine, so Element.prototype.scrollIntoView doesn't
// exist — clicking a ref chip (ui/atref.ts's navigateToLoc) schedules a
// requestAnimationFrame callback that calls it to bring the navigated-to
// item into view. Without this stub that callback throws once the frame
// fires, after the test itself has already finished (mirrors the same stub
// in test/atref.test.ts and test/sidebar.test.ts).
Element.prototype.scrollIntoView ??= () => {}

function seededTeam(): Team {
  return {
    id: 't1', name: 'Alpha', emoji: '🚀',
    stakeholders: [],
    members: [{ id: 'p1', name: 'Alice', role: 'Dev', parentId: null, order: 0, notes: '' }],
    actionItems: [{
      id: 'a1', summary: 'Card', notes: '', status: 'todo',
      dueDate: null, assignee: '', color: 'ledger', order: 0,
    }],
    milestones: [{ id: 'm1', date: todayIso(), title: 'Launch', done: false, followup: '' }],
    risks: [{ id: 'r1', title: 'Slippage', chance: 2, impact: 2, plan: 'mitigate', followup: '', order: 0, closed: false }],
    dailyNotes: {},
  }
}

/**
 * Builds a real shell + PaneManager with every module registered, seeds one
 * team, and opens `left` in pane 0 and `right` in pane 1 with split on — the
 * arrangement in which a cross-pane staleness bug is observable at all.
 */
function setup(left: Loc['ref'], right: Loc['ref'], mutate?: (t: Team) => void): { store: Store; shell: Shell; pm: PaneManager } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const store = createStore(createEmptyDocument('en-US'))
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const pm = createPaneManager(shell, store, 'en-US')
  pm.registerModule('actions', renderActionItems)
  pm.registerModule('daily', renderDailyNotes)
  pm.registerModule('milestones', renderMilestones)
  pm.registerModule('risks', renderRisks)
  pm.registerModule('members', renderPeopleTree('members'))

  store.update((d) => {
    const team = seededTeam()
    mutate?.(team)
    d.teams.push(team)
    d.nav.activeTeamId = team.id
  })
  store.updateNav((d) => { d.nav.split = true })
  pm.openBothPanes({ teamId: 't1', ref: left }, { teamId: 't1', ref: right }, 0)
  return { store, shell, pm }
}

function panes(): [HTMLElement, HTMLElement] {
  const bodies = document.querySelectorAll<HTMLElement>('.tt-pane-body')
  return [bodies[0]!, bodies[1]!]
}

/** Expands every follow-up editor in a pane so its rendered markdown (and therefore its live-resolved mention labels) is in the DOM. */
function expandFollowups(pane: HTMLElement): void {
  pane.querySelectorAll<HTMLButtonElement>('.tt-milestone-expand-btn, .tt-risk-expand-btn')
    .forEach((b) => b.click())
}

function refChip(scope: ParentNode, ref: string): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`a.ref[data-ref="${ref}"]`)
}

function clickButtonLabelled(scope: ParentNode, label: string): void {
  const btn = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => b.textContent === label || b.title === label)
  if (!btn) throw new Error(`no button labelled/titled "${label}"`)
  btn.click()
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Renames must refresh mention labels in a pane belonging to another section.
// ---------------------------------------------------------------------------

test('renaming a person refreshes its mention label in the milestones pane', () => {
  setup({ kind: 'members' }, { kind: 'milestones' }, (t) => {
    t.milestones[0]!.followup = 'ping @[Alice](person:p1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'person:p1')?.textContent).toBe('@Alice')

  // Real UI path: the box's edit button opens the person modal; OK fires the
  // rename call site.
  clickButtonLabelled(left, 'Edit person')
  const nameInput = document.querySelector<HTMLInputElement>('input[name="tt-person-name"]')!
  nameInput.value = 'Alicia'
  clickButtonLabelled(document, 'OK')

  expect(refChip(panes()[1], 'person:p1')?.textContent).toBe('@Alicia')
})

test('editing an action item summary refreshes its mention label in the milestones pane', () => {
  setup({ kind: 'actions' }, { kind: 'milestones' }, (t) => {
    t.milestones[0]!.followup = 'see @[Card](action:a1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'action:a1')?.textContent).toBe('@Card')

  const card = left.querySelector<HTMLElement>('.tt-kanban-card')!
  card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const summaryInput = document.querySelector<HTMLInputElement>('.tt-modal-overlay input.tt-input')!
  setInputValue(summaryInput, 'Renamed card') // commits on change/blur now — no Save button anymore

  expect(refChip(panes()[1], 'action:a1')?.textContent).toBe('@Renamed card')
})

test('renaming a milestone refreshes its mention label in the risks pane', () => {
  setup({ kind: 'milestones' }, { kind: 'risks' }, (t) => {
    t.risks[0]!.followup = 'blocks @[Launch](milestone:m1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'milestone:m1')?.textContent).toBe('@Launch')

  setInputValue(left.querySelector<HTMLInputElement>('.tt-milestone-title-input')!, 'Relaunch')

  expect(refChip(panes()[1], 'milestone:m1')?.textContent).toBe('@Relaunch')
})

test('renaming a risk refreshes its mention label in the milestones pane', () => {
  setup({ kind: 'risks' }, { kind: 'milestones' }, (t) => {
    t.milestones[0]!.followup = 'watch @[Slippage](risk:r1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'risk:r1')?.textContent).toBe('@Slippage')

  setInputValue(left.querySelector<HTMLInputElement>('.tt-risk-title-input')!, 'Schedule slip')

  expect(refChip(panes()[1], 'milestone:m1')).toBeNull() // sanity: only the risk is mentioned
  expect(refChip(panes()[1], 'risk:r1')?.textContent).toBe('@Schedule slip')
})

// ---------------------------------------------------------------------------
// Deletes call unlinkRefsInTeam(), which strips mention markup across EVERY
// content section — so every delete site must stay scoped to { teamId } with no
// `sections`. test/render-counts.test.ts pins the action-items removeItem site;
// these cover the remaining four.
// ---------------------------------------------------------------------------

test('deleting a person clears its mention chip in the milestones pane', () => {
  setup({ kind: 'members' }, { kind: 'milestones' }, (t) => {
    t.milestones[0]!.followup = 'ping @[Alice](person:p1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'person:p1')).not.toBeNull()

  clickButtonLabelled(left, 'Delete person')
  clickButtonLabelled(document.querySelector('.tt-modal-overlay')!, 'Delete')

  expect(refChip(panes()[1], 'person:p1')).toBeNull()
})

test("clearing a kanban zone clears its cards' mention chips in the milestones pane", () => {
  setup({ kind: 'actions' }, { kind: 'milestones' }, (t) => {
    t.actionItems[0]!.status = 'done'
    t.milestones[0]!.followup = 'see @[Card](action:a1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'action:a1')).not.toBeNull()

  // The 🗑 button on the done zone's label — clearZone('done'), the fifth and
  // last unlinkRefsInTeam() call site.
  clickButtonLabelled(left, 'Clear cards')
  clickButtonLabelled(document.querySelector('.tt-modal-overlay')!, 'Delete all')

  expect(refChip(panes()[1], 'action:a1')).toBeNull()
})

test('deleting a milestone clears its mention chip in the risks pane', () => {
  setup({ kind: 'milestones' }, { kind: 'risks' }, (t) => {
    t.risks[0]!.followup = 'blocks @[Launch](milestone:m1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'milestone:m1')).not.toBeNull()

  clickButtonLabelled(left, 'Delete milestone')
  clickButtonLabelled(document.querySelector('.tt-modal-overlay')!, 'Delete')

  expect(refChip(panes()[1], 'milestone:m1')).toBeNull()
})

test('deleting a risk clears its mention chip in the milestones pane', () => {
  setup({ kind: 'risks' }, { kind: 'milestones' }, (t) => {
    t.milestones[0]!.followup = 'watch @[Slippage](risk:r1)'
  })
  const [left, right] = panes()
  expandFollowups(right)
  expect(refChip(right, 'risk:r1')).not.toBeNull()

  clickButtonLabelled(left, 'Delete risk')
  clickButtonLabelled(document.querySelector('.tt-modal-overlay')!, 'Delete')

  expect(refChip(panes()[1], 'risk:r1')).toBeNull()
})

// ---------------------------------------------------------------------------
// WATCHED lists must cover every section their render path reads — not just the
// section the module "owns".
// ---------------------------------------------------------------------------

test("the action-items assignee datalist picks up a person added from another pane (WATCHED needs 'people')", () => {
  setup({ kind: 'members' }, { kind: 'actions' })
  const [left] = panes()
  const options = (): string[] =>
    Array.from(panes()[1].querySelectorAll<HTMLOptionElement>('datalist option')).map((o) => o.value)
  expect(options()).toEqual(['Alice'])

  // Adding a person is scoped { teamId, sections: ['people'] } — correctly so,
  // since nothing else stores a person's name. The kanban still reads people
  // for its assignee autocomplete, which is why 'people' is in its WATCHED.
  clickButtonLabelled(left, '+ Person')
  document.querySelector<HTMLInputElement>('input[name="tt-person-name"]')!.value = 'Bruno'
  clickButtonLabelled(document, 'OK')

  expect(options()).toEqual(['Alice', 'Bruno'])
})

test("the daily-notes calendar picks up a milestone added from another pane (WATCHED needs 'milestones')", () => {
  // Seed the team with no milestones at all, so today's cell starts unflagged.
  setup({ kind: 'milestones' }, { kind: 'daily', date: todayIso() }, (t) => { t.milestones = [] })
  const todayFlag = (): Element | null =>
    panes()[1].querySelector('.tt-calendar-day-today .tt-calendar-flag')
  expect(todayFlag()).toBeNull()

  // Adding a milestone is scoped { teamId, sections: ['milestones'] } and dates
  // it today; the calendar's markers read team.milestones, which is why
  // 'milestones' is in daily-notes' WATCHED.
  clickButtonLabelled(panes()[0], '+ Milestone')

  expect(todayFlag()).not.toBeNull()
})

// NOTE on daily-notes' remaining WATCHED entry, 'actions': the calendar reads
// actionItems[].dueDate, but every write that can change a due date now goes
// through the card modal's save(), which is scoped { teamId } (it also writes
// `summary`, the label mentions resolve through). So 'actions' is currently
// defensive rather than load-bearing, and there is no interaction that would
// falsify removing it. Left in place: it costs one redundant render and
// re-narrowing that call site later would silently need it back.

// ---------------------------------------------------------------------------
// Navigating one pane must not remount the other one's body — ui/panes.ts's
// openInPane() used to call a blanket renderAll() after every navigation,
// which tore down and rebuilt *both* panes' module instances even though
// only one of them actually navigated. In milestones/risks that meant an
// expanded follow-up row (local UI state, not persisted) silently collapsed
// the moment a ref chip inside it navigated the *other* pane — reproduced by
// clicking a mention that opens in the secondary pane from inside an
// expanded row's own editor.
// ---------------------------------------------------------------------------

test('clicking an @mention chip that opens in the secondary pane does not collapse the expanded follow-up row it was clicked from', () => {
  const { store } = setup({ kind: 'risks' }, { kind: 'milestones' }, (t) => {
    t.risks[0]!.followup = 'blocks @[Launch](milestone:m1)'
  })
  store.update((d) => { d.prefs.openRefsInSecondaryPane = true })

  const left = panes()[0]
  expandFollowups(left)
  expect(left.querySelector('.tt-risk-followup-row')).not.toBeNull()

  const chip = refChip(left, 'milestone:m1')!
  chip.click()

  // Navigated the *other* pane to the milestone...
  expect(panes()[1].querySelector('.tt-milestone-row')).not.toBeNull()
  // ...while the risk pane clicked from is still showing, and its follow-up
  // row is still expanded — same instance, not silently torn down and
  // rebuilt from scratch.
  expect(panes()[0].querySelector('.tt-risk-followup-row')).not.toBeNull()
})

test('clicking an @mention chip that opens in the secondary pane does not collapse an expanded follow-up row in the milestones pane either', () => {
  const { store } = setup({ kind: 'milestones' }, { kind: 'risks' }, (t) => {
    t.milestones[0]!.followup = 'blocked by @[Slippage](risk:r1)'
  })
  store.update((d) => { d.prefs.openRefsInSecondaryPane = true })

  const left = panes()[0]
  expandFollowups(left)
  expect(left.querySelector('.tt-milestone-followup-row')).not.toBeNull()

  const chip = refChip(left, 'risk:r1')!
  chip.click()

  expect(panes()[1].querySelector('.tt-risk-row')).not.toBeNull()
  expect(panes()[0].querySelector('.tt-milestone-followup-row')).not.toBeNull()
})
