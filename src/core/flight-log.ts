// src/core/flight-log.ts — a small diagnostic log the user can save and send, for failures nobody can watch happen.
//
// Written for a crash on an installed Edge PWA right after "Allow on every visit" on the file permission prompt: the
// whole browser went down, DevTools with it, so the console was lost and nothing reached the browser's own logs. Each
// event is written to localStorage at once (synchronous, and not the IndexedDB the open path may be stuck on), so
// what happened up to the crash is still there on the next launch; the start screen's "Diagnostic log" saves it.
//
// Content-free by contract: callers log steps, outcomes, sizes and timings, never document text, people or file
// names. Error messages are kept (the code's own and the browser's), capped in length. A ring of the last MAX_EVENTS
// events across launches; every launch starts with a `launch` event naming the version and browser.

const STORAGE_KEY = 'tt-diagnostic-log'
export const MAX_EVENTS = 300
const MAX_TEXT = 300

type Detail = Record<string, string | number | boolean | null | undefined>
interface LogEvent { at: number; kind: string; detail?: Detail }

let events: LogEvent[] | null = null
let installed = false

function load(): LogEvent[] {
  if (events) return events
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    events = Array.isArray(parsed) ? (parsed as LogEvent[]) : []
  } catch {
    events = [] // no localStorage (some file:// setups), or a damaged entry: start over
  }
  return events
}

function cap(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s
}

/** Records one event. Never throws: diagnostics must not become the failure. */
export function logEvent(kind: string, detail?: Detail): void {
  try {
    const log = load()
    const clean: Detail | undefined = detail && Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === 'string' ? cap(v) : v]))
    log.push(clean ? { at: Date.now(), kind, detail: clean } : { at: Date.now(), kind })
    if (log.length > MAX_EVENTS) log.splice(0, log.length - MAX_EVENTS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log))
  } catch {
    // Quota or no storage: the event stays in memory for this page only.
  }
}

/** An error as name + message (+ the first stack frames), for an event's detail. */
export function describeError(e: unknown): Detail {
  if (e instanceof Error) {
    const stack = e.stack?.split('\n').slice(1, 4).map((l) => l.trim()).join(' | ')
    return { error: e.name, message: e.message, stack }
  }
  return { error: typeof e, message: String(e) }
}

/** The page's JavaScript heap in MB where the browser reports it (Chromium's non-standard performance.memory). */
export function heapMb(): number | undefined {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined
}

/** Ms since `start`, for timing a step. */
export function since(start: number): number {
  return Math.round(performance.now() - start)
}

/**
 * Starts this launch's part of the log and catches what the code itself doesn't: uncaught errors and unhandled
 * rejections. Called once, from main.ts, before anything else runs.
 */
export function installFlightLog(version: string): void {
  if (installed) return
  installed = true
  logEvent('launch', {
    version,
    standalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches,
    ua: navigator.userAgent,
    heapMb: heapMb(),
  })
  window.addEventListener('error', (e) => {
    logEvent('uncaught', { ...describeError(e.error ?? e.message), at: `${e.filename.split('/').pop() ?? ''}:${e.lineno}:${e.colno}` })
  })
  window.addEventListener('unhandledrejection', (e) => logEvent('unhandled-rejection', describeError(e.reason)))
  document.addEventListener('visibilitychange', () => logEvent('visibility', { state: document.visibilityState }))
  window.addEventListener('pagehide', () => logEvent('pagehide'))
  // Most of the app's handled failures end in console.error (a registry that failed, a write that threw), which is
  // exactly what was lost when the browser went down with DevTools open.
  const consoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    const err = args.find((a) => a instanceof Error)
    logEvent('console-error', err ? describeError(err) : { message: args.map(String).join(' ') })
    consoleError(...args)
  }
}

/** The log as plain text, one event per line, oldest first. */
export function flightLogText(): string {
  return load()
    .map((e) => {
      const detail = e.detail
        ? Object.entries(e.detail).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : String(v)}`).join(' ')
        : ''
      return `${new Date(e.at).toISOString()} ${e.kind}${detail ? ' ' + detail : ''}`
    })
    .join('\n') + '\n'
}

/** The log as a download, named with the moment it was saved. */
export function flightLogFileName(now = new Date()): string {
  return `team-tracker-diagnostics-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.txt`
}

/** Test seam: forget the in-memory copy so the next call reads storage afresh. */
export function resetFlightLogForTests(): void {
  events = null
}
