import { deleteWithUndo } from '../src/core/undo-delete'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import type { Doc } from '../src/core/types'

function docWithTeam(): Doc {
  const d = createEmptyDocument('en-US')
  const team = createEmptyTeam('t1', 'Alpha', '🙂', 'en-US')
  team.risks.push({ id: 'r1', title: 'Slip', chance: 2, impact: 3, plan: 'mitigate', followup: '', order: 0, closed: false })
  team.risks.push({ id: 'r2', title: 'Cost', chance: 1, impact: 1, plan: 'accept', followup: '', order: 1, closed: false })
  d.teams.push(team)
  return d
}

/** Deletes risk r1 from team t1, capturing the whole team. */
function removeR1(d: Doc): ((d: Doc) => void) | null {
  const tm = d.teams.find((t) => t.id === 't1')
  if (!tm) return null
  const before = structuredClone(tm)
  tm.risks = tm.risks.filter((r) => r.id !== 'r1')
  return (d2) => {
    const i = d2.teams.findIndex((t) => t.id === 't1')
    if (i !== -1) d2.teams[i] = before
  }
}

describe('deleteWithUndo', () => {
  it('performs the delete and returns an offer', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    expect(offer).not.toBeNull()
    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r2'])
    expect(offer!.isAvailable()).toBe(true)
  })

  it('undo restores the document exactly', () => {
    const store = createStore(docWithTeam())
    const snapshot = structuredClone(store.doc)
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    expect(offer!.undo()).toBe(true)
    expect(store.doc.teams).toEqual(snapshot.teams)
  })

  it('restores text the delete rewrote, not just the removed entity', () => {
    const store = createStore(docWithTeam())
    store.doc.teams[0]!.dailyNotes['2026-09-13'] = 'see @[Slip](risk:r1) today'
    const offer = deleteWithUndo(store, (d) => {
      const tm = d.teams.find((t) => t.id === 't1')
      if (!tm) return null
      const before = structuredClone(tm)
      // Stand-in for unlinkRefsInTeam: rewrites text in place on the team.
      tm.dailyNotes['2026-09-13'] = 'see ~Slip~ today'
      tm.risks = tm.risks.filter((r) => r.id === 'r1')
      return (d2) => {
        const i = d2.teams.findIndex((t) => t.id === 't1')
        if (i !== -1) d2.teams[i] = before
      }
    }, { teamId: 't1' })
    offer!.undo()
    expect(store.doc.teams[0]!.dailyNotes['2026-09-13']).toBe('see @[Slip](risk:r1) today')
  })

  it('refuses to undo once another update has run', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.update((d) => { d.teams[0]!.name = 'Renamed' })
    expect(offer!.isAvailable()).toBe(false)
    expect(offer!.undo()).toBe(false)
    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r2'])
    expect(store.doc.teams[0]!.name).toBe('Renamed')
  })

  it('refuses to undo once updateNav has run', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.updateNav((d) => { d.nav.sidebarCollapsed = true })
    expect(offer!.undo()).toBe(false)
  })

  it('refuses to undo once the document was replaced', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.replaceDoc(docWithTeam())
    expect(offer!.isAvailable()).toBe(false)
    expect(offer!.undo()).toBe(false)
  })

  it('returns null and writes nothing on a read-only store', () => {
    const store = createStore(docWithTeam())
    store.setReadOnly(true)
    expect(deleteWithUndo(store, removeR1, { teamId: 't1' })).toBeNull()
    expect(store.doc.teams[0]!.risks.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('returns null when the mutate callback deleted nothing', () => {
    const store = createStore(docWithTeam())
    expect(deleteWithUndo(store, () => null, { teamId: 't1' })).toBeNull()
  })

  it('refuses to undo while the store is read-only', () => {
    const store = createStore(docWithTeam())
    const offer = deleteWithUndo(store, removeR1, { teamId: 't1' })
    store.setReadOnly(true)
    expect(offer!.isAvailable()).toBe(false)
    expect(offer!.undo()).toBe(false)
  })
})
