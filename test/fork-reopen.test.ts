import { reopenFork } from '../src/core/fork-reopen'

function rig(over: { reconciled?: boolean; mounted?: boolean } = {}) {
  const persister = { dispose: vi.fn() }
  const forked = { handle: { persister } }
  const order: string[] = []
  const deps = {
    reconcile: vi.fn(async () => (over.reconciled === false ? null : forked)),
    mount: vi.fn(async () => { order.push('mount'); return over.mounted ?? true }),
    removeOriginalCopy: vi.fn(async () => { order.push('remove') }),
  }
  return { deps, persister, order }
}

test("the original's browser copy goes only after the fork is up", async () => {
  const r = rig()
  expect(await reopenFork(r.deps)).toBe('mounted')
  expect(r.order).toEqual(['mount', 'remove'])
  expect(r.persister.dispose).not.toHaveBeenCalled()
})

test("a fork that never mounted (the original stayed open) leaves the original's copy alone and stops the fork's persister", async () => {
  const r = rig({ mounted: false })
  expect(await reopenFork(r.deps)).toBe('kept-original')
  expect(r.deps.removeOriginalCopy).not.toHaveBeenCalled()
  expect(r.persister.dispose).toHaveBeenCalledTimes(1)
})

test('backing out of the reconcile questions touches nothing', async () => {
  const r = rig({ reconciled: false })
  expect(await reopenFork(r.deps)).toBe('cancelled')
  expect(r.deps.mount).not.toHaveBeenCalled()
  expect(r.deps.removeOriginalCopy).not.toHaveBeenCalled()
})

test('a fork opened without browser storage has no persister to stop', async () => {
  const deps = { reconcile: async () => ({ handle: null }), mount: async () => false, removeOriginalCopy: vi.fn(async () => {}) }
  expect(await reopenFork(deps)).toBe('kept-original')
})
