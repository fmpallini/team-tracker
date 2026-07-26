import { ExpandableRowsController } from '../src/ui/expandable-followup'

function fakeBundle() {
  return { editor: {} as any, dispose: vi.fn() }
}

test('tracks expand state and disposes registered bundles', () => {
  const c = new ExpandableRowsController()
  expect(c.isExpanded('a')).toBe(false)

  c.toggle('a')
  expect(c.isExpanded('a')).toBe(true)
  c.toggle('a')
  expect(c.isExpanded('a')).toBe(false)

  c.setAll(['a', 'b'], true)
  expect(c.isAllExpanded(['a', 'b'])).toBe(true)
  expect(c.isAllExpanded(['a', 'b', 'c'])).toBe(false)

  const bundleA = fakeBundle()
  c.register('a', bundleA)
  c.disposeAll()
  expect(bundleA.dispose).toHaveBeenCalledOnce()

  c.setAll(['a', 'b'], false)
  expect(c.isExpanded('a')).toBe(false)
})

test('collapse drops the id without requiring a registered bundle', () => {
  const c = new ExpandableRowsController()
  c.toggle('x')
  c.collapse('x')
  expect(c.isExpanded('x')).toBe(false)
})

test('expand adds the id to the expanded set, idempotently', () => {
  const c = new ExpandableRowsController()
  expect(c.isExpanded('x')).toBe(false)
  c.expand('x')
  expect(c.isExpanded('x')).toBe(true)
  c.expand('x') // calling again is a no-op, not an error
  expect(c.isExpanded('x')).toBe(true)
})
