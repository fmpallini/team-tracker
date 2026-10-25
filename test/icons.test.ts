import { icon, iconButton, iconLine, iconSvg, kindIcon, setIcon, setIconButtonTitle } from '../src/ui/icons'

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

describe('kindIcon', () => {
  test.each(['daily', 'general', 'person', 'stakeholders', 'members', 'actions', 'milestones', 'risks'] as const)(
    '%s gets a stroke icon carrying its tint class', (kind) => {
      const span = kindIcon(kind)
      expect(span.querySelector('svg')).not.toBeNull()
      expect(span.classList.contains('tt-kind-icon')).toBe(true)
      expect(span.classList.contains(`tt-kind-${kind}`)).toBe(true)
    }
  )

  test('does not mutate the cached icon prototype (a plain icon of the same name has no tint class)', () => {
    kindIcon('actions')
    expect(icon('tasks').classList.contains('tt-kind-icon')).toBe(false)
  })
})

describe('iconLine', () => {
  test('is a list item with the icon first and the text after it', () => {
    const li = iconLine('lock', 'Encrypted')
    expect(li.tagName).toBe('LI')
    expect(li.firstElementChild!.classList.contains('tt-icon-lock')).toBe(true)
    expect(li.textContent).toBe('Encrypted')
  })
})

describe('image icon', () => {
  test('is a framed picture: a rounded rectangle, a sun and a hill line, all stroked', () => {
    const doc = new DOMParser().parseFromString(iconSvg('image', 16), 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('rect')).not.toBeNull()
    expect(doc.querySelector('circle')).not.toBeNull()
    expect(doc.querySelector('path')?.getAttribute('d')).toBeTruthy()
    expect(icon('image').classList.contains('tt-icon-image')).toBe(true)
  })
})

describe('iconButton', () => {
  test('is a button with the shared chrome, one icon, and the same string as tooltip and accessible name', () => {
    const onclick = vi.fn()
    const b = iconButton({ class: 'tt-x-btn', title: 'Remove', icon: 'trash', size: 16, onclick })
    expect(b.tagName).toBe('BUTTON')
    expect(b.type).toBe('button')
    expect(b.className).toBe('tt-btn tt-x-btn')
    expect(b.title).toBe('Remove')
    expect(b.getAttribute('aria-label')).toBe('Remove')
    expect(b.querySelectorAll('.tt-icon-trash')).toHaveLength(1)
    expect(b.textContent).toBe('')
    b.click()
    expect(onclick).toHaveBeenCalledOnce()
  })

  test('bare drops the shared chrome; tabindex and disabled pass through', () => {
    const b = iconButton({ class: 'tt-x-dismiss', title: 'Dismiss', icon: 'close', bare: true, tabindex: '-1', disabled: true, onclick: () => {} })
    expect(b.className).toBe('tt-x-dismiss')
    expect(b.getAttribute('tabindex')).toBe('-1')
    expect(b.disabled).toBe(true)
  })

  test('onmousedown is wired only when given', () => {
    const onmousedown = vi.fn()
    iconButton({ class: 'a', title: 'A', icon: 'copy', onmousedown, onclick: () => {} }).dispatchEvent(new MouseEvent('mousedown'))
    expect(onmousedown).toHaveBeenCalledOnce()
  })

  test('setIconButtonTitle re-labels the tooltip and the accessible name together', () => {
    const b = iconButton({ class: 'a', title: 'Settings', icon: 'gear', onclick: () => {} })
    setIconButtonTitle(b, 'Preferências')
    expect(b.title).toBe('Preferências')
    expect(b.getAttribute('aria-label')).toBe('Preferências')
  })
})
