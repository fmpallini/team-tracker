import { setupResponsiveLayout, type ResponsiveHooks } from '../src/ui/responsive'

type Callback = (entries: Array<{ contentRect: { width: number } }>) => void

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  cb: Callback
  observed: Element | null = null
  disconnected = false
  constructor(cb: Callback) {
    this.cb = cb
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed = el
  }
  disconnect(): void {
    this.disconnected = true
  }
  fire(width: number): void {
    this.cb([{ contentRect: { width } }])
  }
}

function fakeHooks(): ResponsiveHooks & {
  splitCalls: boolean[]
  sidebarCalls: boolean[]
  headerCompactCalls: boolean[]
} {
  const splitCalls: boolean[] = []
  const sidebarCalls: boolean[] = []
  const headerCompactCalls: boolean[] = []
  return {
    splitCalls,
    sidebarCalls,
    headerCompactCalls,
    setSplitSpaceHidden: (hidden) => splitCalls.push(hidden),
    setSidebarSpaceHidden: (hidden) => sidebarCalls.push(hidden),
    setHeaderCompactSpaceHidden: (hidden) => headerCompactCalls.push(hidden),
  }
}

let originalRO: unknown

beforeEach(() => {
  originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  FakeResizeObserver.instances = []
})

afterEach(() => {
  if (originalRO === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  } else {
    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = originalRO
  }
})

test('no-ops gracefully when ResizeObserver is unavailable (e.g. jsdom without a polyfill)', () => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  const hooks = fakeHooks()
  const el = document.createElement('div')

  const dispose = setupResponsiveLayout(el, hooks)
  dispose() // must not throw

  expect(hooks.splitCalls).toEqual([])
  expect(hooks.sidebarCalls).toEqual([])
  expect(hooks.headerCompactCalls).toEqual([])
})

describe('with ResizeObserver available', () => {
  beforeEach(() => {
    ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  })

  test('fires setSplitSpaceHidden(true) crossing below 900px, leaves narrower thresholds untouched above their own', () => {
    const hooks = fakeHooks()
    setupResponsiveLayout(document.createElement('div'), hooks)
    const ro = FakeResizeObserver.instances[0]!

    ro.fire(1200) // wide: no threshold crossed relative to initial state (all false)
    expect(hooks.splitCalls).toEqual([])
    expect(hooks.sidebarCalls).toEqual([])
    expect(hooks.headerCompactCalls).toEqual([])

    ro.fire(850) // crosses split (900), not headerCompact (820) or sidebar (650)
    expect(hooks.splitCalls).toEqual([true])
    expect(hooks.headerCompactCalls).toEqual([])
    expect(hooks.sidebarCalls).toEqual([])
  })

  test('fires headerCompact alone crossing below 820px, above the sidebar threshold (650)', () => {
    const hooks = fakeHooks()
    setupResponsiveLayout(document.createElement('div'), hooks)
    const ro = FakeResizeObserver.instances[0]!

    ro.fire(700) // below headerCompact (820), still above sidebar (650)
    expect(hooks.headerCompactCalls).toEqual([true])
    expect(hooks.sidebarCalls).toEqual([])
  })

  test('fires all three hooks once each crossing below 650px, edge-triggered (repeat widths do not refire)', () => {
    const hooks = fakeHooks()
    setupResponsiveLayout(document.createElement('div'), hooks)
    const ro = FakeResizeObserver.instances[0]!

    ro.fire(500) // below all three thresholds
    expect(hooks.splitCalls).toEqual([true])
    expect(hooks.headerCompactCalls).toEqual([true])
    expect(hooks.sidebarCalls).toEqual([true])

    ro.fire(400) // still below all — no repeat firing
    expect(hooks.splitCalls).toEqual([true])
    expect(hooks.headerCompactCalls).toEqual([true])
    expect(hooks.sidebarCalls).toEqual([true])
  })

  test('widening back past every threshold fires each hook again with false', () => {
    const hooks = fakeHooks()
    setupResponsiveLayout(document.createElement('div'), hooks)
    const ro = FakeResizeObserver.instances[0]!

    ro.fire(500) // hides all three
    ro.fire(1000) // widens past all three thresholds again
    expect(hooks.splitCalls).toEqual([true, false])
    expect(hooks.headerCompactCalls).toEqual([true, false])
    expect(hooks.sidebarCalls).toEqual([true, false])
  })

  test('dispose() disconnects the observer', () => {
    const dispose = setupResponsiveLayout(document.createElement('div'), fakeHooks())
    const ro = FakeResizeObserver.instances[0]!
    expect(ro.disconnected).toBe(false)
    dispose()
    expect(ro.disconnected).toBe(true)
  })
})
