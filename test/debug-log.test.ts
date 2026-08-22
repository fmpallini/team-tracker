import { logEvent, readDebugLog, clearDebugLog } from '../src/core/debug-log'

beforeEach(() => {
  localStorage.clear()
})

test('logEvent persists entries readable via readDebugLog, oldest first', () => {
  logEvent('scope-a', 'first')
  logEvent('scope-b', 'second')
  const log = readDebugLog()
  const lines = log.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('[scope-a] first')
  expect(lines[1]).toContain('[scope-b] second')
})

test('readDebugLog is empty when nothing has been logged', () => {
  expect(readDebugLog()).toBe('')
})

test('clearDebugLog empties the log', () => {
  logEvent('scope-a', 'first')
  clearDebugLog()
  expect(readDebugLog()).toBe('')
})

test('caps at the most recent entries instead of growing unbounded', () => {
  for (let i = 0; i < 90; i++) logEvent('scope', `entry-${i}`)
  const lines = readDebugLog().split('\n')
  expect(lines).toHaveLength(80)
  expect(lines[0]).toContain('entry-10')
  expect(lines[lines.length - 1]).toContain('entry-89')
})

test('logEvent never throws even if localStorage is unavailable', () => {
  const original = window.localStorage
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage disabled')
    },
  })
  try {
    expect(() => logEvent('scope', 'msg')).not.toThrow()
  } finally {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: original })
  }
})
