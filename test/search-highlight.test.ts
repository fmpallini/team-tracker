import { findMatchRanges, applySearchHighlight, clearSearchHighlight, SEARCH_FOCUS_ITEM_EVENT, dispatchSearchFocusItem } from '../src/ui/search-highlight'

afterEach(() => {
  document.body.innerHTML = ''
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

test('dispatchSearchFocusItem dispatches the event on the given container with itemId as detail', () => {
  const container = document.createElement('div')
  let received: string | null = null
  container.addEventListener(SEARCH_FOCUS_ITEM_EVENT, (e) => { received = (e as CustomEvent<string>).detail })

  dispatchSearchFocusItem(container, 'm1')

  expect(received).toBe('m1')
})
