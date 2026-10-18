import { watchDayChange } from '../src/ui/day-change'

const visible = (): void => { document.dispatchEvent(new Event('visibilitychange')) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 14, 23, 0))
})
afterEach(() => { vi.useRealTimers() })

test('fires when the tab becomes visible on a new calendar day', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  visible()
  expect(onNewDay).toHaveBeenCalledTimes(1)
  stop()
})

test('fires on window focus too', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).toHaveBeenCalledTimes(1)
  stop()
})

test('does not fire on a return within the same day', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 14, 23, 59))
  visible()
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).not.toHaveBeenCalled()
  stop()
})

test('fires once per new day, not on every return that day', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  visible()
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).toHaveBeenCalledTimes(1)
  stop()
})

test('ignores the event that hides the tab', () => {
  const onNewDay = vi.fn()
  const stop = watchDayChange(onNewDay)
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  visible()
  spy.mockRestore()
  expect(onNewDay).not.toHaveBeenCalled()
  stop()
})

test('the returned function removes both listeners', () => {
  const onNewDay = vi.fn()
  watchDayChange(onNewDay)()
  vi.setSystemTime(new Date(2026, 9, 15, 8, 0))
  visible()
  window.dispatchEvent(new Event('focus'))
  expect(onNewDay).not.toHaveBeenCalled()
})
