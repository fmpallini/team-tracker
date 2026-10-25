import { describe, it, expect, vi } from 'vitest'
import { clampInt, prefsSection, prefsHint, prefsRadioField, prefsCheckboxField, prefsNumberField } from '../src/ui/prefs-fields'

describe('clampInt', () => {
  it('rounds and clamps into range', () => {
    expect(clampInt(15.4, 1, 60, 10)).toBe(15)
    expect(clampInt(999, 1, 60, 10)).toBe(60)
    expect(clampInt(0, 1, 60, 10)).toBe(1)
  })
  it('falls back for non-finite input', () => {
    expect(clampInt(NaN, 1, 60, 10)).toBe(10)
    expect(clampInt(Infinity, 1, 60, 10)).toBe(10)
  })
})

describe('prefsSection', () => {
  it('renders a titled section with its children after the heading', () => {
    const child = document.createElement('div')
    const section = prefsSection('Title', child)
    expect(section.className).toBe('tt-prefs-section')
    expect(section.firstElementChild?.tagName).toBe('H3')
    expect(section.firstElementChild?.textContent).toBe('Title')
    expect(section.lastElementChild).toBe(child)
  })
  it('omits the heading when the title is null', () => {
    const section = prefsSection(null, document.createElement('div'))
    expect(section.querySelector('h3')).toBeNull()
    expect(section.children).toHaveLength(1)
  })
})

describe('prefsHint', () => {
  it('adds an optional extra class', () => {
    expect(prefsHint('x').className).toBe('tt-data-hint')
    expect(prefsHint('x', 'extra').className).toBe('tt-data-hint extra')
  })
})

describe('prefsRadioField', () => {
  const opts = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B', preview: 'serif' },
    { value: 'c', label: 'C', sizePreview: '12px' },
    { value: 'd', label: 'D', swatch: '#123456' },
  ]

  it('checks the current option, labels the group and reports changes', () => {
    const onChange = vi.fn()
    const field = prefsRadioField({ name: 'g', label: 'Group', options: opts, current: 'b', onChange })
    expect(field.querySelector('.tt-prefs-field-label')?.textContent).toBe('Group')
    const inputs = Array.from(field.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    expect(inputs.map((i) => i.checked)).toEqual([false, true, false, false])
    inputs[2]!.dispatchEvent(new Event('change'))
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('previews font and size on the label and draws a swatch', () => {
    const field = prefsRadioField({ name: 'g', label: 'Group', options: opts, current: 'a', onChange: () => {} })
    const previews = field.querySelectorAll<HTMLElement>('.tt-prefs-radio-preview')
    expect(previews[0]!.style.fontFamily).toBe('serif')
    expect(previews[1]!.style.fontSize).toBe('12px')
    expect((field.querySelector('.tt-prefs-radio-swatch') as HTMLElement).style.background).not.toBe('')
  })

  it('draws a size option as an "A" at that size, keeping its name for screen readers and as a tooltip', () => {
    const field = prefsRadioField({ name: 'g', label: 'Group', options: opts, current: 'a', onChange: () => {} })
    expect(field.querySelector('.tt-prefs-radio-row')?.classList.contains('tt-size-steps')).toBe(true)
    const label = field.querySelectorAll<HTMLElement>('label.tt-prefs-radio')[2]!
    const glyph = label.querySelector<HTMLElement>('.tt-prefs-radio-preview')!
    expect(glyph.textContent).toBe('A')
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(label.querySelector('.tt-visually-hidden')?.textContent).toBe('C')
    expect(label.title).toBe('C')
  })

  it('draws a palette option as a card with a miniature that names its palette and the current theme', () => {
    document.documentElement.dataset.theme = 'dark'
    try {
      const field = prefsRadioField({
        name: 'p', label: 'Palette', current: 'signal', onChange: () => {},
        options: [{ value: 'ledger', label: 'Field Ledger', palette: 'ledger' }, { value: 'signal', label: 'Signal', palette: 'signal' }],
      })
      expect(field.querySelector('.tt-prefs-radio-row')?.classList.contains('tt-palette-grid')).toBe(true)
      const cards = Array.from(field.querySelectorAll<HTMLElement>('label.tt-palette-card'))
      expect(cards).toHaveLength(2)
      const mini = cards[1]!.querySelector<HTMLElement>('.tt-palette-preview')!
      expect(mini.dataset.palette).toBe('signal')
      expect(mini.dataset.theme).toBe('dark')
      expect(cards[1]!.querySelector('.tt-palette-card-name')?.textContent).toBe('Signal')
      expect(cards[1]!.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    } finally {
      delete document.documentElement.dataset.theme
    }
  })

  it('disables every radio when disabled', () => {
    const field = prefsRadioField({ name: 'g', label: 'Group', options: opts, current: 'a', onChange: () => {}, disabled: true })
    expect(Array.from(field.querySelectorAll<HTMLInputElement>('input')).every((i) => i.disabled)).toBe(true)
  })
})

describe('prefsCheckboxField', () => {
  it('reflects the initial state, reports changes and shows the optional hint', () => {
    const onChange = vi.fn()
    const field = prefsCheckboxField({ inputClass: 'my-check', label: 'Do it', hint: 'Why', checked: true, onChange })
    const input = field.querySelector('input.my-check') as HTMLInputElement
    expect(input.checked).toBe(true)
    expect(field.querySelector('.tt-prefs-checkbox-label')?.textContent).toBe('Do it')
    expect(field.querySelector('.tt-data-hint')?.textContent).toBe('Why')
    input.checked = false
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('renders no hint when none is given', () => {
    const field = prefsCheckboxField({ inputClass: 'c', label: 'L', checked: false, onChange: () => {} })
    expect(field.querySelector('.tt-data-hint')).toBeNull()
  })
})

describe('prefsNumberField', () => {
  function make(value = 10) {
    const onCommit = vi.fn()
    const field = prefsNumberField({ inputClass: 'my-num', label: 'Every', hint: 'Note', min: 1, max: 60, value, onCommit })
    const input = field.querySelector('input.my-num') as HTMLInputElement
    return { field, input, onCommit }
  }

  it('starts at the given value with min/max attributes', () => {
    const { input } = make(7)
    expect(input.value).toBe('7')
    expect(input.min).toBe('1')
    expect(input.max).toBe('60')
  })

  it('commits the clamped value and rewrites the input to match', () => {
    const { input, onCommit } = make()
    input.value = '999'
    input.dispatchEvent(new Event('change'))
    expect(onCommit).toHaveBeenLastCalledWith(60)
    expect(input.value).toBe('60')
    input.value = '0'
    input.dispatchEvent(new Event('change'))
    expect(onCommit).toHaveBeenLastCalledWith(1)
  })

  it('an emptied input reverts to the last committed value and commits nothing', () => {
    const { input, onCommit } = make(12)
    input.value = ''
    input.dispatchEvent(new Event('change'))
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('12')
  })

  it('an emptied input reverts to the value committed most recently, not the one the field started with', () => {
    const { input, onCommit } = make(12)
    input.value = '30'
    input.dispatchEvent(new Event('change'))
    input.value = ''
    input.dispatchEvent(new Event('change'))
    expect(input.value).toBe('30')
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})
