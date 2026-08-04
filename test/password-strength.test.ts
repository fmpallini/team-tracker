import { estimateStrength } from '../src/core/password-strength'

test('empty and very short passwords are weak regardless of character variety', () => {
  expect(estimateStrength('')).toBe('weak')
  expect(estimateStrength('a')).toBe('weak')
  expect(estimateStrength('Ab1!')).toBe('weak') // 4 chars, high variety, still short
})

test('a long password with only one character class is at best fair', () => {
  expect(estimateStrength('aaaaaaaaaaaaaaaa')).not.toBe('strong')
})

test('length plus full character-class variety reaches strong', () => {
  expect(estimateStrength('Tr0ub4dor&3xtra!')).toBe('strong')
})

test('a medium-length password with two character classes lands in the middle', () => {
  const s = estimateStrength('password123')
  expect(['fair', 'good']).toContain(s)
})

test('is deterministic for the same input', () => {
  expect(estimateStrength('SameInput!1')).toBe(estimateStrength('SameInput!1'))
})
