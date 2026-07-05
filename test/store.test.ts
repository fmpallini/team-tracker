import { createStore } from '../src/core/store'
import { createEmptyDocument } from '../src/core/document'

test('update notifies and marks dirty', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let n = 0; s.subscribe(() => n++)
  const dirtyStates: boolean[] = []; s.onDirty(d => dirtyStates.push(d))
  expect(s.dirty).toBe(false)
  s.update(d => { d.teams.push({ id: 't1', name: 'X', emoji: '🚀', stakeholders: [], members: [], actionItems: [], milestones: [], risks: [], dailyNotes: {} }) })
  expect(n).toBe(1); expect(s.dirty).toBe(true); expect(dirtyStates).toEqual([true])
  s.markSaved(); expect(s.dirty).toBe(false); expect(dirtyStates).toEqual([true, false])
})

test('updateNav marks dirty without render', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let n = 0; s.subscribe(() => n++)
  s.updateNav(d => { d.nav.split = true })
  expect(n).toBe(0); expect(s.dirty).toBe(true)
})

test('unsubscribe works', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let n = 0; const un = s.subscribe(() => n++); un()
  s.update(() => {}); expect(n).toBe(0)
})

test('onDirty fires once for repeated updates', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const fired: boolean[] = []; s.onDirty(d => fired.push(d))
  s.update(() => {}); s.update(() => {})
  expect(fired).toEqual([true])
})

test('markSaved on clean store does not fire onDirty', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const fired: boolean[] = []; s.onDirty(d => fired.push(d))
  s.markSaved()
  expect(fired).toEqual([])
})

test('throwing subscriber does not block others', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let called = false
  s.subscribe(() => { throw new Error('boom') })
  s.subscribe(() => { called = true })
  s.update(() => {})
  expect(called).toBe(true)
})

test('replaceDoc swaps the document, clears dirty, and notifies subscribers', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  s.update((d) => { d.nav.activeTeamId = 'stale' })
  expect(s.dirty).toBe(true)
  let n = 0; s.subscribe(() => n++)

  const fresh = createEmptyDocument('en-US')
  s.replaceDoc(fresh)

  expect(s.doc).toBe(fresh)
  expect(s.dirty).toBe(false)
  expect(n).toBe(1)
})

test('setReadOnly(true) blocks update() but not updateNav(), and warns via onBlockedUpdate once', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const warned: number[] = []
  s.onBlockedUpdate(() => warned.push(1))
  expect(s.readOnly).toBe(false)

  s.setReadOnly(true)
  expect(s.readOnly).toBe(true)

  s.update((d) => { d.nav.activeTeamId = 'blocked' })
  expect(s.doc.nav.activeTeamId).toBeNull()
  expect(s.dirty).toBe(false)
  expect(warned).toEqual([1])

  // Repeated blocked update() calls only warn once per read-only "session".
  s.update((d) => { d.nav.activeTeamId = 'blocked-again' })
  expect(warned).toEqual([1])

  // updateNav() is not gated by read-only — navigation stays usable.
  s.updateNav((d) => { d.nav.split = true })
  expect(s.doc.nav.split).toBe(true)

  s.setReadOnly(false)
  s.update((d) => { d.nav.activeTeamId = 'allowed' })
  expect(s.doc.nav.activeTeamId).toBe('allowed')

  // Re-entering read-only re-arms the one-shot warning.
  s.setReadOnly(true)
  s.update(() => {})
  expect(warned).toEqual([1, 1])
})

test('onMutate fires synchronously for both update() and updateNav(), unlike subscribe()', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let subscribeCount = 0
  let mutateCount = 0
  s.subscribe(() => subscribeCount++)
  const unsubscribe = s.onMutate(() => mutateCount++)

  s.update(() => {})
  expect(subscribeCount).toBe(1)
  expect(mutateCount).toBe(1)

  // subscribe() intentionally does not fire for updateNav() — onMutate() does.
  s.updateNav(() => {})
  expect(subscribeCount).toBe(1)
  expect(mutateCount).toBe(2)

  unsubscribe()
  s.update(() => {})
  s.updateNav(() => {})
  expect(mutateCount).toBe(2)
})

test('onMutate does not fire for a blocked (read-only) update()', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let mutateCount = 0
  s.onMutate(() => mutateCount++)
  s.setReadOnly(true)

  s.update(() => {})
  expect(mutateCount).toBe(0)

  s.updateNav(() => {})
  expect(mutateCount).toBe(1)
})

test('throwing onMutate listener does not block others', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  let called = false
  s.onMutate(() => { throw new Error('boom') })
  s.onMutate(() => { called = true })
  s.update(() => {})
  expect(called).toBe(true)
})

test('setReadOnly({ silent: true }) suppresses onBlockedUpdate without burning the one-shot warning', () => {
  const s = createStore(createEmptyDocument('pt-BR'))
  const warned: number[] = []
  s.onBlockedUpdate(() => warned.push(1))

  s.setReadOnly(true, { silent: true })
  s.update((d) => { d.nav.activeTeamId = 'blocked-silently' })
  expect(s.doc.nav.activeTeamId).toBeNull()
  expect(warned).toEqual([])

  // A subsequent *real* (non-silent) read-only transition still warns on the
  // next blocked update — the silent window didn't consume the one-shot.
  s.setReadOnly(true)
  s.update(() => {})
  expect(warned).toEqual([1])

  // And repeated blocked updates after that still only warn once.
  s.update(() => {})
  expect(warned).toEqual([1])
})
