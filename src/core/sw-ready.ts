// src/core/sw-ready.ts
// Waits for a ServiceWorker to leave 'installing'/'installed' — 'activated'
// (pwa/sw.js's install handler always self.skipWaiting()s, so this is the
// signal that clients.claim() in its activate handler has also already run,
// i.e. this page is now controlled by the new worker) or 'redundant' (the
// install failed). Bounded by a timeout so a stalled install never blocks
// the caller forever. `SwLike` (not the real `ServiceWorker` DOM type) keeps
// this testable without a real ServiceWorker API, which jsdom doesn't provide.
export interface SwLike {
  readonly state: string
  addEventListener(type: 'statechange', listener: () => void): void
  removeEventListener(type: 'statechange', listener: () => void): void
}

export function waitForActivation(sw: SwLike, timeoutMs: number): Promise<void> {
  if (sw.state === 'activated' || sw.state === 'redundant') return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      sw.removeEventListener('statechange', onStateChange)
      clearTimeout(timer)
      resolve()
    }
    const onStateChange = (): void => {
      if (sw.state === 'activated' || sw.state === 'redundant') finish()
    }
    sw.addEventListener('statechange', onStateChange)
    const timer = setTimeout(finish, timeoutMs)
  })
}
