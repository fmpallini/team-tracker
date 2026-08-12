import { blurOnEnter, clampToViewport, createDeferredRebuild } from '../src/ui/dom'

test('blurOnEnter blurs the target on Enter, ignores other keys', () => {
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  expect(document.activeElement).toBe(input)

  blurOnEnter(new KeyboardEvent('keydown', { key: 'a' }))
  expect(document.activeElement).toBe(input) // untouched

  const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' })
  Object.defineProperty(enterEvent, 'target', { value: input })
  blurOnEnter(enterEvent)
  expect(document.activeElement).not.toBe(input)
})

describe('clampToViewport', () => {
  const originalGetRect = Element.prototype.getBoundingClientRect
  const originalInnerWidth = window.innerWidth
  const originalInnerHeight = window.innerHeight

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalGetRect
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
    document.body.innerHTML = ''
  })

  function stubRect(rect: Partial<DOMRect>): void {
    Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, toJSON: () => ({}), ...rect } as DOMRect)
  }

  test('pulls the element back inside the right/bottom edges when it overflows', () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    const el = document.createElement('div')
    document.body.appendChild(el)
    stubRect({ left: 780, right: 980, top: 580, bottom: 780, width: 200, height: 200 })

    clampToViewport(el)

    expect(parseFloat(el.style.left)).toBeLessThanOrEqual(800 - 8 - 200)
    expect(parseFloat(el.style.top)).toBeLessThanOrEqual(600 - 8 - 200)
  })

  test('leaves an element that already fits untouched', () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
    const el = document.createElement('div')
    el.style.left = '10px'
    el.style.top = '10px'
    document.body.appendChild(el)
    stubRect({ left: 10, right: 110, top: 10, bottom: 60, width: 100, height: 50 })

    clampToViewport(el)

    expect(el.style.left).toBe('10px')
    expect(el.style.top).toBe('10px')
  })
})

describe('createDeferredRebuild', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('runs the rebuild on the armed element\'s blur', () => {
    const rebuild = vi.fn()
    const deferred = createDeferredRebuild(rebuild)
    const input = document.createElement('input')
    document.body.appendChild(input)

    deferred.arm(input)
    expect(rebuild).not.toHaveBeenCalled()

    input.dispatchEvent(new FocusEvent('blur'))
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  // Regression this type exists to prevent: arming a fresh listener on every
  // skipped mutation, all on the same still-focused element, fires N full
  // rebuilds on a single blur instead of one.
  test('arming the same element repeatedly only ever arms one listener', () => {
    const rebuild = vi.fn()
    const deferred = createDeferredRebuild(rebuild)
    const input = document.createElement('input')
    document.body.appendChild(input)

    deferred.arm(input)
    deferred.arm(input)
    deferred.arm(input)
    input.dispatchEvent(new FocusEvent('blur'))

    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  test('arming a different element cancels the deferral on the previous one', () => {
    const rebuild = vi.fn()
    const deferred = createDeferredRebuild(rebuild)
    const first = document.createElement('input')
    const second = document.createElement('input')
    document.body.append(first, second)

    deferred.arm(first)
    deferred.arm(second)
    first.dispatchEvent(new FocusEvent('blur'))
    expect(rebuild).not.toHaveBeenCalled()

    second.dispatchEvent(new FocusEvent('blur'))
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  test('dispose() cancels an armed deferral without running the rebuild', () => {
    const rebuild = vi.fn()
    const deferred = createDeferredRebuild(rebuild)
    const input = document.createElement('input')
    document.body.appendChild(input)

    deferred.arm(input)
    deferred.dispose()
    input.dispatchEvent(new FocusEvent('blur'))

    expect(rebuild).not.toHaveBeenCalled()
  })

  test('dispose() with nothing armed does not throw', () => {
    const deferred = createDeferredRebuild(vi.fn())
    expect(() => deferred.dispose()).not.toThrow()
  })
})
