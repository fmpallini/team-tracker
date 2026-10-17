import { findMatchRanges, applySearchHighlight, clearSearchHighlight, SEARCH_FOCUS_ITEM_EVENT, dispatchSearchFocusItem, focusItemInPane } from '../src/ui/search-highlight'

afterEach(() => {
  document.body.innerHTML = ''
  clearSearchHighlight() // flashedEl is module-scoped state; don't leak it across tests
})

test('finds accent-insensitive match ranges across text nodes', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>Orçamento <b>aprovado</b> ontem</p>'
  const ranges = findMatchRanges(root, ['orcamento', 'aprovado'])
  expect(ranges.length).toBe(2)
  expect(ranges[0]!.toString()).toBe('Orçamento')
})

test('findMatchRanges ignores empty terms and terms with no match', () => {
  const root = document.createElement('div')
  root.textContent = 'hello world'
  expect(findMatchRanges(root, ['', 'zzz'])).toEqual([])
})

test('applySearchHighlight is a safe no-op without CSS.highlights', () => {
  const root = document.createElement('div')
  root.textContent = 'nada'
  expect(() => applySearchHighlight([root], ['x'])).not.toThrow()
})

test('combines match ranges from multiple root elements, scrolling to a match found in a later root', () => {
  const rootA = document.createElement('div')
  rootA.textContent = 'nothing relevant here'
  const rootB = document.createElement('div')
  rootB.textContent = 'has target word'
  rootB.scrollIntoView = vi.fn()

  applySearchHighlight([rootA, rootB], ['target'])

  expect(rootB.scrollIntoView).toHaveBeenCalled()
})

test('an explicit scrollTarget wins even when no text ranges match at all (fixes action-item cards with a notes-only match never scrolling into view)', () => {
  const root = document.createElement('div')
  root.textContent = 'nothing on this card matches'
  const card = document.createElement('div')
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['zzz'], card)

  expect(card.scrollIntoView).toHaveBeenCalled()
})

test('an explicit scrollTarget takes precedence over a found text range', () => {
  const root = document.createElement('div')
  root.textContent = 'target word'
  root.scrollIntoView = vi.fn()
  const card = document.createElement('div')
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['target'], card)

  expect(card.scrollIntoView).toHaveBeenCalled()
  expect(root.scrollIntoView).not.toHaveBeenCalled()
})

test('clearSearchHighlight is a safe no-op when nothing was ever highlighted', () => {
  expect(() => clearSearchHighlight()).not.toThrow()
})

test('an explicit scrollTarget gets an accent outline flashed on it, since CSS.highlights can\'t mark text that isn\'t there (e.g. an action-item card whose only match is in the modal-only notes field)', () => {
  const root = document.createElement('div')
  root.textContent = 'irrelevant'
  const card = document.createElement('div')
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['zzz'], card)

  expect(card.classList.contains('tt-search-target-flash')).toBe(true)
})

test('flashing a new scrollTarget removes the outline from the previous one', () => {
  const root = document.createElement('div')
  root.textContent = 'irrelevant'
  const cardA = document.createElement('div')
  cardA.scrollIntoView = vi.fn()
  const cardB = document.createElement('div')
  cardB.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['zzz'], cardA)
  expect(cardA.classList.contains('tt-search-target-flash')).toBe(true)

  applySearchHighlight([root], ['zzz'], cardB)

  expect(cardA.classList.contains('tt-search-target-flash')).toBe(false)
  expect(cardB.classList.contains('tt-search-target-flash')).toBe(true)
})

test('clearSearchHighlight removes the outline from the last flashed target', () => {
  const root = document.createElement('div')
  root.textContent = 'irrelevant'
  const card = document.createElement('div')
  card.scrollIntoView = vi.fn()
  applySearchHighlight([root], ['zzz'], card)
  expect(card.classList.contains('tt-search-target-flash')).toBe(true)

  clearSearchHighlight()

  expect(card.classList.contains('tt-search-target-flash')).toBe(false)
})

test('without an explicit scrollTarget, nothing is flashed (the free-text CSS.highlights mark is the only indicator there)', () => {
  const root = document.createElement('div')
  root.textContent = 'target word'
  root.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['target'])

  expect(root.classList.contains('tt-search-target-flash')).toBe(false)
})

test('applySearchHighlight gives the resolved target real focus — the same "selected" state arrow-key nav puts a row/card into, not just a visual marker', () => {
  const root = document.createElement('div')
  root.textContent = 'irrelevant'
  const card = document.createElement('div')
  card.tabIndex = 0 // every module's row/card is a real tabindex="0" stop
  document.body.appendChild(card) // jsdom only moves activeElement for an element attached to the document
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['zzz'], card)

  expect(document.activeElement).toBe(card)
})

test('focus is requested with preventScroll, so the explicit scrollIntoView(block: "center") stays the only thing deciding scroll position', () => {
  const root = document.createElement('div')
  const card = document.createElement('div')
  card.tabIndex = 0
  card.focus = vi.fn()
  card.scrollIntoView = vi.fn()

  applySearchHighlight([root], ['zzz'], card)

  expect(card.focus).toHaveBeenCalledWith({ preventScroll: true })
})

test('a non-focusable fallback target (no explicit scrollTarget, just a found text range) is left alone — no error, no focus change', () => {
  const root = document.createElement('div')
  root.textContent = 'target word'
  root.scrollIntoView = vi.fn()

  expect(() => applySearchHighlight([root], ['target'])).not.toThrow()
  expect(document.activeElement).not.toBe(root)
})

test('dispatchSearchFocusItem dispatches the event on the given container with itemId as detail', () => {
  const container = document.createElement('div')
  let received: string | null = null
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, (e) => { received = (e as CustomEvent<string>).detail })

  dispatchSearchFocusItem(container, 'm1')

  expect(received).toBe('m1')
})

describe('focusItemInPane', () => {
  let frames: FrameRequestCallback[] = []
  const originalRAF = window.requestAnimationFrame
  beforeEach(() => {
    frames = []
    window.requestAnimationFrame = ((cb: FrameRequestCallback): number => { frames.push(cb); return frames.length }) as typeof window.requestAnimationFrame
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => { window.requestAnimationFrame = originalRAF })

  function twoPanes(): HTMLElement[] {
    document.body.innerHTML = '<div class="tt-pane-body"><p>left</p></div><div class="tt-pane-body"><div data-item-id="i1" tabindex="0">risk one</div></div>'
    return Array.from(document.querySelectorAll<HTMLElement>('.tt-pane-body'))
  }

  test('with an itemId: on the next frame, tells that pane to reveal it, then flashes its row', () => {
    const panes = twoPanes()
    const seen: string[] = []
    panes[1]!.addEventListener(SEARCH_FOCUS_ITEM_EVENT, (e) => seen.push((e as CustomEvent<string>).detail))

    focusItemInPane(1, 'i1')
    expect(seen).toEqual([]) // nothing until the frame: the pane body is only now being rendered
    frames.forEach((f) => f(0))

    expect(seen).toEqual(['i1'])
    expect(document.querySelector('[data-item-id="i1"]')!.classList.contains('tt-search-target-flash')).toBe(true)
  })

  test('with terms only: highlights within the pane, dispatches no item event, flashes nothing', () => {
    const panes = twoPanes()
    const seen = vi.fn()
    panes[0]!.addEventListener(SEARCH_FOCUS_ITEM_EVENT, seen)

    focusItemInPane(0, undefined, ['left'])
    frames.forEach((f) => f(0))

    expect(seen).not.toHaveBeenCalled()
    expect(document.querySelector('.tt-search-target-flash')).toBeNull()
  })

  test('with neither an itemId nor terms: schedules nothing', () => {
    twoPanes()
    focusItemInPane(0, undefined)
    expect(frames).toHaveLength(0)
  })
})
