import { paintSelection, clampMove, selectableRowProps } from '../src/ui/select-list'

describe('clampMove', () => {
  test('moving within bounds just adds the delta', () => {
    expect(clampMove(2, 1, 5)).toBe(3)
    expect(clampMove(2, -1, 5)).toBe(1)
  })

  test('clamps at the top end of the list', () => {
    expect(clampMove(4, 1, 5)).toBe(4)
    expect(clampMove(4, 10, 5)).toBe(4)
  })

  test('clamps at the bottom end of the list (never goes negative)', () => {
    expect(clampMove(0, -1, 5)).toBe(0)
    expect(clampMove(0, -10, 5)).toBe(0)
  })

  test('an empty list always resolves to index 0, regardless of delta', () => {
    expect(clampMove(0, 1, 0)).toBe(0)
    expect(clampMove(5, -3, 0)).toBe(0)
  })

  test('a single-item list clamps to the only index', () => {
    expect(clampMove(0, 1, 1)).toBe(0)
    expect(clampMove(0, -1, 1)).toBe(0)
  })
})

describe('paintSelection', () => {
  function makeList(rowCount: number, extra: string[] = []): HTMLElement {
    const el = document.createElement('div')
    for (let i = 0; i < rowCount; i++) {
      const row = document.createElement('div')
      row.className = 'row'
      el.appendChild(row)
    }
    for (const cls of extra) {
      const sep = document.createElement('div')
      sep.className = cls
      el.appendChild(sep)
    }
    return el
  }

  test('marks exactly the row at `selected` as .selected, no others', () => {
    const el = makeList(3)
    paintSelection(el, '.row', 1)
    const rows = Array.from(el.querySelectorAll('.row'))
    expect(rows.map((r) => r.classList.contains('selected'))).toEqual([false, true, false])
  })

  test('re-painting with a new index moves the class instead of stacking it', () => {
    const el = makeList(3)
    paintSelection(el, '.row', 0)
    paintSelection(el, '.row', 2)
    const rows = Array.from(el.querySelectorAll('.row'))
    expect(rows.map((r) => r.classList.contains('selected'))).toEqual([false, false, true])
  })

  test('rowSelector excludes non-selectable rows (e.g. group-header separators) from indexing', () => {
    const el = makeList(2, ['separator'])
    // The separator is appended after the rows but must not shift indices —
    // only `.row` elements are addressed/counted.
    paintSelection(el, '.row', 1)
    const rows = Array.from(el.querySelectorAll('.row'))
    const sep = el.querySelector('.separator')!
    expect(rows.map((r) => r.classList.contains('selected'))).toEqual([false, true])
    expect(sep.classList.contains('selected')).toBe(false)
  })

  test('a null list element is a no-op, not a crash', () => {
    expect(() => paintSelection(null, '.row', 0)).not.toThrow()
  })

  test('scrolls the newly-selected row into view (so keyboard nav past the visible area follows it)', () => {
    const el = makeList(3)
    const rows = Array.from(el.querySelectorAll('.row')) as HTMLElement[]
    rows.forEach((r) => { r.scrollIntoView = vi.fn() })
    paintSelection(el, '.row', 2)
    expect(rows[2]!.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(rows[0]!.scrollIntoView).not.toHaveBeenCalled()
    expect(rows[1]!.scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('selectableRowProps', () => {
  test('appends " selected" to the class only when selected is true', () => {
    expect(selectableRowProps({ class: 'tt-row', selected: true, onCommit: vi.fn(), onHover: vi.fn() }).class).toBe(
      'tt-row selected'
    )
    expect(selectableRowProps({ class: 'tt-row', selected: false, onCommit: vi.fn(), onHover: vi.fn() }).class).toBe(
      'tt-row'
    )
  })

  test('onclick invokes onCommit', () => {
    const onCommit = vi.fn()
    const props = selectableRowProps({ class: 'tt-row', selected: false, onCommit, onHover: vi.fn() })
    ;(props.onclick as (e: Event) => void)(new Event('click'))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  test('onmouseenter invokes onHover', () => {
    const onHover = vi.fn()
    const props = selectableRowProps({ class: 'tt-row', selected: false, onCommit: vi.fn(), onHover })
    ;(props.onmouseenter as (e: Event) => void)(new Event('mouseenter'))
    expect(onHover).toHaveBeenCalledTimes(1)
  })

  // The whole reason this helper exists (see the file-header comment):
  // mousedown must not steal focus from whatever input/editor owns the
  // dropdown, or committing a pick would blur it first.
  test('onmousedown calls preventDefault, so picking a row never steals input focus', () => {
    const props = selectableRowProps({ class: 'tt-row', selected: false, onCommit: vi.fn(), onHover: vi.fn() })
    const event = new Event('mousedown', { cancelable: true })
    ;(props.onmousedown as (e: Event) => void)(event)
    expect(event.defaultPrevented).toBe(true)
  })

  // Regression: a scrollable dropdown (every consumer is `overflow-y: auto`
  // with a capped max-height) can scroll a different row under an unmoved
  // mouse cursor — via paintSelection's scrollIntoView during ArrowUp/Down —
  // and real Chrome fires mouseenter for that too. Without ignoring it, that
  // synthetic enter would immediately steal keyboard selection back to
  // whatever row the scroll happened to land under the pointer.
  describe('mouseenter ignores a stationary pointer (content scrolling under it, not real movement)', () => {
    test('a mouseenter at the same coordinates as the last real mousemove does not call onHover', () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 60 }))
      const onHover = vi.fn()
      const props = selectableRowProps({ class: 'tt-row', selected: false, onCommit: vi.fn(), onHover })

      ;(props.onmouseenter as (e: Event) => void)(new MouseEvent('mouseenter', { clientX: 50, clientY: 60 }))

      expect(onHover).not.toHaveBeenCalled()
    })

    test('a mouseenter at different coordinates (real pointer movement) still calls onHover', () => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 60 }))
      const onHover = vi.fn()
      const props = selectableRowProps({ class: 'tt-row', selected: false, onCommit: vi.fn(), onHover })

      ;(props.onmouseenter as (e: Event) => void)(new MouseEvent('mouseenter', { clientX: 120, clientY: 200 }))

      expect(onHover).toHaveBeenCalledTimes(1)
    })
  })
})
