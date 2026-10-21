import { installBlurSave, BLUR_SAVE_DELAY_MS } from '../src/core/blur-save'

let dispose: (() => void) | null = null

function install(hasFocus: () => boolean, delayMs?: number): { save: ReturnType<typeof vi.fn> } {
  const save = vi.fn()
  dispose = installBlurSave({ save, hasFocus, delayMs })
  return { save }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  dispose?.()
  dispose = null
  vi.useRealTimers()
})

test('saves once the delay elapses while focus is still elsewhere', () => {
  const { save } = install(() => false)

  window.dispatchEvent(new Event('blur'))
  expect(save).not.toHaveBeenCalled()

  vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS)

  expect(save).toHaveBeenCalledTimes(1)
})

test('focus returning before the delay cancels the save entirely', () => {
  const { save } = install(() => true)

  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS - 1)
  window.dispatchEvent(new Event('focus'))
  vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS * 2)

  expect(save).not.toHaveBeenCalled()
})

test('does not save if focus came back without a focus event firing', () => {
  // Defense in depth for the timer: the hasFocus() re-check at fire time is
  // what makes a missed/never-delivered focus event harmless.
  const { save } = install(() => true)

  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS)

  expect(save).not.toHaveBeenCalled()
})

test('repeated blurs without an intervening focus do not restart the countdown', () => {
  const { save } = install(() => false, 1000)

  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(900)
  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(100)

  expect(save).toHaveBeenCalledTimes(1)
})

test('a later blur arms a fresh countdown after the previous one fired', () => {
  const { save } = install(() => false, 1000)

  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(1000)
  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(1000)

  expect(save).toHaveBeenCalledTimes(2)
})

test('dispose clears a pending timer and unregisters both listeners', () => {
  const { save } = install(() => false)

  window.dispatchEvent(new Event('blur'))
  dispose!()
  dispose = null
  vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS * 2)
  window.dispatchEvent(new Event('blur'))
  vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS * 2)

  expect(save).not.toHaveBeenCalled()
})

describe('tab hidden (merged into the same away-save timer)', () => {
  const setVisibility = (state: 'hidden' | 'visible'): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  afterEach(() => setVisibility('visible'))

  test('hiding the tab arms the timer and saves after the delay if still away', () => {
    const { save } = install(() => false)
    setVisibility('hidden')
    expect(save).not.toHaveBeenCalled() // never immediately
    vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('coming back before the delay cancels it', () => {
    const { save } = install(() => false)
    setVisibility('hidden')
    vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS - 1)
    setVisibility('visible')
    vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS * 2)
    expect(save).not.toHaveBeenCalled()
  })

  test('blur and hidden together arm only one timer', () => {
    const { save } = install(() => false)
    window.dispatchEvent(new Event('blur'))
    setVisibility('hidden')
    vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('dispose stops listening for visibility changes', () => {
    const { save } = install(() => false)
    dispose!()
    dispose = null
    setVisibility('hidden')
    vi.advanceTimersByTime(BLUR_SAVE_DELAY_MS * 2)
    expect(save).not.toHaveBeenCalled()
  })
})
