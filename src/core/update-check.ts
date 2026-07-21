// src/core/update-check.ts
export const LAST_CHECK_STORAGE_KEY = 'tt-last-update-check'

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
