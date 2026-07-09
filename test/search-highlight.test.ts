import { findMatchRanges, applySearchHighlight, clearSearchHighlight } from '../src/ui/search-highlight'

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
  expect(() => applySearchHighlight(root, ['x'])).not.toThrow()
})

test('clearSearchHighlight is a safe no-op when nothing was ever highlighted', () => {
  expect(() => clearSearchHighlight()).not.toThrow()
})
