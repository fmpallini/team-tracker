import { createEntityDelete } from '../src/modules/entity-delete'
import { createStore, type Store } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'
import { createSearchIndex } from '../src/core/search'
import type { ModuleCtx, PaneManager } from '../src/ui/panes'
import type { Risk, Team } from '../src/core/types'

// The three card modules' own suites (risks / milestones / action-items) pin
// the end-to-end delete behaviour through the DOM; this file pins the helper's
// contract directly, so a change to it fails here with a precise message.

function risk(overrides: Partial<Risk>): Risk {
  return { id: 'r1', title: 'Slip', chance: 1, impact: 1, plan: 'mitigate', followup: '', order: 0, closed: false, ...overrides }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'T1', name: 'Team 1', emoji: '🚀', stakeholders: [], members: [],
    actionItems: [], milestones: [], risks: [], dailyNotes: {},
    ...overrides,
  }
}

interface Extra { variant?: 'danger' | 'primary'; beforeRemove?: (id: string) => void }

function mount(team: Team, extra: Extra = {}): { store: Store; del: ReturnType<typeof createEntityDelete<'risks'>> } {
  const doc = createEmptyDocument('en-US')
  doc.teams.push(team)
  doc.nav.activeTeamId = team.id
  const store = createStore(doc)
  const ctx: ModuleCtx = {
    store, pm: {} as PaneManager, paneIdx: 0, locale: 'en-US',
    searchIndex: createSearchIndex(() => store.doc, () => store.rev),
    saveStatus: { requestSaveNow: () => {}, subscribeSaveState: () => () => {} },
  }
  const del = createEntityDelete<'risks'>({
    ctx, teamId: team.id, collection: 'risks', refKind: 'risk', labelOf: (r) => r.title, labelParam: 'title',
    messages: { title: 'risk_delete_title', confirm: 'risk_delete_confirm', button: 'risk_delete_btn', toast: 'risk_deleted_toast' },
    ...extra,
  })
  return { store, del }
}

function confirmButton(): HTMLButtonElement {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('createEntityDelete.remove', () => {
  test('removes the entity, flattens its mentions, and the offer restores both', () => {
    const team = makeTeam({ risks: [risk({}), risk({ id: 'r2', title: 'Other', order: 1 })], dailyNotes: { d: 'see @[Slip](risk:r1)' } })
    const { store, del } = mount(team)
    const before = structuredClone(store.doc.teams[0])

    const offer = del.remove('r1')

    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r2'])
    expect(store.doc.teams[0]!.dailyNotes.d).toBe('see ~Slip~')
    expect(offer?.isAvailable()).toBe(true)
    expect(offer!.undo()).toBe(true)
    expect(store.doc.teams[0]).toEqual(before)
  })

  test('an unknown id deletes nothing and offers no undo', () => {
    const { store, del } = mount(makeTeam({ risks: [risk({})] }))

    expect(del.remove('nope')).toBeNull()
    expect(store.doc.teams[0]!.risks).toHaveLength(1)
  })

  test('an unknown team deletes nothing and offers no undo', () => {
    const { store, del } = mount(makeTeam({ risks: [risk({})] }))
    store.doc.teams.length = 0

    expect(del.remove('r1')).toBeNull()
  })

  test('beforeRemove runs before the store update notifies subscribers', () => {
    const order: string[] = []
    const { store, del } = mount(makeTeam({ risks: [risk({})] }), { beforeRemove: (id) => { order.push(`before:${id}`) } })
    store.subscribe(() => order.push('notified'))

    del.remove('r1')

    expect(order).toEqual(['before:r1', 'notified'])
  })

  test('writes with scope { teamId } and no sections', () => {
    const { store, del } = mount(makeTeam({ risks: [risk({})] }))
    const scopes: unknown[] = []
    store.subscribe((scope) => scopes.push(scope))

    del.remove('r1')

    expect(scopes).toEqual([{ teamId: 'T1' }])
  })
})

describe('createEntityDelete.removeSilently', () => {
  test('removes and unlinks without cloning the team', () => {
    const { store, del } = mount(makeTeam({ risks: [risk({})], dailyNotes: { d: 'see @[Slip](risk:r1)' } }))
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone')

    del.removeSilently('r1')

    expect(store.doc.teams[0]!.risks).toHaveLength(0)
    expect(store.doc.teams[0]!.dailyNotes.d).toBe('see ~Slip~')
    expect(cloneSpy).not.toHaveBeenCalled()
  })

  test('runs beforeRemove and uses scope { teamId }', () => {
    const before = vi.fn()
    const { store, del } = mount(makeTeam({ risks: [risk({})] }), { beforeRemove: before })
    const scopes: unknown[] = []
    store.subscribe((scope) => scopes.push(scope))

    del.removeSilently('r1')

    expect(before).toHaveBeenCalledWith('r1')
    expect(scopes).toEqual([{ teamId: 'T1' }])
  })

  test('an unknown id is a no-op', () => {
    const { store, del } = mount(makeTeam({ risks: [risk({})] }))
    del.removeSilently('nope')
    expect(store.doc.teams[0]!.risks).toHaveLength(1)
  })
})

describe('createEntityDelete.requestDelete', () => {
  test('a blank label deletes silently: no dialog, no toast', () => {
    const entity = risk({ title: '   ' })
    const { store, del } = mount(makeTeam({ risks: [entity] }))

    del.requestDelete(entity)

    expect(store.doc.teams[0]!.risks).toHaveLength(0)
    expect(document.querySelector('.tt-modal-overlay')).toBeNull()
    expect(document.querySelector('.tt-toast')).toBeNull()
  })

  test('a named entity asks first, interpolating the label under labelParam, and does nothing until confirmed', () => {
    const entity = risk({})
    const { store, del } = mount(makeTeam({ risks: [entity] }))

    del.requestDelete(entity)

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Delete "Slip"?')
    expect(store.doc.teams[0]!.risks).toHaveLength(1)
  })

  test('confirming deletes, then toasts the label with an Undo that restores it', () => {
    const entity = risk({})
    const { store, del } = mount(makeTeam({ risks: [entity] }))

    del.requestDelete(entity)
    confirmButton().click()

    expect(store.doc.teams[0]!.risks).toHaveLength(0)
    expect(document.querySelector('.tt-toast')?.textContent).toContain('Risk "Slip" deleted')
    document.querySelector<HTMLButtonElement>('.tt-toast-action')!.click()
    expect(store.doc.teams[0]!.risks).toHaveLength(1)
  })

  test('variant "danger" styles the confirm button; the default does not', () => {
    const entity = risk({})
    mount(makeTeam({ risks: [entity] })).del.requestDelete(entity)
    const plainClass = confirmButton().className
    document.body.innerHTML = ''

    mount(makeTeam({ risks: [entity] }), { variant: 'danger' }).del.requestDelete(entity)

    expect(confirmButton().className).not.toBe(plainClass)
  })
})
