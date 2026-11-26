// src/core/stall.ts — a deadline for browser calls that should answer at once but can, rarely, never answer at all.
//
// IndexedDB and Web Locks have no timeout of their own. A wedged storage backend (seen on an installed PWA right after
// the browser updated and relaunched it) leaves `indexedDB.open()` or a queued `locks.request()` pending forever: no
// event, no error, nothing in the console. Worse, the app caches the pending connection and serializes on the lock, so
// every later open queued behind the first one and the start screen silently ignored the user until site data was
// cleared. A deadline turns that hang into an error the caller can handle: fall back, or tell the user what to do.
//
// Only for calls that need no user input and normally settle in milliseconds. Never wrap a picker, a permission
// prompt, a password prompt or a file read (a cloud-synced file can legitimately take a while to arrive).
import { heapMb, logEvent } from './flight-log'

/** Generous next to the milliseconds these calls take, so a slow but healthy start never trips it. */
export const STALL_MS = 15_000

/** The step that never answered. Its message names the step, so the console says where an open got stuck. */
export class StallError extends Error {
  constructor(readonly step: string, ms: number) {
    super(`${step} did not answer within ${ms / 1000} s`)
    this.name = 'StallError'
  }
}

/**
 * Settles like `promise`, or rejects with a StallError after `ms`. The call itself cannot be cancelled: when it does
 * answer after the deadline, `onLate` gets its value so the caller can release it (close a database it opened).
 */
export function stall<T>(promise: Promise<T>, step: string, opts: { ms?: number; onLate?: (value: T) => void } = {}): Promise<T> {
  const ms = opts.ms ?? STALL_MS
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      logEvent('stall', { step, ms, heapMb: heapMb() })
      reject(new StallError(step, ms))
    }, ms)
  })
  promise.then((value) => { if (timedOut) opts.onLate?.(value) }, () => { /* reported by the race below while it counts */ })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
