import { blurOnEnter, clampToViewport, clearClasses, clearRowError, createDeferredRebuild, showRowError, wheelScrollsHorizontally } from '../src/ui/dom'

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

describe('wheelScrollsHorizontally', () => {
  // jsdom has no layout: scroll geometry is whatever the test says it is.
  function scroller(g: { sw: number; cw: number; sh: number; ch: number; left?: number }): HTMLElement {
    const e = document.createElement('div')
    Object.defineProperty(e, 'scrollWidth', { value: g.sw })
    Object.defineProperty(e, 'clientWidth', { value: g.cw })
    Object.defineProperty(e, 'scrollHeight', { value: g.sh })
    Object.defineProperty(e, 'clientHeight', { value: g.ch })
    e.scrollLeft = g.left ?? 0
    return e
  }
  function wheel(e: HTMLElement, init: WheelEventInit): WheelEvent {
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    e.dispatchEvent(ev)
    return ev
  }

  test('turns vertical wheel travel into horizontal scroll and cancels the default', () => {
    const e = scroller({ sw: 1000, cw: 400, sh: 50, ch: 50 })
    wheelScrollsHorizontally(e)
    const ev = wheel(e, { deltaY: 120 })
    expect(e.scrollLeft).toBe(120)
    expect(ev.defaultPrevented).toBe(true)
  })

  test('leaves the wheel alone when there is nothing to scroll sideways, or it can scroll vertically', () => {
    const fits = scroller({ sw: 400, cw: 400, sh: 50, ch: 50 })
    wheelScrollsHorizontally(fits)
    expect(wheel(fits, { deltaY: 120 }).defaultPrevented).toBe(false)

    const tall = scroller({ sw: 1000, cw: 400, sh: 900, ch: 300 })
    wheelScrollsHorizontally(tall)
    expect(wheel(tall, { deltaY: 120 }).defaultPrevented).toBe(false)
    expect(tall.scrollLeft).toBe(0)
  })

  test('ignores horizontal deltas (trackpad/shift) and Ctrl+wheel (font size)', () => {
    const e = scroller({ sw: 1000, cw: 400, sh: 50, ch: 50 })
    wheelScrollsHorizontally(e)
    expect(wheel(e, { deltaY: 120, deltaX: 30 }).defaultPrevented).toBe(false)
    expect(wheel(e, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false)
  })

  test('lets the wheel through once the scroller is at the end it is heading for', () => {
    const atStart = scroller({ sw: 1000, cw: 400, sh: 50, ch: 50, left: 0 })
    wheelScrollsHorizontally(atStart)
    expect(wheel(atStart, { deltaY: -120 }).defaultPrevented).toBe(false)

    const atEnd = scroller({ sw: 1000, cw: 400, sh: 50, ch: 50, left: 600 })
    wheelScrollsHorizontally(atEnd)
    expect(wheel(atEnd, { deltaY: 120 }).defaultPrevented).toBe(false)
  })

  test('yieldsTo lets a nested scroller keep its own wheel, and the returned unbind detaches', () => {
    const e = scroller({ sw: 1000, cw: 400, sh: 50, ch: 50 })
    const inner = document.createElement('div')
    e.appendChild(inner)
    const unbind = wheelScrollsHorizontally(e, (target) => target === inner)
    expect(wheel(inner, { deltaY: 120 }).defaultPrevented).toBe(false)
    expect(wheel(e, { deltaY: 120 }).defaultPrevented).toBe(true)

    unbind()
    expect(wheel(e, { deltaY: 120 }).defaultPrevented).toBe(false)
  })
})

describe('clearClasses', () => {
  function list(): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = '<p class="row a b keep"></p><p class="row a"></p><p class="other a"></p>'
    return root
  }

  test('strips every named class from every selector match, and nothing else', () => {
    const root = list()

    clearClasses(root, '.row', 'a', 'b')

    const [first, second, third] = Array.from(root.children) as HTMLElement[]
    expect(first!.className).toBe('row keep')
    expect(second!.className).toBe('row')
    expect(third!.className).toBe('other a') // not matched by the selector
  })

  test('is a no-op when nothing matches or a class is absent', () => {
    const root = list()
    clearClasses(root, '.nothing', 'a')
    clearClasses(root, '.row', 'never-there')
    expect(root.innerHTML).toBe('<p class="row a b keep"></p><p class="row a"></p><p class="other a"></p>')
  })
})

describe('showRowError / clearRowError', () => {
  test('appends one field-error note carrying the message to the row', () => {
    const row = document.createElement('div')

    showRowError(row, 'my-error', 'Needs a name')

    const note = row.querySelector('.my-error') as HTMLElement
    expect(note.textContent).toBe('Needs a name')
    expect(note.className).toBe('my-error tt-field-error')
    expect(note.parentElement).toBe(row)
  })

  test('is idempotent: a second call neither duplicates nor rewrites the note', () => {
    const row = document.createElement('div')
    showRowError(row, 'my-error', 'first')
    showRowError(row, 'my-error', 'second')

    expect(row.querySelectorAll('.my-error')).toHaveLength(1)
    expect(row.querySelector('.my-error')!.textContent).toBe('first')
  })

  test('different classes coexist; clearRowError removes only its own', () => {
    const row = document.createElement('div')
    showRowError(row, 'e1', 'one')
    showRowError(row, 'e2', 'two')

    clearRowError(row, 'e1')

    expect(row.querySelector('.e1')).toBeNull()
    expect(row.querySelector('.e2')).not.toBeNull()
  })

  test('clearRowError on a row with no note is a no-op', () => {
    const row = document.createElement('div')
    expect(() => clearRowError(row, 'e1')).not.toThrow()
  })
})
