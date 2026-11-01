// src/core/update-check.ts
export const LAST_CHECK_STORAGE_KEY = 'tt-last-update-check'
/**
 * Set to '1' when the user turned the update check off. Kept in this browser, not in a document: the check runs at
 * launch, before any file is open, and it is about this install rather than about a team file.
 */
export const UPDATE_CHECK_OFF_STORAGE_KEY = 'tt-update-check-off'

/** True unless the user turned the check off. Storage that cannot be read (a strict privacy mode) leaves it on. */
export function updateCheckEnabled(): boolean {
  try {
    return localStorage.getItem(UPDATE_CHECK_OFF_STORAGE_KEY) !== '1'
  } catch {
    return true
  }
}

export function setUpdateCheckEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(UPDATE_CHECK_OFF_STORAGE_KEY)
    else localStorage.setItem(UPDATE_CHECK_OFF_STORAGE_KEY, '1')
  } catch {
    // Strict privacy modes: the choice just doesn't persist.
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

export function shouldCheck(lastCheckIso: string | null, now: number): boolean {
  if (lastCheckIso === null) return true
  const last = Date.parse(lastCheckIso)
  if (Number.isNaN(last)) return true
  return now - last >= DAY_MS
}

function parseVersion(v: string): [number, number, number] | null {
  const stripped = v.startsWith('v') ? v.slice(1) : v
  const parts = stripped.split('.')
  if (parts.length !== 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  return nums as [number, number, number]
}

export function isNewer(latestTag: string, currentVersion: string): boolean {
  const latest = parseVersion(latestTag)
  const current = parseVersion(currentVersion)
  if (latest === null || current === null) return false
  const [latestMajor, latestMinor, latestPatch] = latest
  const [currentMajor, currentMinor, currentPatch] = current
  if (latestMajor > currentMajor) return true
  if (latestMajor < currentMajor) return false
  if (latestMinor > currentMinor) return true
  if (latestMinor < currentMinor) return false
  if (latestPatch > currentPatch) return true
  if (latestPatch < currentPatch) return false
  return false
}

export type UpdateCheckResult = { status: 'newer'; version: string } | { status: 'up-to-date' } | { status: 'error' }

/**
 * How long "Check now" (Preferences → About) stays off after a check, whatever it found. GitHub allows 60
 * unauthenticated calls an hour per address, and a check can only find something new once a release is out.
 */
export const MANUAL_CHECK_COOLDOWN_MS = 60_000

export interface ManualUpdateCheck {
  /** Checks now; resolves with the result, or null when the cooldown refused it. A click while one runs shares it. */
  run(): Promise<UpdateCheckResult | null>
  readonly running: boolean
  /** The last check's result (null: none yet), so a reopened About tab can still say it. */
  readonly lastResult: UpdateCheckResult | null
  /** Milliseconds until another check is allowed (0: now). */
  remainingMs(): number
}

/**
 * The manual check: single-flight and rate-limited. One per page (main.ts), not per Preferences window, so reopening
 * the window does not reset the cooldown.
 */
export function createManualUpdateCheck(check: () => Promise<UpdateCheckResult>, now: () => number = Date.now): ManualUpdateCheck {
  let inFlight: Promise<UpdateCheckResult> | null = null
  let lastAt = -Infinity
  let lastResult: UpdateCheckResult | null = null
  const remainingMs = (): number => Math.max(0, lastAt + MANUAL_CHECK_COOLDOWN_MS - now())
  return {
    run() {
      if (inFlight) return inFlight
      if (remainingMs() > 0) return Promise.resolve(null)
      inFlight = check()
        .catch((e: unknown): UpdateCheckResult => { console.error(e); return { status: 'error' } })
        .then((result) => {
          lastResult = result
          lastAt = now()
          inFlight = null
          return result
        })
      return inFlight
    },
    get running() { return inFlight !== null },
    get lastResult() { return lastResult },
    remainingMs,
  }
}

export async function checkForUpdate(
  fetchImpl: typeof fetch,
  currentVersion: string,
  repo: string
): Promise<UpdateCheckResult> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`)
    if (!res.ok) return { status: 'error' }
    const body = (await res.json()) as { tag_name?: unknown }
    if (typeof body.tag_name !== 'string') return { status: 'error' }
    const version = body.tag_name.startsWith('v') ? body.tag_name.slice(1) : body.tag_name
    if (!parseVersion(version)) return { status: 'error' }
    return isNewer(body.tag_name, currentVersion) ? { status: 'newer', version } : { status: 'up-to-date' }
  } catch (e) {
    console.error(e)
    return { status: 'error' }
  }
}
