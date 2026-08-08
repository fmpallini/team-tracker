import { createBacklinksChip, closeAnyBacklinksPanel } from '../src/ui/backlinks-panel'
import type { Backlink } from '../src/core/search'
import type { Loc } from '../src/core/types'

beforeEach(() => {
  // closeCurrent is module-level (see backlinks-panel.ts) and outlives any
  // one test — a panel left open by a previous test (e.g. an assertion
  // failure before its own cleanup ran) would otherwise leak its two
  // document listeners into this test's own listener-count assertions.
  closeAnyBacklinksPanel()
})

afterEach(() => {
  document.body.innerHTML = ''
})

function bl(overrides: Partial<Backlink> = {}): Backlink {
  return {
    loc: { teamId: 'T1', ref: { kind: 'person', personId: 'p1', group: 'members' } },
    moduleKind: 'person',
    title: 'Ana',
    snippet: 'flagged @[Ship it](action:a1) as blocking',
    ...overrides,
  }
}

test('empty backlinks -> null, nothing rendered', () => {
  expect(createBacklinksChip([], 'en-US', () => {})).toBeNull()
})

test('non-empty backlinks -> a pill showing the count', () => {
  const chip = createBacklinksChip([bl(), bl({ moduleKind: 'risks', title: 'Queue backlog' })], 'en-US', () => {})
  expect(chip).not.toBeNull()
  expect(chip!.textContent).toBe('↩ 2')
  expect(chip!.className).toBe('tt-backlinks-chip')
})

test('clicking the chip opens a panel with one row per backlink, grouped by kind with a header', () => {
  document.body.appendChild(document.createElement('div')) // ensure body has layout context
  const chip = createBacklinksChip([bl(), bl({ moduleKind: 'risks', title: 'Queue backlog', snippet: 'no mention' })], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  const panel = document.querySelector('.tt-backlinks-panel')
  expect(panel).not.toBeNull()
  expect(panel!.querySelectorAll('.tt-backlinks-group-header')).toHaveLength(2)
  expect(panel!.querySelectorAll('.tt-backlinks-row')).toHaveLength(2)
  expect(panel!.textContent).toContain('Ana')
  expect(panel!.textContent).toContain('Queue backlog')
})

test('clicking a row navigates with the row\'s loc and secondary computed from the click', () => {
  const calls: { loc: Loc; opts: { secondary: boolean } }[] = []
  const chip = createBacklinksChip([bl()], 'en-US', (loc, opts) => calls.push({ loc, opts }))!
  document.body.appendChild(chip)
  chip.click()
  const row = document.querySelector<HTMLElement>('.tt-backlinks-row')!
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  expect(calls).toEqual([{ loc: bl().loc, opts: { secondary: true } }])
  // clicking a row also closes the panel
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('outside click and Escape both close the panel', () => {
  const chip = createBacklinksChip([bl()], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()

  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('closeAnyBacklinksPanel closes an open panel and removes its document listeners (the file-close leak main.ts guards against)', () => {
  const chip = createBacklinksChip([bl()], 'en-US', () => {})!
  document.body.appendChild(chip)
  chip.click()
  expect(document.querySelector('.tt-backlinks-panel')).not.toBeNull()
  const addSpy = vi.spyOn(document, 'addEventListener')
  const removeSpy = vi.spyOn(document, 'removeEventListener')

  closeAnyBacklinksPanel()

  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
  expect(removeSpy.mock.calls.length).toBeGreaterThanOrEqual(2) // bindOutsideDismiss's mousedown + keydown
  expect(addSpy).not.toHaveBeenCalled()
  addSpy.mockRestore()
  removeSpy.mockRestore()
})

test('closeAnyBacklinksPanel is a no-op when nothing is open', () => {
  expect(() => closeAnyBacklinksPanel()).not.toThrow()
  expect(document.querySelector('.tt-backlinks-panel')).toBeNull()
})

test('opening a second chip\'s panel closes the first', () => {
  const chipA = createBacklinksChip([bl()], 'en-US', () => {})!
  const chipB = createBacklinksChip([bl({ moduleKind: 'risks' })], 'en-US', () => {})!
  document.body.append(chipA, chipB)
  chipA.click()
  chipB.click()
  expect(document.querySelectorAll('.tt-backlinks-panel')).toHaveLength(1)
})

test('clamps to the viewport when the panel would open off the right/bottom edge', () => {
  const originalGetRect = Element.prototype.getBoundingClientRect
  const originalInnerWidth = window.innerWidth
  const originalInnerHeight = window.innerHeight
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
  Element.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const base = { x: 0, y: 0, toJSON: () => ({}) }
    if (this.classList.contains('tt-backlinks-chip')) {
      return { ...base, left: 780, right: 800, top: 580, bottom: 600, width: 20, height: 20 } as DOMRect
    }
    if (this.classList.contains('tt-backlinks-panel')) {
      return { ...base, left: 780, right: 1080, top: 600, bottom: 900, width: 300, height: 300 } as DOMRect
    }
    return originalGetRect.call(this)
  }

  try {
    const chip = createBacklinksChip([bl()], 'en-US', () => {})!
    document.body.appendChild(chip)
    chip.click()
    const panel = document.querySelector<HTMLElement>('.tt-backlinks-panel')!
    expect(parseFloat(panel.style.left)).toBeLessThanOrEqual(800 - 8 - 300)
    expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(580 - 300)
  } finally {
    Element.prototype.getBoundingClientRect = originalGetRect
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
  }
})

test('stress: 300 open/close cycles leave no accumulated document listeners or stray panel DOM nodes', () => {
  const chip = createBacklinksChip([bl()], 'en-US', () => {})!
  document.body.appendChild(chip)
  const addSpy = vi.spyOn(document, 'addEventListener')
  const removeSpy = vi.spyOn(document, 'removeEventListener')
  const netDocumentListeners = (): number => addSpy.mock.calls.length - removeSpy.mock.calls.length

  for (let i = 0; i < 300; i++) {
    chip.click() // open
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) // close
    expect(document.querySelectorAll('.tt-backlinks-panel'), `stray panel at cycle ${i}`).toHaveLength(0)
    expect(netDocumentListeners(), `leaked document listener at cycle ${i}`).toBe(0)
  }

  addSpy.mockRestore()
  removeSpy.mockRestore()
})
