import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitForActivation, type SwLike } from '../src/core/sw-ready'

function fakeSw(initialState: string): SwLike & { setState(s: string): void } {
  const listeners = new Set<() => void>()
  let state = initialState
  return {
    get state() {
      return state
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener)
    },
    setState(s: string) {
      state = s
      for (const l of Array.from(listeners)) l()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForActivation', () => {
  it('resolves immediately if already activated', async () => {
    const sw = fakeSw('activated')
    let resolved = false
    void waitForActivation(sw, 15000).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('resolves once the worker reaches "activated"', async () => {
    const sw = fakeSw('installing')
    let resolved = false
    void waitForActivation(sw, 15000).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)
    sw.setState('activated')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('resolves if the worker becomes "redundant" (install failed)', async () => {
    const sw = fakeSw('installing')
    let resolved = false
    void waitForActivation(sw, 15000).then(() => {
      resolved = true
    })
    sw.setState('redundant')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('does not resolve on an unrelated state (e.g. "installed"/waiting)', async () => {
    const sw = fakeSw('installing')
    let resolved = false
    void waitForActivation(sw, 15000).then(() => {
      resolved = true
    })
    sw.setState('installed')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)
  })

  it('resolves via the timeout if activation never happens', async () => {
    const sw = fakeSw('installing')
    let resolved = false
    void waitForActivation(sw, 15000).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(14999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })

  it('ignores a state change that arrives after the timeout already fired', async () => {
    const sw = fakeSw('installing')
    let resolveCount = 0
    void waitForActivation(sw, 15000).then(() => {
      resolveCount++
    })
    await vi.advanceTimersByTimeAsync(15000)
    expect(resolveCount).toBe(1)
    sw.setState('activated')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCount).toBe(1)
  })
})
