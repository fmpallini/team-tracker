import { afterEach, describe, expect, test } from 'vitest'
import { abbreviateWhenClipped, fitText } from '../src/ui/fit-text'

// jsdom has no layout, so the box is faked: the content needs `need` px of height at font-size 1em and
// scales with the inline font-size; the box is `box` px tall.
const realComputedStyle = window.getComputedStyle
afterEach(() => { window.getComputedStyle = realComputedStyle })

function fakeName(need: number, box: number, basePx = 16): HTMLElement & { box: number } {
  const node = Object.assign(document.createElement('span'), { box })
  node.className = 'tt-team-name'
  Object.defineProperty(node, 'clientHeight', { get: () => node.box })
  Object.defineProperty(node, 'scrollHeight', { get: () => need * (parseFloat(node.style.fontSize) || 1) })
  window.getComputedStyle = ((n: Element) => (n === node ? ({ fontSize: `${basePx}px` } as CSSStyleDeclaration) : realComputedStyle(n))) as typeof window.getComputedStyle
  return node
}

function fit(node: HTMLElement): string {
  const root = document.createElement('div')
  root.append(node)
  fitText(root, '.tt-team-name')
  return node.style.fontSize
}

describe('fitText', () => {
  test('text that fits keeps the stylesheet size', () => {
    expect(fit(fakeName(30, 40))).toBe('')
  })

  test('steps down to the first size that fits', () => {
    expect(fit(fakeName(44, 40))).toBe('0.92em')
    expect(fit(fakeName(46, 40))).toBe('0.85em')
  })

  test('the smallest step also allows a third line, and a later fit clears it', () => {
    const node = fakeName(100, 40)
    expect(fit(node)).toBe('0.78em')
    expect(node.style.getPropertyValue('-webkit-line-clamp')).toBe('3')
    node.box = 100
    fitText(node.parentElement!, '.tt-team-name')
    expect(node.style.getPropertyValue('-webkit-line-clamp')).toBe('')
  })

  test('never goes below the pixel floor', () => {
    expect(fit(fakeName(100, 40, 12))).toBe('0.85em')
  })

  test('is idempotent: a name that fits again after growing resets', () => {
    const node = fakeName(46, 40)
    const root = document.createElement('div')
    root.append(node)
    fitText(root, '.tt-team-name')
    expect(node.style.fontSize).toBe('0.85em')
    node.box = 60
    fitText(root, '.tt-team-name')
    expect(node.style.fontSize).toBe('')
  })

  test('a node with no layout (hidden, detached) is left alone', () => {
    const node = document.createElement('span')
    node.className = 'tt-team-name'
    expect(fit(node)).toBe('')
  })
})

describe('abbreviateWhenClipped', () => {
  const label = (scroll: number, client: number): HTMLElement => {
    const node = document.createElement('span')
    Object.defineProperty(node, 'scrollWidth', { get: () => scroll })
    Object.defineProperty(node, 'clientWidth', { get: () => client })
    return node
  }

  test('keeps the full text when it fits', () => {
    const node = label(80, 80)
    abbreviateWhenClipped(node, 'Team Tracker', 'TT')
    expect(node.textContent).toBe('Team Tracker')
  })

  test('falls back to the short text when the full one is clipped', () => {
    const node = label(90, 60)
    abbreviateWhenClipped(node, 'Team Tracker', 'TT')
    expect(node.textContent).toBe('TT')
  })
})
