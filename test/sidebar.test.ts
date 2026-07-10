import { mountSidebar, notifyNavChanged, onNavChanged, ADD_TEAM_REQUEST_EVENT } from '../src/ui/sidebar'
import { createShell, type Shell } from '../src/ui/shell'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { todayIso } from '../src/core/i18n'
import type { Loc } from '../src/core/types'

// jsdom does not implement matchMedia; createShell() needs it to watch the
// OS theme preference.
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

function setup(): { shell: Shell; store: Store; selectTeam: ReturnType<typeof vi.fn>; renderPanes: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = ''
  stubMatchMedia()
  const doc = createEmptyDocument('en-US')
  const store = createStore(doc)
  const shell = createShell('en-US')
  document.body.appendChild(shell.root)
  const selectTeam = vi.fn((id: string) => {
    store.updateNav((d) => { d.nav.activeTeamId = id })
  })
  const renderPanes = vi.fn()
  mountSidebar(shell, store, { selectTeam, renderPanes })
  return { shell, store, selectTeam, renderPanes }
}

function addTeam(store: Store, name: string, emoji = '🚀'): void {
  store.update((d) => {
    d.teams.push({
      id: name, name, emoji,
      stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {},
    })
  })
}

function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.tt-team-item'))
}

function clickByText(text: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('renders teams in array order with number, emoji and name', () => {
  const { store } = setup()
  addTeam(store, 'Alpha', '🅰️')
  addTeam(store, 'Beta', '🅱️')

  const rows = items()
  expect(rows).toHaveLength(2)
  expect(rows[0]!.querySelector('.tt-team-num')?.textContent).toBe('1')
  expect(rows[0]!.querySelector('.tt-team-emoji')?.textContent).toBe('🅰️')
  expect(rows[0]!.querySelector('.tt-team-name')?.textContent).toBe('Alpha')
  expect(rows[1]!.querySelector('.tt-team-num')?.textContent).toBe('2')
})

test('first 9 teams get Alt+N hotkey badge, 10th does not', () => {
  const { store } = setup()
  for (let i = 1; i <= 10; i++) addTeam(store, `Team ${i}`)

  const rows = items()
  const badges = document.querySelectorAll('.tt-team-hotkey')
  expect(badges).toHaveLength(9)
  expect(badges[0]!.textContent).toBe('Alt+1')
  expect(badges[1]!.textContent).toBe('Alt+2')
  expect(rows[9]!.querySelector('.tt-team-hotkey')).toBeNull()
})

test('active team is highlighted based on nav.activeTeamId', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  store.update((d) => { d.nav.activeTeamId = 'Beta' })

  const rows = items()
  expect(rows[0]!.classList.contains('active')).toBe(false)
  expect(rows[1]!.classList.contains('active')).toBe(true)
})

test('clicking a team calls selectTeam', () => {
  const { store, selectTeam } = setup()
  addTeam(store, 'Alpha')
  items()[0]!.click()
  expect(selectTeam).toHaveBeenCalledWith('Alpha')
})

test('selectTeam via updateNav + notifyNavChanged re-renders the highlight (hotkey path)', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  store.updateNav((d) => { d.nav.activeTeamId = 'Beta' })
  expect(items()[1]!.classList.contains('active')).toBe(false) // not yet, no notify
  notifyNavChanged()
  expect(items()[1]!.classList.contains('active')).toBe(true)
})

test('+ button opens modal that adds a team via crypto.randomUUID', () => {
  const { store } = setup()
  clickByText('➕')
  const nameInput = document.querySelector('input[name="tt-team-name"]') as HTMLInputElement
  const emojiInput = document.querySelector('input[name="tt-team-emoji"]') as HTMLInputElement
  nameInput.value = 'Gamma'
  nameInput.dispatchEvent(new Event('input'))
  emojiInput.value = '🐙'
  emojiInput.dispatchEvent(new Event('input'))
  clickByText('OK')

  expect(store.doc.teams).toHaveLength(1)
  expect(store.doc.teams[0]!.name).toBe('Gamma')
  expect(store.doc.teams[0]!.emoji).toBe('🐙')
  expect(store.doc.teams[0]!.id).toMatch(/[0-9a-f-]{36}/)
  expect(store.doc.nav.activeTeamId).toBe(store.doc.teams[0]!.id)
})

test('+ modal requires a name', () => {
  setup()
  clickByText('➕')
  clickByText('OK')
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Name is required')
  expect(document.querySelectorAll('.tt-modal-overlay')).toHaveLength(1)
})

test('+ modal requires an emoji — leaving it blank must not silently persist a default 🙂', () => {
  const { store } = setup()
  clickByText('➕')
  const nameInput = document.querySelector('input[name="tt-team-name"]') as HTMLInputElement
  nameInput.value = 'Gamma'
  nameInput.dispatchEvent(new Event('input'))
  clickByText('OK')

  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Emoji is required')
  expect(document.querySelectorAll('.tt-modal-overlay')).toHaveLength(1)
  expect(store.doc.teams).toHaveLength(0)
})

test('adding a team while another already exists still auto-selects the new team', () => {
  const { store, selectTeam } = setup()
  addTeam(store, 'Alpha')
  store.updateNav((d) => { d.nav.activeTeamId = 'Alpha' })

  clickByText('➕')
  const nameInput = document.querySelector('input[name="tt-team-name"]') as HTMLInputElement
  nameInput.value = 'Beta'
  nameInput.dispatchEvent(new Event('input'))
  const emojiInput = document.querySelector('input[name="tt-team-emoji"]') as HTMLInputElement
  emojiInput.value = '🅱️'
  emojiInput.dispatchEvent(new Event('input'))
  clickByText('OK')

  const newTeam = store.doc.teams.find((t) => t.name === 'Beta')!
  expect(selectTeam).toHaveBeenCalledWith(newTeam.id)
  expect(store.doc.nav.activeTeamId).toBe(newTeam.id)
})

test('pencil icon opens edit modal to rename/re-emoji a team', () => {
  const { store } = setup()
  addTeam(store, 'Alpha', '🅰️')
  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement
  editBtn.click()

  const nameInput = document.querySelector('input[name="tt-team-name"]') as HTMLInputElement
  expect(nameInput.value).toBe('Alpha')
  nameInput.value = 'Alpha Renamed'
  nameInput.dispatchEvent(new Event('input'))
  clickByText('OK')

  expect(store.doc.teams[0]!.name).toBe('Alpha Renamed')
})

test('deleting a team re-renders the pane view — a stale module display would otherwise survive the last team being removed', () => {
  const { store, renderPanes } = setup()
  addTeam(store, 'Alpha')
  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.doc.teams).toEqual([])
  expect(renderPanes).toHaveBeenCalledOnce()
})

test('deleting a team fires onNavChanged — main.ts hooks this to save the now-dirty doc immediately, not just on the next auto-save tick', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  let navChangedCount = 0
  const off = onNavChanged(() => navChangedCount++)

  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.dirty).toBe(true)
  expect(navChangedCount).toBe(1)
  off()
})

test('delete with confirmation removes team, reassigns activeTeamId, and prunes pane history', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  const locA: Loc = { teamId: 'Alpha', ref: { kind: 'actions' } }
  const locB: Loc = { teamId: 'Beta', ref: { kind: 'actions' } }
  store.update((d) => {
    d.nav.activeTeamId = 'Alpha'
    d.nav.panes = [
      { history: [locA, locB], index: 1 },
      { history: [locA], index: 0 },
    ]
  })

  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement
  editBtn.click()
  clickByText('Delete')
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete team Alpha and all its data?')
  clickByText('Delete')

  expect(store.doc.teams.map((tm) => tm.id)).toEqual(['Beta'])
  expect(store.doc.nav.activeTeamId).toBe('Beta')
  expect(store.doc.nav.panes[0]).toEqual({ history: [locB], index: 0 })
  // Pane 1 only ever had the deleted team (Alpha) open and never had Beta
  // open in *this* pane before, so it falls back to Beta's daily notes
  // (today) rather than being left empty.
  expect(store.doc.nav.panes[1]).toEqual({
    history: [{ teamId: 'Beta', ref: { kind: 'daily', date: todayIso() } }],
    index: 0,
  })
})

test('deleting a team removes its nav.teamSplit entry and restores the next team\'s remembered split state', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  store.update((d) => {
    d.nav.activeTeamId = 'Alpha'
    d.nav.split = true
    d.nav.teamSplit = { Alpha: true, Beta: false }
  })

  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement // Alpha
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.doc.nav.teamSplit).toEqual({ Beta: false })
  expect(store.doc.nav.split).toBe(false) // restored from Beta's remembered (false), not left at Alpha's (true)
})

test('delete team restores the newly active team\'s own last-used module in a pane that had it open before', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  const locA: Loc = { teamId: 'Alpha', ref: { kind: 'actions' } }
  const locBRisks: Loc = { teamId: 'Beta', ref: { kind: 'risks' } }
  store.update((d) => {
    d.nav.activeTeamId = 'Alpha'
    d.nav.panes = [
      { history: [locBRisks, locA], index: 1 }, // this pane visited Beta's risks before landing on Alpha
      { history: [], index: -1 },
    ]
  })

  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement // Alpha
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.doc.nav.activeTeamId).toBe('Beta')
  // Restores Beta's risks module — what this pane last showed for Beta —
  // instead of resetting to daily notes.
  expect(store.doc.nav.panes[0]).toEqual({ history: [locBRisks], index: 0 })
})

test('deleting the last remaining team clears activeTeamId and leaves panes empty', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  const locA: Loc = { teamId: 'Alpha', ref: { kind: 'actions' } }
  store.update((d) => {
    d.nav.activeTeamId = 'Alpha'
    d.nav.panes = [
      { history: [locA], index: 0 },
      { history: [], index: -1 },
    ]
  })

  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.doc.teams).toEqual([])
  expect(store.doc.nav.activeTeamId).toBeNull()
  expect(store.doc.nav.panes[0]).toEqual({ history: [], index: -1 })
})

test('delete team whose Locs precede the current entry preserves the current Loc', () => {
  const { store } = setup()
  addTeam(store, 'T1')
  addTeam(store, 'T2')
  const locT1: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  const locT2a: Loc = { teamId: 'T2', ref: { kind: 'actions' } }
  const locT2b: Loc = { teamId: 'T2', ref: { kind: 'milestones' } }
  store.update((d) => {
    d.nav.activeTeamId = 'T2'
    d.nav.panes = [
      { history: [locT1, locT2a, locT2b], index: 1 }, // current = locT2a
      { history: [], index: -1 },
    ]
  })

  const editBtn = items()[0]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement // T1
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.doc.nav.panes[0]).toEqual({ history: [locT2a, locT2b], index: 0 })
})

test('delete team owning the current entry falls back to the last remaining Loc', () => {
  const { store } = setup()
  addTeam(store, 'T2')
  addTeam(store, 'T1')
  const locT2a: Loc = { teamId: 'T2', ref: { kind: 'actions' } }
  const locT1a: Loc = { teamId: 'T1', ref: { kind: 'actions' } }
  store.update((d) => {
    d.nav.activeTeamId = 'T1'
    d.nav.panes = [
      { history: [locT2a, locT1a], index: 1 }, // current = locT1a, owned by T1
      { history: [], index: -1 },
    ]
  })

  const editBtn = items()[1]!.querySelector('.tt-team-edit-btn') as HTMLButtonElement // T1
  editBtn.click()
  clickByText('Delete')
  clickByText('Delete')

  expect(store.doc.nav.panes[0]).toEqual({ history: [locT2a], index: 0 })
})

test('drag and drop reorders the teams array', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  addTeam(store, 'Gamma')

  const rows = items()
  const src = rows[0]! // Alpha
  const target = rows[2]! // Gamma

  src.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }))
  // drop after Gamma (clientY beyond its zero-size rect => "after" half)
  const dropEvt = new MouseEvent('drop', { bubbles: true, clientY: 1 })
  target.dispatchEvent(dropEvt)

  expect(store.doc.teams.map((tm) => tm.name)).toEqual(['Beta', 'Gamma', 'Alpha'])
})

test('tt-add-team-request event opens the add-team modal (Task 3 empty-state CTA)', () => {
  // Note: mountSidebar's document-level ADD_TEAM_REQUEST_EVENT listener (like
  // NAV_CHANGED_EVENT) is never torn down between `setup()` calls within a
  // test file, so earlier tests' stale listeners also fire here — hence
  // asserting "at least one" modal opened rather than an exact count.
  setup()
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()

  document.dispatchEvent(new CustomEvent(ADD_TEAM_REQUEST_EVENT))

  expect(document.querySelectorAll('.tt-modal-overlay').length).toBeGreaterThanOrEqual(1)
  const nameInput = document.querySelector('input[name="tt-team-name"]') as HTMLInputElement
  expect(nameInput).not.toBeNull()
})

test('onNavChanged returns an unsubscribe function (Task 25 re-review item #4c)', () => {
  let count = 0
  const off = onNavChanged(() => count++)
  notifyNavChanged()
  expect(count).toBe(1)

  off()
  notifyNavChanged()
  expect(count).toBe(1)
})

test('dropping a team back onto its own slot is a no-op (no dirty flag)', () => {
  const { store } = setup()
  addTeam(store, 'Alpha')
  addTeam(store, 'Beta')
  store.markSaved()

  const rows = items()
  rows[0]!.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }))
  rows[0]!.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientY: -1 }))

  expect(store.doc.teams.map((tm) => tm.name)).toEqual(['Alpha', 'Beta'])
  expect(store.dirty).toBe(false)
})
