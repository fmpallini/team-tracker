import { icon, iconSvg, setIcon } from '../src/ui/icons'

describe('iconSvg', () => {
  test('is a 16x16-grid stroke icon sized by the argument and tinted by currentColor', () => {
    const doc = new DOMParser().parseFromString(iconSvg('trash', 18), 'image/svg+xml')
    const svg = doc.documentElement
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('width')).toBe('18')
    expect(svg.getAttribute('height')).toBe('18')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  test('defaults to 14px', () => {
    expect(iconSvg('gear')).toContain('width="14"')
  })
})

describe('icon', () => {
  test('wraps the svg in an aria-hidden span carrying the icon name class', () => {
    const span = icon('lock')
    expect(span.tagName).toBe('SPAN')
    expect(span.getAttribute('aria-hidden')).toBe('true')
    expect(span.classList.contains('tt-icon')).toBe(true)
    expect(span.classList.contains('tt-icon-lock')).toBe(true)
    expect(span.querySelector('svg')).not.toBeNull()
  })

  test('each call returns a fresh node (the parsed prototype is cloned, never shared)', () => {
    const a = icon('trash')
    const b = icon('trash')
    expect(a).not.toBe(b)
    a.classList.add('touched')
    expect(b.classList.contains('touched')).toBe(false)
  })

  test('has no text content, so a screen reader reads only the button title', () => {
    expect(icon('help').textContent).toBe('')
  })
})

describe('setIcon', () => {
  test('swaps drawing and class on the same element', () => {
    const span = icon('star')
    const before = span.innerHTML
    setIcon(span, 'starFill')
    expect(span.innerHTML).not.toBe(before)
    expect(span.classList.contains('tt-icon-starFill')).toBe(true)
    expect(span.classList.contains('tt-icon-star')).toBe(false)
  })
})
