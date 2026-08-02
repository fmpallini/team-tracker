import { scopeAffects } from '../src/core/scope'

test('a null/undefined scope always affects everything', () => {
  expect(scopeAffects(null, 't1', ['actions'])).toBe(true)
  expect(scopeAffects(undefined, 't1', ['actions'])).toBe(true)
})

test('an empty scope object affects everything', () => {
  expect(scopeAffects({}, 't1', ['actions'])).toBe(true)
})

test('a different teamId does not affect this listener', () => {
  expect(scopeAffects({ teamId: 't2' }, 't1', ['actions'])).toBe(false)
})

test('a matching teamId with no sections affects every section', () => {
  expect(scopeAffects({ teamId: 't1' }, 't1', ['actions'])).toBe(true)
  expect(scopeAffects({ teamId: 't1' }, 't1', ['notes'])).toBe(true)
})

test('sections must intersect for the listener to be affected', () => {
  expect(scopeAffects({ teamId: 't1', sections: ['notes'] }, 't1', ['actions'])).toBe(false)
  expect(scopeAffects({ teamId: 't1', sections: ['actions'] }, 't1', ['actions'])).toBe(true)
  expect(scopeAffects({ teamId: 't1', sections: ['notes', 'actions'] }, 't1', ['actions'])).toBe(true)
})

test('a section-only scope (no teamId) applies across teams', () => {
  expect(scopeAffects({ sections: ['prefs'] }, 't1', ['prefs'])).toBe(true)
  expect(scopeAffects({ sections: ['prefs'] }, 't1', ['actions'])).toBe(false)
})

test('a listener watching several sections matches if any one intersects', () => {
  expect(scopeAffects({ sections: ['milestones'] }, 't1', ['actions', 'milestones'])).toBe(true)
})
