import { createFollowupRows, focusedCaretElement } from '../src/modules/followup-list'
import { ExpandableRowsController } from '../src/ui/expandable-followup'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { ModuleCtx, PaneManager } from '../src/ui/panes'
import type { Risk } from '../src/core/types'

function risk(id: string, title: string): Risk {
  return { id, title, chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false }
}

function mount(risks: Risk[]) {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team.risks.push(...risks)
  doc.teams.push(team)
  const store = createStore(doc)
  const ctx: ModuleCtx = {
    store, pm: {} as PaneManager, paneIdx: 0, locale: 'en-US',
    searchIndex: createSearchIndex(() => store.doc, () => store.rev),
    saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} },
  }
  const listEl = document.body.appendChild(document.createElement('div'))
  const renderAll = vi.fn()
  const rows = createFollowupRows<Risk>({
    ctx, teamId: 't1', prefix: 'risk', listEl, expandable: new ExpandableRowsController(),
    nameRequired: 'Needs a name', find: (id) => store.doc.teams[0]!.risks.find((r) => r.id === id), renderAll,
  })
  for (const r of risks) {
    const row = document.createElement('div')
    row.className = 'tt-risk-row'
    row.tabIndex = 0
    row.setAttribute('data-risk-id', r.id)
    const title = document.createElement('input')
    title.className = 'tt-risk-title-input'
    row.append(title, rows.backlinksSlot(r.id))
    listEl.appendChild(row)
  }
  return { store, listEl, rows, renderAll }
}

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

test('requireTitle passes a titled row, and flags + focuses an untitled one', () => {
  const { rows, listEl } = mount([risk('a', 'Vendor'), risk('b', '')])
  expect(rows.requireTitle('a')).toBe(true)
  expect(rows.requireTitle('b')).toBe(false)
  const row = rows.rowFor('b')!
  expect(row.querySelector('.tt-risk-name-error')?.textContent).toBe('Needs a name')
  expect(document.activeElement).toBe(row.querySelector('.tt-risk-title-input'))
  expect(listEl.querySelectorAll('.tt-risk-name-error')).toHaveLength(1)
})

test('arrow keys on a row move between rows; Space opens the menu at the row', () => {
  const { rows } = mount([risk('a', 'A'), risk('b', 'B')])
  const openMenu = vi.fn()
  rows.wireRowKeys(rows.rowFor('a')!, 'a', openMenu)
  rows.rowFor('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(rows.rowFor('b'))
  rows.rowFor('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  expect(openMenu).toHaveBeenCalledTimes(1)
})

test('the blank-title guard discards a discardable draft once focus leaves the list', () => {
  vi.useFakeTimers()
  const { rows } = mount([risk('a', '')])
  const discard = vi.fn()
  rows.installBlankTitleGuard(rows.rowFor('a')!, 'a', { keepsRowOpen: () => false, isDiscardable: () => true, discard })
  const outside = document.body.appendChild(document.createElement('button'))
  outside.focus()
  rows.rowFor('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  vi.runAllTimers()
  expect(discard).toHaveBeenCalledWith('a')
})

test('the blank-title guard keeps the draft when the module says the focus target belongs to the list', () => {
  vi.useFakeTimers()
  const { rows } = mount([risk('a', '')])
  const discard = vi.fn()
  const addBtn = document.body.appendChild(document.createElement('button'))
  rows.installBlankTitleGuard(rows.rowFor('a')!, 'a', { keepsRowOpen: (el) => el === addBtn, isDiscardable: () => true, discard })
  addBtn.focus()
  rows.rowFor('a')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  vi.runAllTimers()
  expect(discard).not.toHaveBeenCalled()
})

test('refreshBacklinkChips swaps each slot for a chip once the row is mentioned', () => {
  const { rows, store } = mount([risk('a', 'Vendor')])
  expect(rows.rowFor('a')!.querySelector('.tt-backlinks-chip-slot')).not.toBeNull()
  store.update((d) => { d.teams[0]!.dailyNotes['2026-01-01'] = 'see @[Vendor](risk:a)' }, { teamId: 't1', sections: ['notes'] })
  rows.refreshBacklinkChips()
  expect(rows.rowFor('a')!.querySelector('.tt-backlinks-chip')?.textContent).toBe('↩ 1')
})

test('focusedCaretElement: only the listed input types and a contenteditable editor count', () => {
  const container = document.body.appendChild(document.createElement('div'))
  const text = container.appendChild(Object.assign(document.createElement('input'), { type: 'text' }))
  const box = container.appendChild(Object.assign(document.createElement('input'), { type: 'checkbox' }))
  text.focus()
  expect(focusedCaretElement(container, ['text'])).toBe(text)
  box.focus()
  expect(focusedCaretElement(container, ['text'])).toBeNull()
})
