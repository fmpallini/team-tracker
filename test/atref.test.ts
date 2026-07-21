import { createEditor, type Editor, type EditorHooks } from '../src/ui/editor'
import { attachAtAutocomplete, filterAtItems, makeRefClickHandler, makeRefLabelResolver, type AtItem } from '../src/ui/atref'
import type { RefCandidate } from '../src/core/search'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import type { PaneManager } from '../src/ui/panes'
import type { Loc } from '../src/core/types'
import { formatDate, t, type Locale } from '../src/core/i18n'

function makeHooks(): EditorHooks {
  return {
    onChange() {},
    onRefClick() {},
    onAtTrigger() {},
    onSlashTrigger() {},
  }
}

function candidates(overrides: Partial<Parameters<typeof filterAtItems>[0]> = {}): Parameters<typeof filterAtItems>[0] {
  return { people: [], actionItems: [], milestones: [], risks: [], ...overrides }
}

describe('filterAtItems', () => {
  const people: RefCandidate[] = [
    { id: 'p1', title: 'Ana' },
    { id: 'p2', title: 'María' },
    { id: 'p3', title: 'Bruno' },
  ]

  test('substring match is accent- and case-insensitive', () => {
    const items = filterAtItems(candidates({ people }), 'mar', 'pt-BR')
    expect(items.filter((i) => i.kind === 'person').map((i) => (i as { name: string }).name)).toEqual(['María'])
  })

  test('empty typed text returns all people plus the 3 relative days and the format-hint item', () => {
    const items = filterAtItems(candidates({ people }), '', 'pt-BR')
    expect(items.filter((i) => i.kind === 'person')).toHaveLength(3)
    expect(items.filter((i) => i.kind === 'day')).toHaveLength(4) // @today discoverability: bare '@' shows hoje/ontem/amanhã + the today+2 format-hint item
  })

  test('no substring match yields an empty person list', () => {
    expect(filterAtItems(candidates({ people }), 'zzz', 'pt-BR').filter((i) => i.kind === 'person')).toEqual([])
  })

  test('a complete pt-BR date (dd/mm/yyyy) appends a day item', () => {
    const items = filterAtItems(candidates(), '02/07/2026', 'pt-BR')
    expect(items).toContainEqual({ kind: 'day', date: '2026-07-02' })
  })

  test('a complete en-US date (mm/dd/yyyy) appends a day item', () => {
    const items = filterAtItems(candidates(), '07/02/2026', 'en-US')
    expect(items).toContainEqual({ kind: 'day', date: '2026-07-02' })
  })

  test('invalid or incomplete date text does not append a day item', () => {
    expect(filterAtItems(candidates(), '99/99/9999', 'pt-BR').some((i) => i.kind === 'day')).toBe(false)
    expect(filterAtItems(candidates(), '02/07', 'pt-BR').some((i) => i.kind === 'day')).toBe(false)
  })

  function isoShift(days: number): string {
    const d = new Date(); d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  test('offers relative days in pt-BR, tagged with the trigger word', () => {
    expect(filterAtItems(candidates(), 'hoje', 'pt-BR')).toContainEqual({ kind: 'day', date: isoShift(0), relativeWord: 'hoje' })
    expect(filterAtItems(candidates(), 'ont', 'pt-BR')).toContainEqual({ kind: 'day', date: isoShift(-1), relativeWord: 'ontem' })
    expect(filterAtItems(candidates(), 'amanh', 'pt-BR')).toContainEqual({ kind: 'day', date: isoShift(1), relativeWord: 'amanhã' })
  })

  test('offers relative days in en-US, tagged with the trigger word', () => {
    expect(filterAtItems(candidates(), 'tomo', 'en-US')).toContainEqual({ kind: 'day', date: isoShift(1), relativeWord: 'tomorrow' })
  })

  test('offers all three relative days plus a today+2 format-hint item on empty input (bare @ discoverability)', () => {
    const days = filterAtItems(candidates(), '', 'pt-BR').filter((i) => i.kind === 'day')
    expect(days).toEqual([
      { kind: 'day', date: isoShift(0), relativeWord: 'hoje' },
      { kind: 'day', date: isoShift(-1), relativeWord: 'ontem' },
      { kind: 'day', date: isoShift(1), relativeWord: 'amanhã' },
      { kind: 'day', date: isoShift(2) }, // format-hint: no relativeWord, demonstrates the typed-date format
    ])
  })

  test('groups results by type in a fixed order: people, dates, actions, milestones, risks', () => {
    const items = filterAtItems({
      people: [{ id: 'p1', title: 'Eva' }],
      actionItems: [{ id: 'a1', title: 'Fix regression' }],
      milestones: [{ id: 'm1', title: 'Release v2' }],
      risks: [{ id: 'r1', title: 'Vendor delay' }],
    }, 'e', 'pt-BR') // 'e' matches Eva and all three items; unlike 'a' (which also
    // startsWith-matches pt-BR's "amanhã" -> normalized "amanha"), no relative-day
    // word (hoje/ontem/amanhã) starts with 'e', so no 'day' item leaks into the group order.
    expect(items.map((i) => i.kind)).toEqual(['person', 'action', 'milestone', 'risk'])
  })

  test('caps each group at 5 results', () => {
    const actionItems = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, title: `Item ${i}` }))
    const items = filterAtItems(candidates({ actionItems }), '', 'pt-BR')
    expect(items.filter((i) => i.kind === 'action')).toHaveLength(5)
  })

  test('substring match on action item/milestone/risk titles', () => {
    const items = filterAtItems({
      people: [],
      actionItems: [{ id: 'a1', title: 'Fix login bug' }, { id: 'a2', title: 'Ship release' }],
      milestones: [{ id: 'm1', title: 'Beta launch' }],
      risks: [{ id: 'r1', title: 'Vendor delay' }],
    }, 'bug', 'pt-BR')
    expect(items).toEqual([{ kind: 'action', id: 'a1', title: 'Fix login bug' }])
  })
})

describe('attachAtAutocomplete', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.destroy()
    editor = null
    document.body.innerHTML = ''
  })

  function setup(
    locale: Locale = 'pt-BR',
    people: RefCandidate[] = [
      { id: 'ana-id', title: 'Ana' },
      { id: 'bruno-id', title: 'Bruno' },
    ]
  ): { editorEl: HTMLElement; picks: AtItem[] } {
    const picks: AtItem[] = []
    editor = createEditor(makeHooks(), locale)
    document.body.appendChild(editor.root)
    attachAtAutocomplete(editor, {
      getRefCandidates: () => ({ people, actionItems: [], milestones: [], risks: [] }),
      locale,
      onPick: (item) => picks.push(item),
    })
    const editorEl = editor.root.querySelector('.editor') as HTMLElement
    return { editorEl, picks }
  }

  // Directly (re)writes the current block's text and places the caret at its
  // end — simpler than simulating real keystroke-by-keystroke DOM mutation,
  // and exercises the same code path since attachAtAutocomplete re-derives
  // its state from the live selection on every 'input' event.
  function setBlockText(editorEl: HTMLElement, text: string): void {
    editorEl.innerHTML = `<div>${text}</div>`
    const textNode = editorEl.firstChild!.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent!.length)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  function fireInput(editorEl: HTMLElement): void {
    editorEl.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function fireKey(editorEl: HTMLElement, key: string): void {
    editorEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  test('typing @ opens the dropdown listing all people plus the 3 relative-day suggestions and the format-hint item, under group headers', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')
    expect(dropdown).not.toBeNull()
    expect(dropdown!.querySelectorAll('.tt-atref-item')).toHaveLength(6) // 2 people + 3 relative days + 1 format-hint
    expect(dropdown!.querySelectorAll('.tt-atref-group-header')).toHaveLength(2) // People, Dates
  })

  test('relative-day rows show the trigger word so it\'s discoverable ("@hoje · <date>")', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const today = new Date()
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const rows = Array.from(document.querySelectorAll('.tt-atref-item')).map((r) => r.textContent)
    expect(rows).toContain(`@hoje · ${formatDate(todayIso, 'pt-BR')}`)
  })

  test('hovering a row does not replace its DOM node (real-browser click requires mousedown/mouseup on the same element)', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const rowsBefore = Array.from(document.querySelectorAll('.tt-atref-item'))
    rowsBefore[1]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    const rowsAfter = Array.from(document.querySelectorAll('.tt-atref-item'))

    expect(rowsAfter[0]).toBe(rowsBefore[0])
    expect(rowsAfter[1]).toBe(rowsBefore[1])
    expect(rowsAfter[1]!.classList.contains('selected')).toBe(true)
    expect(rowsAfter[0]!.classList.contains('selected')).toBe(false)
  })

  test('typing after @ filters the list; Enter inserts the chip and removes the typed text', () => {
    const { editorEl, picks } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)
    setBlockText(editorEl, '@A')
    fireInput(editorEl)
    setBlockText(editorEl, '@An')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')!
    expect(dropdown.querySelectorAll('.tt-atref-item')).toHaveLength(1)

    fireKey(editorEl, 'Enter')

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    const chip = editorEl.querySelector('a.ref') as HTMLAnchorElement
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.dataset.ref).toBe('person:ana-id')
    expect(chip.textContent).toBe('@Ana')
    expect(editorEl.textContent).toBe('@Ana ') // typed "@An" fully replaced, chip + trailing space, nothing left over
    expect(picks).toEqual([{ kind: 'person', id: 'ana-id', name: 'Ana' }])

    // Caret lands after the trailing space, ready for the user to keep typing.
    const sel = window.getSelection()!
    const caretRange = sel.getRangeAt(0)
    expect(caretRange.collapsed).toBe(true)
    const preCaret = document.createRange()
    preCaret.selectNodeContents(editorEl.firstElementChild as HTMLElement)
    preCaret.setEnd(caretRange.startContainer, caretRange.startOffset)
    expect(preCaret.toString()).toBe('@Ana ')
  })

  test('Escape cancels and leaves the literal @text as typed', () => {
    const { editorEl, picks } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)
    setBlockText(editorEl, '@An')
    fireInput(editorEl)

    fireKey(editorEl, 'Escape')

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
    expect(editorEl.querySelector('a.ref')).toBeNull()
    expect(editorEl.textContent).toBe('@An')
    expect(picks).toEqual([])
  })

  test('a complete date typed after @ offers a "go to day" item and inserts a day chip', () => {
    const { editorEl, picks } = setup('pt-BR')
    setBlockText(editorEl, '@')
    fireInput(editorEl)
    setBlockText(editorEl, '@02/07/2026')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')!
    expect(dropdown.textContent).toContain('02/07/2026')

    fireKey(editorEl, 'Enter')

    const chip = editorEl.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.dataset.ref).toBe('day:2026-07-02')
    expect(chip.textContent).toBe('@02/07/2026')
    expect(picks).toEqual([{ kind: 'day', date: '2026-07-02' }])
  })

  test('group headers are icon-prefixed', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const headers = Array.from(document.querySelectorAll('.tt-atref-group-header')).map((h) => h.textContent)
    expect(headers[0]).toMatch(/^🧑/) // People
    expect(headers[1]).toMatch(/^📅/) // Dates
  })

  test('the format-hint item (today+2, no relative word) is a real, selectable item that inserts a normal day chip', () => {
    const { editorEl, picks } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)

    const dayRows = Array.from(document.querySelectorAll('.tt-atref-item')).filter((r) => !r.textContent?.startsWith('@'))
    const hintRow = dayRows[dayRows.length - 1]! // last of the 4 date rows: hoje/ontem/amanhã then the hint
    const d = new Date(); d.setDate(d.getDate() + 2)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    // No relativeWord -> plain "go to day" phrasing (same as any typed-exact-date match), which
    // doubles as a worked example of the dd/mm/yyyy format since the date itself is shown that way.
    expect(hintRow.textContent).toBe(t('pt-BR', 'atref_goto_day', { date: formatDate(iso, 'pt-BR') }))

    hintRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const chip = editorEl.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.dataset.ref).toBe(`day:${iso}`)
    expect(picks).toEqual([{ kind: 'day', date: iso }])
  })

  test('deleting back past the @ closes the dropdown', () => {
    const { editorEl } = setup()
    setBlockText(editorEl, '@')
    fireInput(editorEl)
    expect(document.querySelector('.tt-atref-dropdown')).not.toBeNull()

    setBlockText(editorEl, 'hello')
    fireInput(editorEl)

    expect(document.querySelector('.tt-atref-dropdown')).toBeNull()
  })

  test('person name with brackets and parens is sanitized in chip textContent', () => {
    const { editorEl, picks } = setup('pt-BR', [
      { id: 'ana-id', title: 'Ana [Sales] (RH)' },
    ])
    setBlockText(editorEl, '@')
    fireInput(editorEl)
    setBlockText(editorEl, '@Ana')
    fireInput(editorEl)

    const dropdown = document.querySelector('.tt-atref-dropdown')!
    expect(dropdown.querySelectorAll('.tt-atref-item')).toHaveLength(1)

    fireKey(editorEl, 'Enter')

    const chip = editorEl.querySelector('a.ref') as HTMLAnchorElement
    expect(chip.dataset.ref).toBe('person:ana-id')
    expect(chip.textContent).toBe('@Ana Sales RH')
    expect(picks).toEqual([{ kind: 'person', id: 'ana-id', name: 'Ana [Sales] (RH)' }])
  })
})

describe('makeRefClickHandler', () => {
  function fakePM(): PaneManager & { calls: { idx: 0 | 1; loc: Loc }[] } {
    const calls: { idx: 0 | 1; loc: Loc }[] = []
    return {
      calls,
      openInPane: (idx: 0 | 1, loc: Loc) => { calls.push({ idx, loc }) },
      openInFocused: () => { throw new Error('onRefClick must navigate the editor\'s own pane via openInPane, not openInFocused') },
      toggleSplit: () => {},
      renderAll: () => {},
      registerModule: () => {},
      setSplitSpaceConstrained: () => {},
    }
  }

  function setupStore(): Store {
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 'stk-1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
      members: [{ id: 'mem-1', name: 'Bruno', role: '', parentId: null, order: 0, notes: '' }],
      actionItems: [], milestones: [], risks: [], dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T1'
    return createStore(doc)
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('person found in stakeholders -> openInPane (editor\'s own pane) with the resolved group', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'stk-1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'stk-1', group: 'stakeholders' } } }])
  })

  test('person found in members -> openInPane (editor\'s own pane) with the resolved group', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'mem-1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'mem-1', group: 'members' } } }])
  })

  test('person not found -> silently does not navigate (no toast — matches the other 3 kinds\' dangling-ref behavior)', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'person', id: 'missing' })

    expect(pm.calls).toEqual([])
    expect(document.querySelector('.tt-toast')).toBeNull()
  })

  test('day -> openInPane with the daily note Loc for the team parameter', () => {
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'day', date: '2026-07-02' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } } }])
  })

  test('navigates the editor\'s own pane (1), not whichever pane currently has focus', () => {
    // Regression test: onRefClick fires while the click is still bubbling up
    // from the <a class="ref"> chip, *before* the outer .tt-pane div's own
    // click handler updates store.doc.nav.focusedPane. A handler that used
    // pm.openInFocused() instead of pm.openInPane(paneIdx, ...) would target
    // whatever pane was focused *before* this click, not the pane the chip
    // actually lives in.
    const store = setupStore()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 1, 'pt-BR', 'T1')

    handler({ kind: 'day', date: '2026-07-02' })

    expect(pm.calls).toEqual([{ idx: 1, loc: { teamId: 'T1', ref: { kind: 'daily', date: '2026-07-02' } } }])
  })

  test('two teams: chip from team A is resolved against team A even when nav.activeTeamId = team B', () => {
    // Regression test: ref clicks must use the owning team (passed as a parameter),
    // not the currently active team (store.doc.nav.activeTeamId). If the user has
    // team B open but clicks a person chip from team A (e.g., copied across modules
    // or lingering from earlier edits), we should navigate to that person within team A.
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 'alice-t1', name: 'Alice', role: '', parentId: null, order: 0, notes: '' }],
      members: [],
      actionItems: [], milestones: [], risks: [], dailyNotes: {},
    })
    doc.teams.push({
      id: 'T2', name: 'Team 2', emoji: '🎯',
      stakeholders: [{ id: 'alice-t2', name: 'Alice', role: '', parentId: null, order: 0, notes: '' }],
      members: [],
      actionItems: [], milestones: [], risks: [], dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T2' // user is viewing team B
    const store = createStore(doc)
    const pm = fakePM()

    // Handler for team A (the module this chip lives in)
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    // Click a person chip referencing team A's Alice
    handler({ kind: 'person', id: 'alice-t1' })

    // Should resolve against team A, finding alice-t1 in stakeholders
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'person', personId: 'alice-t1', group: 'stakeholders' } } }])
  })

  function setupStoreWithItems(): Store {
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [], members: [],
      actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
      risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T1'
    return createStore(doc)
  }

  test('action -> openInPane on the actions board with the item id', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'action', id: 'a1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'a1' } } }])
  })

  test('milestone -> openInPane on the milestones board with the item id', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'milestone', id: 'm1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'milestones', itemId: 'm1' } } }])
  })

  test('risk -> openInPane on the risks board with the item id', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    handler({ kind: 'risk', id: 'r1' })

    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'risks', itemId: 'r1' } } }])
  })

  test('action/milestone/risk not found -> still opens the board, no throw', () => {
    const store = setupStoreWithItems()
    const pm = fakePM()
    const handler = makeRefClickHandler(store, pm, 0, 'pt-BR', 'T1')

    expect(() => handler({ kind: 'action', id: 'missing' })).not.toThrow()
    expect(pm.calls).toEqual([{ idx: 0, loc: { teamId: 'T1', ref: { kind: 'actions', itemId: 'missing' } } }])
  })
})

describe('makeRefLabelResolver', () => {
  function setupStore(): Store {
    const doc = createEmptyDocument('pt-BR')
    doc.teams.push({
      id: 'T1', name: 'Team 1', emoji: '🚀',
      stakeholders: [{ id: 's1', name: 'Carla', role: '', parentId: null, order: 0, notes: '' }],
      members: [],
      actionItems: [{ id: 'a1', summary: 'Fix bug', notes: '', status: 'todo', dueDate: null, assignee: '', color: 'ledger', order: 0 }],
      milestones: [{ id: 'm1', date: '2026-08-01', title: 'Ship v2', done: false, followup: '' }],
      risks: [{ id: 'r1', title: 'Vendor delay', chance: 1, impact: 1, plan: 'accept', followup: '', order: 0, closed: false }],
      dailyNotes: {},
    })
    doc.nav.activeTeamId = 'T1'
    return createStore(doc)
  }

  test('resolves the current name/title for each kind', () => {
    const resolve = makeRefLabelResolver(setupStore(), 'T1')
    expect(resolve({ kind: 'person', id: 's1' })).toBe('Carla')
    expect(resolve({ kind: 'action', id: 'a1' })).toBe('Fix bug')
    expect(resolve({ kind: 'milestone', id: 'm1' })).toBe('Ship v2')
    expect(resolve({ kind: 'risk', id: 'r1' })).toBe('Vendor delay')
  })

  test('resolves day to the formatted date in the store\'s current locale', () => {
    const resolve = makeRefLabelResolver(setupStore(), 'T1')
    expect(resolve({ kind: 'day', date: '2026-07-02' })).toBe(formatDate('2026-07-02', 'pt-BR'))
  })

  test('returns null for an id that no longer exists', () => {
    const resolve = makeRefLabelResolver(setupStore(), 'T1')
    expect(resolve({ kind: 'action', id: 'missing' })).toBeNull()
  })

  test('renaming an item changes what the resolver returns on the next call (live, not cached)', () => {
    const store = setupStore()
    const resolve = makeRefLabelResolver(store, 'T1')
    expect(resolve({ kind: 'action', id: 'a1' })).toBe('Fix bug')
    store.update((d) => { d.teams[0]!.actionItems[0]!.summary = 'Fix login bug' })
    expect(resolve({ kind: 'action', id: 'a1' })).toBe('Fix login bug')
  })
})
