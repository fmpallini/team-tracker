// src/core/flight-log.ts — a small diagnostic log the user can save and send, for failures nobody can watch happen.
//
// Written for a crash on an installed Edge PWA right after "Allow on every visit" on the file permission prompt: the
// whole browser went down, DevTools with it, so the console was lost and nothing reached the browser's own logs. Each
// event is written to localStorage at once (synchronous, and not the IndexedDB the open path may be stuck on), so
// what happened up to the crash is still there on the next launch; the start screen's "Diagnostic log" saves it.
//
// Content-free by contract: callers log steps, outcomes, sizes and timings, never document text, people or file
// names. Error messages are kept (the code's own and the browser's), capped in length. A ring of the last MAX_EVENTS
// events across launches; every launch starts with a `launch` event naming the version and browser, then a
// `previous-run` event saying how the last run ended. A crash leaves no event of its own, so a heartbeat (a single
// overwritten timestamp, startHeartbeat) dates it, and window focus, titlebar geometry and long tasks show what the
// browser and the page were doing around it. localStorage reaches disk a few seconds after each write, so the very
// last moment before a browser crash can still be missing; the heartbeat bounds that gap.

const STORAGE_KEY = 'tt-diagnostic-log'
/** The last heartbeat, kept apart from the ring (see startHeartbeat). */
const ALIVE_KEY = 'tt-diagnostic-alive'
export const MAX_EVENTS = 300
const MAX_TEXT = 300
export const HEARTBEAT_MS = 2_000
const LONG_TASK_MS = 300

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
  // Read before this launch's first heartbeat overwrites it, and before `launch` becomes the last event.
  const previous = previousRun()
  logEvent('launch', {
    version,
    standalone: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches,
    ua: navigator.userAgent,
    heapMb: heapMb(),
  })
  if (previous) logEvent('previous-run', previous)
  // Each watcher leans on a browser API that may be missing or partial (a stand-in windowControlsOverlay without
  // addEventListener once kept the whole app from starting): one that throws is logged and skipped, never fatal.
  for (const watch of [startHeartbeat, watchLongTasks, watchTitlebar]) {
    try {
      watch()
    } catch (e) {
      logEvent('diagnostics-unavailable', { watch: watch.name, ...describeError(e) })
    }
  }
  // Edge's own UI coming up over the page (a permission bubble, a titlebar icon) takes focus or reshapes the titlebar.
  window.addEventListener('focus', () => logEvent('window-focus'))
  window.addEventListener('blur', () => logEvent('window-blur'))
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

/**
 * How the last run ended. Its last heartbeat says when it was still alive (to HEARTBEAT_MS) even though a crash leaves
 * no event; its last event says whether it closed normally (pagehide) and what it did last. Null on a first launch.
 */
function previousRun(): Detail | null {
  const alive = lastHeartbeat()
  const last = load().at(-1)
  if (!alive && !last) return null
  return {
    lastAlive: alive ? new Date(alive.at).toISOString() : null,
    lastAliveHeapMb: alive?.heapMb,
    lastEvent: last?.kind,
    secondsAliveAfterLastEvent: alive && last ? Math.round((alive.at - last.at) / 1000) : undefined,
    closedNormally: last?.kind === 'pagehide',
  }
}

function lastHeartbeat(): { at: number; heapMb?: number } | null {
  try {
    return JSON.parse(localStorage.getItem(ALIVE_KEY) ?? 'null') as { at: number; heapMb?: number } | null
  } catch {
    return null // unreadable: the log alone says what it can
  }
}

/**
 * Overwrites one "still alive" timestamp every HEARTBEAT_MS, outside the ring so it never pushes events out. A tick
 * that comes far too late while the page is visible means the page itself froze (hidden pages are throttled anyway).
 */
function startHeartbeat(): void {
  let lastTick = Date.now()
  let wasVisible = document.visibilityState === 'visible'
  const beat = (): void => {
    const now = Date.now()
    const visible = document.visibilityState === 'visible'
    if (visible && wasVisible && now - lastTick > HEARTBEAT_MS * 3) logEvent('page-froze', { seconds: Math.round((now - lastTick) / 1000) })
    lastTick = now
    wasVisible = visible
    try {
      localStorage.setItem(ALIVE_KEY, JSON.stringify({ at: now, heapMb: heapMb() }))
    } catch { /* no storage: the log still has its events */ }
  }
  beat()
  setInterval(beat, HEARTBEAT_MS)
}

/** Main-thread tasks long enough for a user to notice, where the browser reports them. */
function watchLongTasks(): void {
  if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration >= LONG_TASK_MS) logEvent('long-task', { ms: Math.round(entry.duration) })
    }
  }).observe({ type: 'longtask' })
}

/**
 * The installed app's titlebar (window-controls-overlay): Edge's own controls and indicators sit beside the area the
 * app draws in, so one appearing there changes this geometry. Logged when it settles and only when it differs from the
 * last one logged, so dragging the window's edge adds an event or two, not one per frame.
 */
function watchTitlebar(): void {
  const wco = (navigator as Navigator & { windowControlsOverlay?: EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay
  if (!wco) return
  let logged = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const record = (): void => {
    const r = wco.getTitlebarAreaRect()
    const shape = `${wco.visible} ${Math.round(r.x)} ${Math.round(r.width)} ${Math.round(r.height)}`
    if (shape === logged) return
    logged = shape
    logEvent('titlebar', { visible: wco.visible, x: Math.round(r.x), width: Math.round(r.width), height: Math.round(r.height), window: window.innerWidth })
  }
  record()
  wco.addEventListener('geometrychange', () => {
    clearTimeout(timer)
    timer = setTimeout(record, 300)
  })
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
