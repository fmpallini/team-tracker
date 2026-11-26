import { describeError, flightLogFileName, flightLogText, installFlightLog, logEvent, MAX_EVENTS, resetFlightLogForTests } from '../src/core/flight-log'
import { stall, StallError } from '../src/core/stall'

const KEY = 'tt-diagnostic-log'
const stored = (): { kind: string; detail?: Record<string, unknown> }[] => JSON.parse(localStorage.getItem(KEY) ?? '[]')
const kinds = (): string[] => stored().map((e) => e.kind)

const originalConsoleError = console.error

beforeEach(() => {
  localStorage.clear()
  resetFlightLogForTests()
})
afterAll(() => {
  console.error = originalConsoleError
})

test('each event is in storage at once, so it survives a crash right after', () => {
  logEvent('permission-answer', { state: 'granted', ms: 12 })
  expect(stored()).toEqual([expect.objectContaining({ kind: 'permission-answer', detail: { state: 'granted', ms: 12 } })])
})

test('keeps only the newest events, carrying earlier launches over', () => {
  logEvent('from-last-launch')
  resetFlightLogForTests() // a new page reads what the last one left
  for (let i = 0; i < MAX_EVENTS; i++) logEvent('step', { i })
  const log = stored()
  expect(log).toHaveLength(MAX_EVENTS)
  expect(log[0]!.detail).toEqual({ i: 0 })
  expect(kinds()).not.toContain('from-last-launch')
})

test('caps long strings and survives a damaged entry or a full storage', () => {
  logEvent('x', { message: 'a'.repeat(1000) })
  expect((stored()[0]!.detail!.message as string).length).toBeLessThan(310)

  localStorage.setItem(KEY, '{not json')
  resetFlightLogForTests()
  logEvent('after-damage')
  expect(kinds()).toEqual(['after-damage'])

  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  expect(() => logEvent('no-room')).not.toThrow()
  setItem.mockRestore()
})

test('the text is one line per event with its details', () => {
  logEvent('file-read', { kb: 512, heapMb: undefined })
  logEvent('open-failed', describeError(new TypeError('handle went away')))
  const lines = flightLogText().trim().split('\n')
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z file-read kb=512$/)
  expect(lines[1]).toContain('open-failed error=TypeError message="handle went away"')
})

test('a stall deadline is logged with the step that never answered', async () => {
  vi.useFakeTimers()
  try {
    const pending = stall(new Promise(() => {}), 'file id registry', { ms: 50 })
    vi.advanceTimersByTime(50)
    await expect(pending).rejects.toBeInstanceOf(StallError)
  } finally {
    vi.useRealTimers()
  }
  expect(stored()[0]).toEqual(expect.objectContaining({ kind: 'stall', detail: expect.objectContaining({ step: 'file id registry', ms: 50 }) }))
})

test('installing logs the launch and catches errors the code did not handle, once', () => {
  const forwarded = vi.fn()
  console.error = forwarded
  installFlightLog('9.9.9')
  installFlightLog('9.9.9') // a second call adds nothing

  window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('boom'), message: 'boom', filename: 'https://x/app.js', lineno: 3, colno: 7 }))
  const rejection = new Event('unhandledrejection') as Event & { reason?: unknown }
  rejection.reason = new Error('lost promise')
  window.dispatchEvent(rejection)
  const failure = new Error('registry failed')
  console.error(failure)

  expect(kinds()).toEqual(['launch', 'uncaught', 'unhandled-rejection', 'console-error'])
  const log = stored()
  expect(log[0]!.detail).toEqual(expect.objectContaining({ version: '9.9.9' }))
  expect(log[1]!.detail).toEqual(expect.objectContaining({ error: 'RangeError', message: 'boom', at: 'app.js:3:7' }))
  expect(log[2]!.detail).toEqual(expect.objectContaining({ message: 'lost promise' }))
  expect(log[3]!.detail).toEqual(expect.objectContaining({ message: 'registry failed' }))
  expect(forwarded).toHaveBeenCalledWith(failure) // still reaches the real console
})

test('the download is named by when it was saved', () => {
  expect(flightLogFileName(new Date('2026-11-26T17:05:00Z'))).toBe('team-tracker-diagnostics-20261126-1705.txt')
})
