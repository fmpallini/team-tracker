import { createDatePicker, digitsOnly, maskDateDigits } from '../src/ui/date-picker'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(opts: Parameters<typeof createDatePicker>[0]) {
  const handle = createDatePicker(opts)
  document.body.appendChild(handle.root)
  return handle
}

function input(handle: ReturnType<typeof createDatePicker>): HTMLInputElement {
  return handle.root.querySelector('.tt-date-picker-input') as HTMLInputElement
}

function type(el: HTMLInputElement, text: string): void {
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function popover(): HTMLElement | null {
  return document.querySelector('.tt-date-picker-popover')
}

function dayButton(day: number): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-calendar-day:not(.tt-calendar-day-blank)'))
    .find((b) => b.textContent === String(day))!
}

function popoverButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tt-date-picker-popover-actions button')).find((b) => b.textContent === text)
}

describe('digitsOnly', () => {
  test('strips non-digits and caps at 8', () => {
    expect(digitsOnly('')).toBe('')
    expect(digitsOnly('07/20/2026')).toBe('07202026')
    expect(digitsOnly('ab07--20cd2026ef99')).toBe('07202026')
  })
})

describe('maskDateDigits', () => {
  test('inserts slashes after the 2nd and 4th digit as digits accumulate', () => {
    expect(maskDateDigits('')).toBe('')
    expect(maskDateDigits('0')).toBe('0')
    expect(maskDateDigits('07')).toBe('07')
    expect(maskDateDigits('072')).toBe('07/2')
    expect(maskDateDigits('0720')).toBe('07/20')
    expect(maskDateDigits('07202')).toBe('07/20/2')
    expect(maskDateDigits('07202026')).toBe('07/20/2026')
  })
})

describe('createDatePicker', () => {
  test('renders the initial value formatted for the locale', () => {
    const ptHandle = mount({ value: '2026-07-20', locale: 'pt-BR', onChange: () => {} })
    expect(input(ptHandle).value).toBe('20/07/2026')

    const enHandle = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
    expect(input(enHandle).value).toBe('07/20/2026')
  })

  test('renders empty when value is empty, with a locale-shaped placeholder', () => {
    const en = mount({ value: '', locale: 'en-US', onChange: () => {} })
    expect(input(en).value).toBe('')
    expect(input(en).placeholder).toBe('MM/DD/YYYY')

    const pt = mount({ value: '', locale: 'pt-BR', onChange: () => {} })
    expect(input(pt).placeholder).toBe('DD/MM/AAAA')
  })

  test('input is editable, not readonly', () => {
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
    expect(input(handle).readOnly).toBe(false)
  })

  describe('typed input', () => {
    test('typing digits auto-masks with locale separators', () => {
      const handle = mount({ value: '', locale: 'en-US', onChange: () => {} })
      type(input(handle), '0720')
      expect(input(handle).value).toBe('07/20')
    })

    test('typing non-digit characters strips them', () => {
      const handle = mount({ value: '', locale: 'en-US', onChange: () => {} })
      type(input(handle), '07a20b2026')
      expect(input(handle).value).toBe('07/20/2026')
    })

    test('a complete, valid date auto-commits: calls onChange, no Enter/blur needed', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '', locale: 'en-US', onChange })
      type(input(handle), '07202026')
      expect(onChange).toHaveBeenCalledWith('2026-07-20')
      expect(handle.getValue()).toBe('2026-07-20')
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(false)
    })

    test('a complete but impossible date is marked invalid and never committed', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '2026-01-01', locale: 'en-US', onChange })
      type(input(handle), '02302026') // Feb 30 doesn't exist
      expect(onChange).not.toHaveBeenCalled()
      expect(handle.getValue()).toBe('2026-01-01') // unchanged — never "saved"
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(true)
      expect(input(handle).getAttribute('aria-invalid')).toBe('true')
    })

    test('an incomplete date is not marked invalid while still typing', () => {
      const handle = mount({ value: '', locale: 'en-US', onChange: () => {} })
      type(input(handle), '072')
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(false)
    })

    test('blurring on an incomplete date marks it invalid and leaves it visible', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '2026-01-01', locale: 'en-US', onChange })
      type(input(handle), '072')
      input(handle).dispatchEvent(new FocusEvent('blur'))
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(true)
      expect(input(handle).value).toBe('07/2')
      expect(onChange).not.toHaveBeenCalled()
      expect(handle.getValue()).toBe('2026-01-01')
    })

    test('blurring an emptied field with allowClear commits ""', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '2026-01-01', locale: 'en-US', allowClear: true, onChange })
      type(input(handle), '')
      input(handle).dispatchEvent(new FocusEvent('blur'))
      expect(onChange).toHaveBeenCalledWith('')
      expect(handle.getValue()).toBe('')
    })

    test('blurring an emptied field without allowClear reverts to the last valid value', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '2026-01-01', locale: 'en-US', onChange })
      type(input(handle), '')
      input(handle).dispatchEvent(new FocusEvent('blur'))
      expect(onChange).not.toHaveBeenCalled()
      expect(handle.getValue()).toBe('2026-01-01')
      expect(input(handle).value).toBe('01/01/2026')
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(false)
    })

    test('typing a fix after an invalid attempt clears the invalid state and commits', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '', locale: 'en-US', onChange })
      type(input(handle), '02302026')
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(true)
      type(input(handle), '')
      type(input(handle), '07202026')
      expect(onChange).toHaveBeenCalledWith('2026-07-20')
      expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(false)
    })
  })

  test('clicking the input opens a calendar popover for the current value', () => {
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
    input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(popover()).not.toBeNull()
    expect(popover()!.querySelector('.tt-calendar')).not.toBeNull()
  })

  test('picking a day commits the ISO value, updates the display text, calls onChange, and closes the popover', () => {
    const onChange = vi.fn()
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange })
    input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    dayButton(15).click()
    expect(onChange).toHaveBeenCalledWith('2026-07-15')
    expect(input(handle).value).toBe('07/15/2026')
    expect(popover()).toBeNull()
  })

  test('Escape closes the popover without calling onChange', () => {
    const onChange = vi.fn()
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange })
    input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(popover()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(popover()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('clicking outside the popover closes it without calling onChange', () => {
    const onChange = vi.fn()
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange })
    input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(popover()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('opening a second date picker closes the first (module-level singleton, like showContextMenu)', () => {
    const a = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
    const b = mount({ value: '2026-08-01', locale: 'en-US', onChange: () => {} })
    input(a).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelectorAll('.tt-date-picker-popover')).toHaveLength(1)
    input(b).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelectorAll('.tt-date-picker-popover')).toHaveLength(1)
  })

  describe('popover Today / Clear date buttons', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    test('"Today" is always present and commits the current date', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 6, 20))
      const onChange = vi.fn()
      const handle = mount({ value: '2026-01-01', locale: 'en-US', onChange })
      input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      popoverButton('Today')!.click()
      expect(onChange).toHaveBeenCalledWith('2026-07-20')
      expect(input(handle).value).toBe('07/20/2026')
      expect(popover()).toBeNull()
    })

    test('"Clear date" appears only when allowClear is set', () => {
      const withClear = mount({ value: '2026-07-20', locale: 'en-US', allowClear: true, onChange: () => {} })
      input(withClear).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(popoverButton('Clear date')).not.toBeUndefined()
    })

    test('"Clear date" is omitted when allowClear is not set', () => {
      const noClear = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
      input(noClear).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(popoverButton('Clear date')).toBeUndefined()
    })

    test('clicking "Clear date" commits "" and closes the popover', () => {
      const onChange = vi.fn()
      const handle = mount({ value: '2026-07-20', locale: 'en-US', allowClear: true, onChange })
      input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      popoverButton('Clear date')!.click()
      expect(onChange).toHaveBeenCalledWith('')
      expect(input(handle).value).toBe('')
      expect(popover()).toBeNull()
    })
  })

  test('setValue() updates the displayed text without calling onChange, and clears any invalid state', () => {
    const onChange = vi.fn()
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange })
    type(input(handle), '02302026') // mark invalid first
    expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(true)
    handle.setValue('2026-12-25')
    expect(input(handle).value).toBe('12/25/2026')
    expect(input(handle).classList.contains('tt-date-picker-input-invalid')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  test('getValue() returns the current ISO value', () => {
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
    expect(handle.getValue()).toBe('2026-07-20')
    handle.setValue('2026-08-01')
    expect(handle.getValue()).toBe('2026-08-01')
  })

  test('destroy() closes an open popover and removes its listeners', () => {
    const handle = mount({ value: '2026-07-20', locale: 'en-US', onChange: () => {} })
    input(handle).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(popover()).not.toBeNull()
    handle.destroy()
    expect(popover()).toBeNull()
    // no error/leak from a stray listener still reacting after destroy
    expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).not.toThrow()
  })
})
