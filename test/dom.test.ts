import { el, blurOnEnter, clampToViewport, clearClasses, clearRowError, copyText, createDeferredRebuild, keepRowFocus, neighbourRowId, rovingRows, saveFocus, showRowError, wheelScrollsHorizontally } from '../src/ui/dom'

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

describe('copyText', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard
  })
  function setClipboard(value: unknown): void {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
  }
  function stubExecCommand(): { calls: string[]; copied: string[] } {
    const calls: string[] = []
    const copied: string[] = []
    ;(document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = (cmd: string) => {
      calls.push(cmd)
      copied.push(document.querySelector('textarea')?.value ?? '')
      return true
    }
    return { calls, copied }
  }

  test('writes through the async Clipboard API when it is there', async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    const exec = stubExecCommand()
    copyText('hello')
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(exec.calls).toEqual([])
  })

  test('falls back to a hidden textarea + execCommand("copy") when the API rejects, and cleans it up', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('denied') }) })
    const exec = stubExecCommand()
    copyText('hello')
    await Promise.resolve()
    await Promise.resolve()
    expect(exec.calls).toEqual(['copy'])
    expect(exec.copied).toEqual(['hello'])
    expect(document.querySelector('textarea')).toBeNull()
  })

  test('falls back the same way when there is no Clipboard API at all (file://)', () => {
    setClipboard(undefined)
    const exec = stubExecCommand()
    copyText('hello')
    expect(exec.calls).toEqual(['copy'])
    expect(exec.copied).toEqual(['hello'])
  })
})

describe('el form-field names', () => {
  test('an unnamed field is named after its own class; an explicit name or id wins', () => {
    expect(el('input', { type: 'text', class: 'tt-input tt-search-input' }).name).toBe('tt-search-input')
    expect(el('select', { class: 'tt-input' }).name).toBe('tt-input')
    expect(el('input', { type: 'checkbox' }).name).toBe('tt-input-checkbox')
    expect(el('input', { type: 'text', name: 'mine' }).name).toBe('mine')
    expect(el('input', { type: 'text', id: 'mine' }).hasAttribute('name')).toBe(false)
    expect(el('div', { class: 'x' }).hasAttribute('name')).toBe(false)
  })
})

describe('saveFocus', () => {
  afterEach(() => { document.body.innerHTML = '' })

  test('hands focus back to the element that held it', () => {
    const a = document.body.appendChild(el('button', {}))
    const b = document.body.appendChild(el('button', {}))
    a.focus()
    const saved = saveFocus()
    b.focus()
    expect(saved.restore()).toBe(true)
    expect(document.activeElement).toBe(a)
  })

  test('restores the caret of an editor, which focus() alone would reset', () => {
    const ed = document.body.appendChild(el('div', { contenteditable: 'true', tabindex: '0' }, 'hello world'))
    const other = document.body.appendChild(el('button', {}))
    ed.focus()
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    r.setStart(ed.firstChild!, 5)
    r.collapse(true)
    sel.addRange(r)
    const saved = saveFocus()
    other.focus()
    sel.removeAllRanges()
    saved.restore()
    expect(document.activeElement).toBe(ed)
    expect(window.getSelection()!.anchorOffset).toBe(5)
  })

  test('reports failure when the element is gone or nothing was focused', () => {
    const a = document.body.appendChild(el('button', {}))
    a.focus()
    const saved = saveFocus()
    a.remove()
    expect(saved.restore()).toBe(false)
    ;(document.activeElement as HTMLElement).blur?.()
    expect(saveFocus().restore()).toBe(false)
  })
})

describe('keepRowFocus', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function list(ids: string[]): HTMLElement {
    const root = document.body.appendChild(el('div', {}))
    fill(root, ids)
    return root
  }
  function fill(root: HTMLElement, ids: string[]): void {
    root.innerHTML = ''
    for (const id of ids) {
      root.appendChild(el('div', { class: 'row', tabindex: '0', 'data-item-id': id },
        el('input', { class: 'tick', type: 'checkbox' }),
        el('select', { class: 'pick' })))
    }
  }
  const row = (root: HTMLElement, id: string): HTMLElement => root.querySelector<HTMLElement>(`.row[data-item-id="${id}"]`)!

  test('puts focus back on the rebuilt row', () => {
    const root = list(['a', 'b'])
    row(root, 'b').focus()
    keepRowFocus(root, '.row', () => fill(root, ['a', 'b']))
    expect(document.activeElement).toBe(row(root, 'b'))
  })

  test('a checkbox hands focus to its row, so the arrows keep working', () => {
    const root = list(['a', 'b'])
    row(root, 'b').querySelector<HTMLElement>('.tick')!.focus()
    keepRowFocus(root, '.row', () => fill(root, ['a', 'b']))
    expect(document.activeElement).toBe(row(root, 'b'))
  })

  test('a select keeps focus on the same select, so the next field is one Tab away', () => {
    const root = list(['a', 'b'])
    row(root, 'b').querySelector<HTMLElement>('.pick')!.focus()
    keepRowFocus(root, '.row', () => fill(root, ['a', 'b']))
    expect(document.activeElement).toBe(row(root, 'b').querySelector('.pick'))
  })

  test('a deleted row hands focus to the next row, or the previous one at the end', () => {
    const root = list(['a', 'b', 'c'])
    row(root, 'b').focus()
    keepRowFocus(root, '.row', () => fill(root, ['a', 'c']))
    expect(document.activeElement).toBe(row(root, 'c'))

    keepRowFocus(root, '.row', () => fill(root, ['a']))
    expect(document.activeElement).toBe(row(root, 'a'))
  })

  test('leaves focus alone when it is outside the list', () => {
    const root = list(['a'])
    const outside = document.body.appendChild(el('button', {}))
    outside.focus()
    keepRowFocus(root, '.row', () => fill(root, ['a']))
    expect(document.activeElement).toBe(outside)
  })

  test('does not fight a rebuild that placed focus itself', () => {
    const root = list(['a', 'b'])
    row(root, 'a').focus()
    keepRowFocus(root, '.row', () => {
      fill(root, ['a', 'b'])
      row(root, 'b').querySelector<HTMLElement>('.tick')!.focus()
    })
    expect(document.activeElement).toBe(row(root, 'b').querySelector('.tick'))
  })
})

test('neighbourRowId names the next row, else the previous, else nothing', () => {
  const root = document.body.appendChild(el('div', {},
    el('div', { class: 'row', 'data-item-id': 'a' }), el('div', { class: 'row', 'data-item-id': 'b' })))
  expect(neighbourRowId(root, '.row', 'a')).toBe('b')
  expect(neighbourRowId(root, '.row', 'b')).toBe('a')
  expect(neighbourRowId(root, '.row', 'zzz')).toBeNull()
  root.remove()
})

describe('createDeferredRebuild with focus in transit', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers() })

  test('waits a tick when focus is moving to another element, so the rebuild cannot destroy where it is going', () => {
    vi.useFakeTimers()
    const rebuild = vi.fn()
    const deferred = createDeferredRebuild(rebuild)
    const a = document.body.appendChild(el('input', {}))
    const b = document.body.appendChild(el('input', {}))
    a.focus()
    deferred.arm(a)
    a.dispatchEvent(new FocusEvent('blur', { relatedTarget: b }))
    expect(rebuild).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  test('dispose cancels a waiting rebuild, the module is gone', () => {
    vi.useFakeTimers()
    const rebuild = vi.fn()
    const deferred = createDeferredRebuild(rebuild)
    const a = document.body.appendChild(el('input', {}))
    deferred.arm(a)
    a.dispatchEvent(new FocusEvent('blur', { relatedTarget: document.body }))
    deferred.dispose()
    vi.runAllTimers()
    expect(rebuild).not.toHaveBeenCalled()
  })
})

test('keepRowFocus keeps a text field too, selected as a Tab into it leaves it', () => {
  const root = document.body.appendChild(el('div', {}))
  const fill = (): void => {
    root.innerHTML = ''
    root.appendChild(el('div', { class: 'row', tabindex: '0', 'data-item-id': 'a' }, el('input', { class: 'name', type: 'text', value: 'abc' })))
  }
  fill()
  root.querySelector<HTMLInputElement>('.name')!.focus()
  keepRowFocus(root, '.row', fill)
  const input = root.querySelector<HTMLInputElement>('.name')!
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3])
  root.remove()
})

describe('rovingRows', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function list(ids: string[]): HTMLElement {
    const root = document.body.appendChild(el('div', {}))
    fill(root, ids)
    return root
  }
  function fill(root: HTMLElement, ids: string[]): void {
    root.innerHTML = ''
    for (const id of ids) {
      root.appendChild(el('div', { class: 'row', tabindex: '0', 'data-item-id': id },
        el('input', { class: 'name', type: 'text' }),
        el('button', { class: 'quiet', tabindex: '-1' })))
    }
  }
  const row = (root: HTMLElement, id: string): HTMLElement => root.querySelector<HTMLElement>(`.row[data-item-id="${id}"]`)!
  const stops = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>('.row, .name, .quiet'))
    .filter((e) => e.tabIndex >= 0)
    .map((e) => `${e.className.split(' ')[0]}:${e.closest<HTMLElement>('.row')!.dataset.itemId}`)

  test('one row is the Tab stop, and only that row\'s fields stay in the tab order', () => {
    const root = list(['a', 'b', 'c'])
    rovingRows(root, '.row').refresh()
    expect(stops(root)).toEqual(['row:a', 'name:a'])
  })

  test('the stop follows focus', () => {
    const root = list(['a', 'b', 'c'])
    rovingRows(root, '.row').refresh()
    row(root, 'c').focus()
    expect(stops(root)).toEqual(['row:c', 'name:c'])
  })

  test('a click into another row\'s field moves the stop there too', () => {
    const root = list(['a', 'b'])
    rovingRows(root, '.row').refresh()
    row(root, 'b').querySelector<HTMLElement>('.name')!.focus()
    expect(stops(root)).toEqual(['row:b', 'name:b'])
  })

  test('a row\'s own tabindex="-1" buttons are never promoted', () => {
    const root = list(['a', 'b'])
    rovingRows(root, '.row').refresh()
    row(root, 'b').focus()
    row(root, 'a').focus()
    expect((row(root, 'a').querySelector('.quiet') as HTMLElement).tabIndex).toBe(-1)
  })

  test('the stop survives a rebuild by id, and falls to the first row when the id is gone', () => {
    const root = list(['a', 'b'])
    const roving = rovingRows(root, '.row')
    roving.refresh()
    row(root, 'b').focus()
    fill(root, ['a', 'b'])
    roving.refresh()
    expect(stops(root)).toEqual(['row:b', 'name:b'])
    fill(root, ['a'])
    roving.refresh()
    expect(stops(root)).toEqual(['row:a', 'name:a'])
  })

  test('setActive picks the stop from outside', () => {
    const root = list(['a', 'b'])
    rovingRows(root, '.row').setActive('b')
    expect(stops(root)).toEqual(['row:b', 'name:b'])
  })
})

test('createDeferredRebuild waits out a field\'s own popup: focus comes back, and the rebuild runs on the blur after that', () => {
  const rebuild = vi.fn()
  const deferred = createDeferredRebuild(rebuild)
  const field = document.body.appendChild(el('input', {}))
  const popup = document.body.appendChild(el('div', { 'data-field-popup': '' }, el('button', {})))
  deferred.arm(field)
  field.dispatchEvent(new FocusEvent('blur', { relatedTarget: popup.firstElementChild }))
  expect(rebuild).not.toHaveBeenCalled()
  field.dispatchEvent(new FocusEvent('focus'))
  field.dispatchEvent(new FocusEvent('blur'))
  expect(rebuild).toHaveBeenCalledTimes(1)
  document.body.innerHTML = ''
})
