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
  calendarCalls: boolean[]
} {
  const splitCalls: boolean[] = []
  const sidebarCalls: boolean[] = []
  const headerCompactCalls: boolean[] = []
  const calendarCalls: boolean[] = []
  return {
    splitCalls,
    sidebarCalls,
    headerCompactCalls,
    calendarCalls,
    setSplitSpaceHidden: (hidden) => splitCalls.push(hidden),
    setSidebarSpaceHidden: (hidden) => sidebarCalls.push(hidden),
    setHeaderCompactSpaceHidden: (hidden) => headerCompactCalls.push(hidden),
    setCalendarSpaceHidden: (hidden) => calendarCalls.push(hidden),
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

    ro.fire(850) // crosses split (900), not headerCompact (840) or sidebar (650)
    expect(hooks.splitCalls).toEqual([true])
    expect(hooks.headerCompactCalls).toEqual([])
    expect(hooks.sidebarCalls).toEqual([])
  })

  test('fires headerCompact alone crossing below 840px, above the sidebar threshold (650)', () => {
    const hooks = fakeHooks()
    setupResponsiveLayout(document.createElement('div'), hooks)
    const ro = FakeResizeObserver.instances[0]!

    ro.fire(700) // below headerCompact (840), still above sidebar (650)
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

  test('fires setCalendarSpaceHidden(true) crossing below 560px, below the sidebar threshold (650)', () => {
    const hooks = fakeHooks()
    setupResponsiveLayout(document.createElement('div'), hooks)
    const ro = FakeResizeObserver.instances[0]!

    ro.fire(600) // below sidebar (650) but still above the calendar threshold (560)
    expect(hooks.calendarCalls).toEqual([])

    ro.fire(500) // below 560
    expect(hooks.calendarCalls).toEqual([true])

    ro.fire(700) // widen back above 560
    expect(hooks.calendarCalls).toEqual([true, false])
  })

  test('dispose() disconnects the observer', () => {
    const dispose = setupResponsiveLayout(document.createElement('div'), fakeHooks())
    const ro = FakeResizeObserver.instances[0]!
    expect(ro.disconnected).toBe(false)
    dispose()
    expect(ro.disconnected).toBe(true)
  })

  describe('header compact threshold follows the text size', () => {
    afterEach(() => {
      delete document.documentElement.dataset.size
    })

    test('at XL the header goes compact at a width where M still fits it (840 × 1.2 = 1008)', () => {
      document.documentElement.dataset.size = 'XL'
      const hooks = fakeHooks()
      setupResponsiveLayout(document.createElement('div'), hooks)
      const ro = FakeResizeObserver.instances[0]!

      ro.fire(950) // between 840 and 1008
      expect(hooks.headerCompactCalls).toEqual([true])
      expect(hooks.splitCalls).toEqual([]) // the other thresholds are untouched
    })

    test('at M, and below, the threshold stays 840', () => {
      for (const size of ['M', 'XS']) {
        document.documentElement.dataset.size = size
        FakeResizeObserver.instances = []
        const hooks = fakeHooks()
        setupResponsiveLayout(document.createElement('div'), hooks)
        const ro = FakeResizeObserver.instances[0]!
        ro.fire(850)
        expect(hooks.headerCompactCalls).toEqual([])
        ro.fire(830)
        expect(hooks.headerCompactCalls).toEqual([true])
      }
    })

    test('changing the size re-evaluates against the last width, without a resize', async () => {
      document.documentElement.dataset.size = 'M'
      const hooks = fakeHooks()
      const dispose = setupResponsiveLayout(document.createElement('div'), hooks)
      FakeResizeObserver.instances[0]!.fire(900)
      expect(hooks.headerCompactCalls).toEqual([])

      document.documentElement.dataset.size = 'XL'
      await Promise.resolve() // MutationObserver callbacks run as a microtask
      expect(hooks.headerCompactCalls).toEqual([true])

      document.documentElement.dataset.size = 'M'
      await Promise.resolve()
      expect(hooks.headerCompactCalls).toEqual([true, false])
      dispose()
    })
  })
})
