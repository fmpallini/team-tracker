// test/setup-scope-contract.ts — vitest setup file (see vitest.config.ts).
//
// Wraps every store the suite creates with test/scope-contract.ts's auditor, so
// each test that drives a real call site also checks that the scope it passes
// to store.update() matches what its callback actually changed, and that
// updateNav() callbacks stay nav-only. A violation fails the test that
// provoked it; tests that lie about a scope on purpose catch it with
// expectScopeViolations().
import { vi, afterEach } from 'vitest'
import { drainScopeViolations, wrapStore } from './scope-contract'

vi.mock('../src/core/store', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/store')>()
  return { ...mod, createStore: (...args: Parameters<typeof mod.createStore>) => wrapStore(mod.createStore(...args)) }
})

afterEach(() => {
  const violations = drainScopeViolations()
  if (violations.length > 0) {
    throw new Error(`a store mutation changed more than its scope declared:\n  - ${violations.join('\n  - ')}`)
  }
})
