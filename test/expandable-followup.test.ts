import { ExpandableRowsController } from '../src/ui/expandable-followup'

function fakeBundle() {
  return { editor: { refreshRefLabels: vi.fn() } as any, dispose: vi.fn() }
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

test('refreshAllLabels calls refreshRefLabels on every registered bundle, and none once disposed', () => {
  const c = new ExpandableRowsController()
  const bundleA = fakeBundle()
  const bundleB = fakeBundle()
  c.register('a', bundleA)
  c.register('b', bundleB)

  c.refreshAllLabels()
  expect(bundleA.editor.refreshRefLabels).toHaveBeenCalledOnce()
  expect(bundleB.editor.refreshRefLabels).toHaveBeenCalledOnce()

  c.disposeOne('a')
  c.refreshAllLabels()
  expect(bundleA.editor.refreshRefLabels).toHaveBeenCalledOnce() // not called again — no longer registered
  expect(bundleB.editor.refreshRefLabels).toHaveBeenCalledTimes(2)
})

test('refreshAllLabels on an empty controller is a no-op, not an error', () => {
  const c = new ExpandableRowsController()
  expect(() => c.refreshAllLabels()).not.toThrow()
})
