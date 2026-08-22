// src/core/debug-log.ts — a small, crash-surviving breadcrumb trail.
// Diagnostic only, added to investigate a reported installed-PWA crash on
// "reopen last file" that kills the page (and its devtools) before any
// console output can be read. `localStorage.setItem` is synchronous and
// already durable by the time it returns, so entries written right before a
// hard crash are still there on the next launch — unlike console.log, which
// dies with the page. Every read/write is wrapped: logging must never itself
// throw or block the flow it's instrumenting (private browsing, full quota).
const KEY = 'tt-debug-log'
const MAX_ENTRIES = 80

interface LogEntry {
  t: number
  scope: string
  msg: string
}

function readEntries(): LogEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as LogEntry[]) : []
  } catch {
    return []
  }
}

export function logEvent(scope: string, msg: string): void {
  // Best-effort mirror to the live console — free when devtools happens to
  // survive long enough to show it, irrelevant (and harmless) when it doesn't.
  console.log(`[tt-debug] ${scope}: ${msg}`)
  try {
    const entries = readEntries()
    entries.push({ t: Date.now(), scope, msg })
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
  } catch {
    // See file header — logging failures must stay silent.
  }
}

/** Formatted for pasting into a bug report — one line per entry, oldest first. */
export function readDebugLog(): string {
  return readEntries()
    .map((e) => `${new Date(e.t).toISOString()} [${e.scope}] ${e.msg}`)
    .join('\n')
}

export function clearDebugLog(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // See file header.
  }
}
