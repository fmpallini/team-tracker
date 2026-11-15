import { renderPersonNotes } from '../src/modules/person-notes'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import { NEW_ONE_ON_ONE_EVENT, requestNewOneOnOne, type PaneManager, type ModuleCtx } from '../src/ui/panes'
import type { Loc, Person, Team } from '../src/core/types'
import { todayIso } from '../src/core/i18n'
import { addDaysIso } from '../src/core/date'
import { setEditorsReadOnly } from '../src/ui/editor'
import { disposeContainer } from '../src/modules/lifecycle'

function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc; secondary?: boolean }[] } {
  const calls: { idx: 0 | 1; loc: Loc; secondary?: boolean }[] = []
  return {
    calls,
    openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
    openBothPanes: () => {},
    openInFocused: () => {},
    openInSecondaryPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc, secondary: true }); return idx === 0 ? 1 : 0 },
    toggleSplit: () => {},
    renderAll: () => {},
    registerModule: () => {},
    setSplitSpaceConstrained: () => {},
    dispose: () => {},
  }
}

function headerTitle(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.tt-person-header-title')
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

function setup(team: Team): { container: HTMLElement; store: Store; pm: ReturnType<typeof fakePM> } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const pm = fakePM()
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { container, store, pm }
}

function render(container: HTMLElement, loc: Loc, store: Store, pm: PaneManager, paneIdx: 0 | 1 = 0): void {
  const searchIndex = createSearchIndex(() => store.doc, () => store.rev)
  const ctx: ModuleCtx = { store, pm, paneIdx, locale: 'en-US', searchIndex, saveStatus: { requestPillAction: () => {}, subscribeSaveState: () => () => {} } }
  renderPersonNotes(container, loc, ctx)
}

function editorEl(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.editor')
  if (!found) throw new Error('.editor not found')
  return found
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

function offeredTemplates(editor: HTMLElement): string[] {
  setBlockText(editor, '/')
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  return Array.from(document.querySelectorAll('.tt-atref-item')).map((n) => n.textContent ?? '')
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('renderPersonNotes', () => {
  test('renders the name and a "role · classification" secondary line, and loads existing notes into the editor', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '## Hi Bruno' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    expect(headerTitle(container)?.textContent).toBe('Dev · Team member')
    // Name lives only in the pane bar — the header must not repeat it.
    expect(container.querySelector('.tt-person-header')?.textContent).not.toContain('Bruno')
    expect(container.querySelector('.editor h2')?.textContent).toBe('Hi Bruno')
  })

  test('the secondary line shows the classification alone when role is empty', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)
    expect(headerTitle(container)?.textContent).toBe('Team member')
  })

  test('the secondary line reads "Stakeholder" for a stakeholder', () => {
    const team = makeTeam({ stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)
    expect(headerTitle(container)?.textContent).toBe('Sponsor · Stakeholder')
  })

  test('the edit button opens the shared person modal prefilled, and a submit updates name + role and refreshes the header', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    container.querySelector<HTMLButtonElement>('.tt-person-header-edit-btn')!.click()
    const nameInput = document.querySelector<HTMLInputElement>('input[name="tt-person-name"]')!
    const roleInput = document.querySelector<HTMLInputElement>('input[name="tt-person-role"]')!
    expect(nameInput.value).toBe('Bruno')
    expect(roleInput.value).toBe('Dev')

    nameInput.value = 'Bruna'
    roleInput.value = 'Lead'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-buttons button')).find((b) => b.textContent === 'Save')!.click()

    expect(store.doc.teams[0]!.members[0]!.name).toBe('Bruna')
    expect(store.doc.teams[0]!.members[0]!.role).toBe('Lead')
    expect(headerTitle(container)?.textContent).toBe('Lead · Team member')
  })

  test('the edit button submit is scoped to the team only (no sections), so @mention labels stay live', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: '' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    const seen: unknown[] = []
    store.subscribe((scope) => seen.push(scope))

    container.querySelector<HTMLButtonElement>('.tt-person-header-edit-btn')!.click()
    ;(document.querySelector<HTMLInputElement>('input[name="tt-person-name"]')!).value = 'Bruna'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-modal-buttons button')).find((b) => b.textContent === 'Save')!.click()

    expect(seen).toEqual([{ teamId: 'T1' }])
  })

  test('the jump-to-org-chart button opens this person\'s group in the same pane', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    container.querySelector<HTMLButtonElement>('.tt-person-header-goto-org-btn')!.click()
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'members' } } }])
  })

  test('the jump-to-org-chart button honors prefs.openRefsInSecondaryPane', () => {
    const team = makeTeam({ stakeholders: [{ id: 'stk-1', name: 'Carla', role: 'Sponsor', parentId: null, order: 0, notes: '' }] })
    const { container, store, pm } = setup(team)
    store.update((d) => { d.prefs.openRefsInSecondaryPane = true })
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)

    container.querySelector<HTMLButtonElement>('.tt-person-header-goto-org-btn')!.click()
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'stakeholders' } }, secondary: true }])
  })

  test('onChange persists the edited markdown into person.notes', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), 'New notes')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.members[0]!.notes).toBe('New notes')
  })

  test('onChange scopes its store update to { teamId, sections: ["notes"] } — not "people", so the org tree is not rebuilt', () => {
    vi.useFakeTimers()
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    const seen: unknown[] = []
    store.subscribe((scope) => seen.push(scope))

    setBlockText(editorEl(container), 'New notes')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(seen).toEqual([{ teamId: 'T1', sections: ['notes'] }])
  })

  test('clearing the notes (whitespace-only) persists an empty string', () => {
    vi.useFakeTimers()
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: 'existing' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    setBlockText(editorEl(container), '   ')
    fireInput(editorEl(container))
    vi.advanceTimersByTime(400)

    expect(store.doc.teams[0]!.members[0]!.notes).toBe('')
  })

  test('shows a "person not found" placeholder (no crash) when the personId does not exist', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'ghost', group: 'members' } }
    expect(() => render(container, loc, store, pm)).not.toThrow()

    expect(container.querySelector('.editor')).toBeNull()
    expect(container.textContent).toBe('Person not found')
  })

  test('degrades to the "person not found" placeholder if the person is deleted while the pane is open', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.editor')).not.toBeNull()

    store.update((d) => {
      d.teams[0]!.members = d.teams[0]!.members.filter((p) => p.id !== 'mem-1')
    })

    expect(container.querySelector('.editor')).toBeNull()
    expect(container.textContent).toBe('Person not found')
  })

  // Regression: the header used to be painted once at mount and never
  // refreshed by the pane's own subscribe callback (which only rebuilt the
  // backlinks chip) — renaming the person from another pane (e.g. the
  // people-tree edit modal) left this pane showing the stale name
  // indefinitely, breaking the "labels always resolve live" guarantee every
  // other module in the app honors.
  test('the header picks up a rename made from elsewhere while the pane is open', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)
    expect(headerTitle(container)?.textContent).toBe('Dev · Team member')

    store.update((d) => {
      const p = d.teams[0]!.members.find((m) => m.id === 'mem-1')!
      p.name = 'Bruna'
      p.role = 'Lead'
    })

    expect(headerTitle(container)?.textContent).toBe('Lead · Team member')
  })

  test('double render into the same container disposes the previous instance: no duplicate @ dropdowns', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '@')
    fireInput(editorEl(container))

    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)
  })

  test('double render into the same container disposes the previous instance: no duplicate template pickers', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

    render(container, loc, store, pm)
    setBlockText(editorEl(container), '/')
    fireInput(editorEl(container))
    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)

    container.innerHTML = ''
    render(container, loc, store, pm)
    setBlockText(editorEl(container), '/')
    fireInput(editorEl(container))

    expect(document.querySelectorAll('.tt-atref-dropdown')).toHaveLength(1)
  })

  // Not a leak test: a leaked listener re-renders into detached DOM, so it is
  // invisible from here. See test/lifecycle.test.ts for the subscription-count
  // test that actually catches a dropped unsubscribe().
  test('double render leaves the live container intact under a subsequent store mutation', () => {
    const team = makeTeam()
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

    render(container, loc, store, pm)
    container.innerHTML = ''
    render(container, loc, store, pm)

    expect(() => store.update((d) => { d.teams[0]!.dailyNotes['2026-07-11'] = 'x' })).not.toThrow()
    expect(container.querySelector('.editor')).not.toBeNull()
  })

  test('clicking a ref chip navigates via makeRefClickHandler using the pane it was mounted in', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '@[Carla](person:stk-1) ' }] })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm, 1)

    const chip = container.querySelector<HTMLAnchorElement>('a.ref')!
    chip.click()

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
  })

  test('a backlink chip renders in the header when another field mentions this person', () => {
    const team = makeTeam()
    team.actionItems.push({ id: 'a1', summary: 'Ship it', status: 'todo', color: 'ledger', dueDate: null, assignee: '', order: 0, notes: 'Blocked on @[Carla](person:stk-1)' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
  })

  test('a backlink chip renders when an action item\'s (reference-linked) assignee mentions this person', () => {
    const team = makeTeam()
    team.actionItems.push({ id: 'a1', summary: 'Ship it', status: 'todo', color: 'ledger', dueDate: null, assignee: '@[Carla](person:stk-1)', order: 0, notes: '' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
  })

  test('no chip when nothing mentions this person', () => {
    const { container, store, pm } = setup(makeTeam())
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }
    render(container, loc, store, pm)
    expect(container.querySelector('.tt-backlinks-chip')).toBeNull()
  })

  test('renaming an action item mentioned in these notes live-updates its @mention chip, without disturbing the rest of the editor', () => {
    const team = makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes: 'Follow up on @[Old Title](action:a1) soon' }] })
    team.actionItems.push({ id: 'a1', summary: 'Old Title', status: 'todo', color: null, dueDate: null, assignee: '', order: 0, notes: '' })
    const { container, store, pm } = setup(team)
    const loc: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }
    render(container, loc, store, pm)

    const chip = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:a1"]')!
    expect(chip.textContent).toBe('@Old Title')

    store.update((d) => {
      d.teams[0]!.actionItems.find((i) => i.id === 'a1')!.summary = 'New Title'
    }, { teamId: 'T1', sections: ['actions'] })

    const chipAfter = container.querySelector<HTMLAnchorElement>('a.ref[data-ref="action:a1"]')!
    expect(chipAfter.textContent).toBe('@New Title')
    // Same DOM node patched in place, not a full re-render — a live caret
    // elsewhere in these notes would have survived untouched.
    expect(chipAfter).toBe(chip)
    expect(editorEl(container).textContent).toBe('Follow up on @New Title soon')
  })
})

const PERSON_LOC: Loc = { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }

test('the notes editor offers the "personal" and "any" templates', () => {
  const { container, store, pm } = setup(makeTeam())
  render(container, PERSON_LOC, store, pm)
  expect(offeredTemplates(editorEl(container))).toEqual(store.doc.templates.filter((tpl) => tpl.scope === 'personal' || tpl.scope === 'any').map((tpl) => tpl.name))
})

test('a template\'s {person} uses the person\'s current name after a rename', () => {
  vi.useFakeTimers()
  const { container, store, pm } = setup(makeTeam())
  store.update((d) => { d.templates.push({ id: 'greet', name: 'Greet', scope: 'personal', body: 'Hi {person}' }) })
  render(container, PERSON_LOC, store, pm)
  // Replaces the record (as an undo or a reload would) so a captured reference goes stale.
  store.update((d) => { d.teams[0]!.members[0] = { ...d.teams[0]!.members[0]!, name: 'Bia' } }, { teamId: 'T1' })

  offeredTemplates(editorEl(container))
  Array.from(document.querySelectorAll<HTMLElement>('.tt-atref-item')).find((n) => n.textContent === 'Greet')!.click()
  vi.advanceTimersByTime(500)

  expect(store.doc.teams[0]!.members[0]!.notes).toContain('Hi Bia')
  vi.useRealTimers()
})

test('opening a person lands the caret in their notes, like the other note modules', () => {
  const { container, store, pm } = setup(makeTeam())
  const person = store.doc.teams[0]!.members[0]!
  render(container, { teamId: 'T1', ref: { kind: 'person', group: 'members', personId: person.id } } as Loc, store, pm)
  expect(document.activeElement).toBe(editorEl(container))
})

test('only in the focused pane, so a team switch mounting both panes cannot steal focus', () => {
  const { container, store, pm } = setup(makeTeam())
  const person = store.doc.teams[0]!.members[0]!
  render(container, { teamId: 'T1', ref: { kind: 'person', group: 'members', personId: person.id } } as Loc, store, pm, 1)
  expect(document.activeElement).not.toBe(editorEl(container))
})

test('Escape leaves the notes for the pane bar', () => {
  const { container, store, pm } = setup(makeTeam())
  const pane = document.createElement('div')
  pane.className = 'tt-pane'
  const bar = document.createElement('div')
  bar.className = 'tt-pane-bar'
  const tab = document.createElement('button')
  tab.className = 'tt-pane-tab'
  tab.setAttribute('tabindex', '0')
  bar.appendChild(tab)
  pane.append(bar, container)
  document.body.appendChild(pane)
  render(container, { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } }, store, pm)
  editorEl(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(tab)
})

describe('New 1:1', () => {
  // replaceMd scrolls the caret's block into view; jsdom has no scrollIntoView.
  const originalScrollIntoView = Element.prototype.scrollIntoView
  beforeEach(() => { Element.prototype.scrollIntoView = () => {} })
  afterEach(() => { Element.prototype.scrollIntoView = originalScrollIntoView })

  function withNotes(notes: string): Team {
    return makeTeam({ members: [{ id: 'mem-1', name: 'Bruno', role: 'Dev', parentId: null, order: 0, notes }] })
  }
  const member = (store: Store): Person => store.doc.teams[0]!.members[0]!
  const line = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.tt-person-cadence')!
  const clickNew = (container: HTMLElement): void => container.querySelector<HTMLButtonElement>('.tt-person-header-one-on-one-btn')!.click()

  test('New 1:1 appends the block, marks carried, records today, one undo step', async () => {
    vi.useFakeTimers()
    const { container, store, pm } = setup(withNotes('- [ ] a'))
    render(container, PERSON_LOC, store, pm)

    clickNew(container)
    expect(member(store).lastOneOnOne).toBe(todayIso())
    vi.advanceTimersByTime(1000)
    expect(member(store).notes).toContain('- [>] a\n---\n## 1:1')
    expect(member(store).notes).toContain('### Carried over\n- [ ] a')
    // The caret lands in the template's first empty bullet, not on a carried item.
    const start = window.getSelection()!.getRangeAt(0).startContainer
    const li = (start instanceof Element ? start : start.parentElement)!.closest('li')!
    expect(li.textContent?.trim()).toBe('')
    expect(li.getAttribute('data-task')).not.toBe('carried')
    expect(li.closest('ul')!.previousElementSibling?.textContent).toBe('How are they / energy')

    await Promise.resolve() // the replace's undo step closes at the end of its task
    editorEl(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }))
    vi.advanceTimersByTime(1000)
    expect(member(store).notes).toBe('- [ ] a')
    expect(member(store).lastOneOnOne).toBe(todayIso())
  })

  test('the caret skips an empty bullet of an earlier 1:1 and counts past the block\'s own rules', () => {
    const { container, store, pm } = setup(withNotes('Old\n- \n---\nx'))
    store.update((d) => {
      d.templates.push({ id: 'ruled', name: 'Ruled', scope: 'personal', body: '## 1:1\n- \n---\n### Notes\n- ' })
      d.prefs.oneOnOneTemplateId = 'ruled'
    })
    render(container, PERSON_LOC, store, pm)
    clickNew(container)
    const start = window.getSelection()!.getRangeAt(0).startContainer
    const li = (start instanceof Element ? start : start.parentElement)!.closest('li')!
    expect(li.closest('ul')!.previousElementSibling?.textContent).toBe('1:1')
  })

  test('the button is labelled like "+ Person" and carries its hotkey in the title', () => {
    const { container, store, pm } = setup(withNotes(''))
    render(container, PERSON_LOC, store, pm)
    const btn = container.querySelector('.tt-person-header-one-on-one-btn')!
    expect(btn.textContent).toBe('+ New 1:1')
    expect(btn.classList.contains('tt-btn')).toBe(true)
    expect(btn.getAttribute('title')).toBe('New 1:1 (Alt+O)')
  })

  test('NEW_ONE_ON_ONE_EVENT on the pane body runs the same action', () => {
    vi.useFakeTimers()
    const { container, store, pm } = setup(withNotes('- [ ] a'))
    container.className = 'tt-pane-body'
    render(container, PERSON_LOC, store, pm)
    requestNewOneOnOne(0)
    vi.advanceTimersByTime(1000)
    expect(member(store).notes).toContain('- [>] a\n---\n## 1:1')
    expect(member(store).lastOneOnOne).toBe(todayIso())

    container.dispatchEvent(new CustomEvent(NEW_ONE_ON_ONE_EVENT))
    vi.advanceTimersByTime(1000)
    expect(member(store).notes.split('## 1:1')).toHaveLength(3)
  })

  test('an empty note becomes the block alone, with no rule before it', () => {
    vi.useFakeTimers()
    const { container, store, pm } = setup(withNotes(''))
    render(container, PERSON_LOC, store, pm)
    clickNew(container)
    vi.advanceTimersByTime(1000)
    expect(member(store).notes.startsWith('## 1:1')).toBe(true)
  })

  test('deleted template id falls back to a bare heading', () => {
    vi.useFakeTimers()
    const { container, store, pm } = setup(withNotes('- [ ] a'))
    store.update((d) => { d.prefs.oneOnOneTemplateId = 'gone' })
    render(container, PERSON_LOC, store, pm)
    clickNew(container)
    vi.advanceTimersByTime(1000)
    const notes = member(store).notes
    expect(notes).toMatch(/^- \[>\] a\n---\n## 1:1 — [^\n]+\n### Carried over\n- \[ \] a$/)
    expect(notes).not.toContain('How are they')
  })

  test('with no empty slot in the block, the caret goes to the end of the note, scrolled into view', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const { container, store, pm } = setup(withNotes('- [ ] a'))
    store.update((d) => { d.prefs.oneOnOneTemplateId = 'gone' })
    render(container, PERSON_LOC, store, pm)
    clickNew(container)
    const ed = editorEl(container)
    const r = window.getSelection()!.getRangeAt(0)
    expect(r.collapsed).toBe(true)
    // Nothing after the caret: typing appends, never prepends to the carried item.
    const after = document.createRange()
    after.setStart(r.startContainer, r.startOffset)
    after.setEnd(ed, ed.childNodes.length)
    expect(after.toString()).toBe('')
    expect(ed.lastElementChild!.textContent).toBe('a')
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.contexts[0]).toBe(ed.lastElementChild)
  })

  test('a chosen template re-scoped to daily falls back to a bare heading, as Preferences shows None', () => {
    vi.useFakeTimers()
    const { container, store, pm } = setup(withNotes('- [ ] a'))
    store.update((d) => {
      const seed = d.templates.find((tp) => tp.id === d.prefs.oneOnOneTemplateId)!
      seed.scope = 'daily'
    })
    render(container, PERSON_LOC, store, pm)
    clickNew(container)
    vi.advanceTimersByTime(1000)
    const notes = member(store).notes
    expect(notes).toMatch(/^- \[>\] a\r?\n---\r?\n## 1:1 — [^\r\n]+\r?\n### Carried over\r?\n- \[ \] a$/)
    expect(notes).not.toContain('How are they')
  })

  test('does nothing in a read-only tab', () => {
    vi.useFakeTimers()
    const { container, store, pm } = setup(withNotes('- [ ] a'))
    render(container, PERSON_LOC, store, pm)
    // What core/tab-lock.ts does when another tab holds the file.
    store.setReadOnly(true)
    setEditorsReadOnly(true)
    try {
      clickNew(container)
      vi.advanceTimersByTime(1000)
      expect(member(store).notes).toBe('- [ ] a')
      expect(member(store).lastOneOnOne).toBeUndefined()
    } finally {
      setEditorsReadOnly(false)
    }
  })

  test('status line: "No 1:1 yet · every 14 days" for a member; overdue class when late', () => {
    const { container, store, pm } = setup(withNotes(''))
    render(container, PERSON_LOC, store, pm)
    expect(line(container).textContent).toBe('No 1:1 yet · every 14 days')
    expect(line(container).classList.contains('overdue')).toBe(false)

    store.update((d) => { d.teams[0]!.members[0]!.lastOneOnOne = addDaysIso(todayIso(), -30) }, { teamId: 'T1', sections: ['people'] })
    expect(line(container).textContent).toBe('Last 1:1: 30 days ago · every 14 days')
    expect(line(container).classList.contains('overdue')).toBe(true)

    // Due today is not late yet.
    store.update((d) => { d.teams[0]!.members[0]!.lastOneOnOne = addDaysIso(todayIso(), -14) }, { teamId: 'T1', sections: ['people'] })
    expect(line(container).classList.contains('overdue')).toBe(false)
  })

  test('status line uses the singular for one day', () => {
    const { container, store, pm } = setup(withNotes(''))
    store.update((d) => {
      d.teams[0]!.members[0]!.lastOneOnOne = addDaysIso(todayIso(), -1)
      d.teams[0]!.members[0]!.oneOnOneEveryDays = 1
    })
    render(container, PERSON_LOC, store, pm)
    expect(line(container).textContent).toBe('Last 1:1: 1 day ago · every 1 day')
    store.update((d) => { d.teams[0]!.members[0]!.lastOneOnOne = addDaysIso(todayIso(), -2) }, { teamId: 'T1', sections: ['people'] })
    expect(line(container).textContent).toBe('Last 1:1: 2 days ago · every 1 day')
  })

  test('status line for a stakeholder with no cadence, and "today" right after a 1:1', () => {
    const { container, store, pm } = setup(makeTeam())
    render(container, { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } }, store, pm)
    expect(line(container).textContent).toBe('No 1:1 yet')
    store.update((d) => { d.teams[0]!.stakeholders[0]!.lastOneOnOne = todayIso() }, { teamId: 'T1', sections: ['people'] })
    expect(line(container).textContent).toBe('Last 1:1: today')
  })

  test('status line repaints after a people-scoped update', () => {
    const { container, store, pm } = setup(withNotes(''))
    render(container, PERSON_LOC, store, pm)
    store.update((d) => { d.teams[0]!.members[0]!.oneOnOneEveryDays = 7 }, { teamId: 'T1', sections: ['people'] })
    expect(line(container).textContent).toBe('No 1:1 yet · every 7 days')
    // Members without their own cadence follow the default in prefs.
    store.update((d) => { delete d.teams[0]!.members[0]!.oneOnOneEveryDays }, { teamId: 'T1', sections: ['people'] })
    expect(line(container).textContent).toBe('No 1:1 yet · every 14 days')
    store.update((d) => { d.prefs.oneOnOneDefaultDays = 21 }, { sections: ['prefs'] })
    expect(line(container).textContent).toBe('No 1:1 yet · every 21 days')
  })

  test('the status line opens the edit dialog, and Save repaints it with the new cadence', () => {
    const { container, store, pm } = setup(withNotes(''))
    render(container, PERSON_LOC, store, pm)
    line(container).click()
    const every = document.querySelector('select.tt-person-cadence-select') as HTMLSelectElement
    every.value = 'custom'
    every.dispatchEvent(new Event('change'))
    ;(document.querySelector('input.tt-person-cadence-days-input') as HTMLInputElement).value = '10'
    Array.from(document.querySelectorAll('.tt-modal-buttons button')).find((b) => b.textContent === 'Save')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(member(store).oneOnOneEveryDays).toBe(10)
    expect(line(container).textContent).toBe('No 1:1 yet · every 10 days')
  })

  test('status line repaints when the window comes back on a later day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 13, 12))
    const { container, store, pm } = setup(withNotes(''))
    store.update((d) => { d.teams[0]!.members[0]!.lastOneOnOne = '2026-11-13' })
    render(container, PERSON_LOC, store, pm)
    expect(line(container).textContent).toBe('Last 1:1: today · every 14 days')
    vi.setSystemTime(new Date(2026, 10, 15, 12))
    window.dispatchEvent(new Event('focus'))
    expect(line(container).textContent).toBe('Last 1:1: 2 days ago · every 14 days')
  })

  test('the status line opens the person dialog', () => {
    const { container, store, pm } = setup(withNotes(''))
    render(container, PERSON_LOC, store, pm)
    line(container).click()
    expect(document.querySelector<HTMLInputElement>('input[name="tt-person-name"]')?.value).toBe('Bruno')
  })

  test('teardown releases the day-change listener and subscription', () => {
    const { container, store, pm } = setup(withNotes(''))
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    let live = 0
    const subscribe = store.subscribe.bind(store)
    store.subscribe = (fn) => {
      live++
      const off = subscribe(fn)
      return () => { live--; off() }
    }
    try {
      render(container, PERSON_LOC, store, pm)
      const focusAdds = add.mock.calls.filter(([type]) => type === 'focus')
      expect(focusAdds.length).toBeGreaterThan(0)
      expect(live).toBeGreaterThan(0)
      disposeContainer(container)
      for (const [, fn] of focusAdds) expect(remove.mock.calls.some(([type, f]) => type === 'focus' && f === fn)).toBe(true)
      expect(live).toBe(0)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})
