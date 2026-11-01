import { describe, it, expect, vi } from 'vitest'
import { shouldCheck, isNewer, checkForUpdate, updateCheckEnabled, setUpdateCheckEnabled, createManualUpdateCheck, MANUAL_CHECK_COOLDOWN_MS, LAST_CHECK_STORAGE_KEY, UPDATE_CHECK_OFF_STORAGE_KEY, type UpdateCheckResult } from '../src/core/update-check'

describe('shouldCheck', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('is true when there is no prior timestamp', () => {
    expect(shouldCheck(null, Date.now())).toBe(true)
  })

  it('is true when the timestamp is unparseable', () => {
    expect(shouldCheck('not-a-date', Date.now())).toBe(true)
  })

  it('is false just under 24h since the last check', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    const last = new Date(now - DAY_MS + 1000).toISOString()
    expect(shouldCheck(last, now)).toBe(false)
  })

  it('is true at exactly 24h since the last check', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    const last = new Date(now - DAY_MS).toISOString()
    expect(shouldCheck(last, now)).toBe(true)
  })

  it('is true well past 24h since the last check', () => {
    const now = Date.parse('2026-07-21T12:00:00.000Z')
    const last = new Date(now - DAY_MS * 3).toISOString()
    expect(shouldCheck(last, now)).toBe(true)
  })
})

describe('isNewer', () => {
  it('is true when the tag is a newer patch', () => {
    expect(isNewer('v1.5.3', '1.5.2')).toBe(true)
  })

  it('is true when the tag is a newer minor/major', () => {
    expect(isNewer('v1.6.0', '1.5.2')).toBe(true)
    expect(isNewer('v2.0.0', '1.5.2')).toBe(true)
  })

  it('is false when the tag equals the current version', () => {
    expect(isNewer('v1.5.2', '1.5.2')).toBe(false)
  })

  it('is false when the tag is older', () => {
    expect(isNewer('v1.4.9', '1.5.2')).toBe(false)
  })

  it('handles a tag with no leading v', () => {
    expect(isNewer('1.5.3', '1.5.2')).toBe(true)
  })
})

describe('checkForUpdate', () => {
  const REPO = 'fmpallini/team-tracker'

  it('returns status "newer" with the version when the tag is ahead', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v9.9.9' }),
    })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'newer', version: '9.9.9' })
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.github.com/repos/${REPO}/releases/latest`)
  })

  it('returns status "up-to-date" when the tag matches the current version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v1.5.2' }),
    })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'up-to-date' })
  })

  it('returns status "error" on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'error' })
  })

  it('returns status "error" when fetch throws (offline)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'error' })
  })

  it('returns status "error" on malformed JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ no_tag_here: true }) })
    const result = await checkForUpdate(fetchImpl as unknown as typeof fetch, '1.5.2', REPO)
    expect(result).toEqual({ status: 'error' })
  })
})

it('exports the localStorage key used for the 24h gate', () => {
  expect(LAST_CHECK_STORAGE_KEY).toBe('tt-last-update-check')
})

describe('the update-check setting', () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

  test('is on by default and remembers being turned off and on again', () => {
    expect(updateCheckEnabled()).toBe(true)
    setUpdateCheckEnabled(false)
    expect(localStorage.getItem(UPDATE_CHECK_OFF_STORAGE_KEY)).toBe('1')
    expect(updateCheckEnabled()).toBe(false)
    setUpdateCheckEnabled(true)
    expect(localStorage.getItem(UPDATE_CHECK_OFF_STORAGE_KEY)).toBeNull()
    expect(updateCheckEnabled()).toBe(true)
  })

  test('storage that cannot be used leaves the check on and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    expect(updateCheckEnabled()).toBe(true)
    expect(() => setUpdateCheckEnabled(false)).not.toThrow()
  })
})

describe('createManualUpdateCheck (the About tab\'s "Check now")', () => {
  function rig(results: UpdateCheckResult[] = [{ status: 'up-to-date' }]) {
    let now = 1_000_000
    const queue = [...results]
    const run = vi.fn(async () => queue.shift() ?? { status: 'up-to-date' as const })
    const check = createManualUpdateCheck(run, () => now)
    return { check, run, advance: (ms: number) => { now += ms } }
  }

  it('runs the check and remembers its result', async () => {
    const { check, run } = rig([{ status: 'newer', version: '9.0.0' }])
    expect(check.lastResult).toBeNull()
    expect(await check.run()).toEqual({ status: 'newer', version: '9.0.0' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(check.lastResult).toEqual({ status: 'newer', version: '9.0.0' })
  })

  it('refuses another check until the cooldown has passed, whatever the result was', async () => {
    const { check, run, advance } = rig([{ status: 'error' }, { status: 'up-to-date' }])
    await check.run()
    expect(check.remainingMs()).toBe(MANUAL_CHECK_COOLDOWN_MS)
    expect(await check.run()).toBeNull()
    advance(MANUAL_CHECK_COOLDOWN_MS - 1)
    expect(await check.run()).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    advance(1)
    expect(check.remainingMs()).toBe(0)
    expect(await check.run()).toEqual({ status: 'up-to-date' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('clicks while a check is in flight share it instead of starting another', async () => {
    const { check, run } = rig()
    const a = check.run()
    expect(check.running).toBe(true)
    const b = check.run()
    expect(await a).toEqual({ status: 'up-to-date' })
    expect(await b).toEqual({ status: 'up-to-date' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(check.running).toBe(false)
  })
})
