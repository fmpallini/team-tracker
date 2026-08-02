import { withDisposal } from '../src/modules/lifecycle'
import type { Loc } from '../src/core/types'
import type { ModuleCtx } from '../src/ui/panes'

const LOC: Loc = { teamId: 't1', ref: { kind: 'general' } }
const CTX = {} as ModuleCtx

test('re-rendering into the same container disposes the previous instance first', () => {
  const events: string[] = []
  const render = withDisposal((container) => {
    events.push(`mount:${container.id}`)
    return () => events.push(`dispose:${container.id}`)
  })

  const a = document.createElement('div')
  a.id = 'a'
  render(a, LOC, CTX)
  render(a, LOC, CTX)

  expect(events).toEqual(['mount:a', 'dispose:a', 'mount:a'])
})

test('separate containers keep independent lifecycles', () => {
  const events: string[] = []
  const render = withDisposal((container) => {
    events.push(`mount:${container.id}`)
    return () => events.push(`dispose:${container.id}`)
  })

  const a = document.createElement('div')
  a.id = 'a'
  const b = document.createElement('div')
  b.id = 'b'
  render(a, LOC, CTX)
  render(b, LOC, CTX)

  expect(events).toEqual(['mount:a', 'mount:b'])
})

test('a render returning nothing is supported and clears any prior teardown', () => {
  const events: string[] = []
  let returnTeardown = true
  const render = withDisposal((_container) => {
    events.push('mount')
    if (!returnTeardown) return
    return () => events.push('dispose')
  })

  const a = document.createElement('div')
  render(a, LOC, CTX)   // mounts with a teardown
  returnTeardown = false
  render(a, LOC, CTX)   // disposes the first, mounts with none
  render(a, LOC, CTX)   // nothing to dispose

  expect(events).toEqual(['mount', 'dispose', 'mount', 'mount'])
})

test('a throwing teardown does not prevent the new mount', () => {
  const events: string[] = []
  let first = true
  const render = withDisposal(() => {
    events.push('mount')
    if (first) {
      first = false
      return () => { throw new Error('boom') }
    }
    return () => events.push('dispose')
  })

  const a = document.createElement('div')
  render(a, LOC, CTX)
  render(a, LOC, CTX)

  expect(events).toEqual(['mount', 'mount'])
})
