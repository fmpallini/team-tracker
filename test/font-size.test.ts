import { FONT_SIZES, FONT_SIZE_SCALE, fontScale, stepFontSize } from '../src/core/font-size'

test('FONT_SIZES is the five steps, smallest to largest', () => {
  expect(FONT_SIZES).toEqual(['XS', 'S', 'M', 'L', 'XL'])
})

test('stepping up moves one step toward larger', () => {
  expect(stepFontSize('M', 1)).toBe('L')
  expect(stepFontSize('XS', 1)).toBe('S')
})

test('stepping down moves one step toward smaller', () => {
  expect(stepFontSize('M', -1)).toBe('S')
  expect(stepFontSize('XL', -1)).toBe('L')
})

test('stepping up at the largest stays at the largest', () => {
  expect(stepFontSize('XL', 1)).toBe('XL')
})

test('stepping down at the smallest stays at the smallest', () => {
  expect(stepFontSize('XS', -1)).toBe('XS')
})

test('fontScale is root px relative to M (15px), 1 when unknown', () => {
  const px = { XS: 12, S: 13.5, M: 15, L: 16.5, XL: 18 } as const
  for (const size of FONT_SIZES) expect(FONT_SIZE_SCALE[size]).toBeCloseTo(px[size] / 15, 5)
  expect(fontScale('XL')).toBe(1.2)
  expect(fontScale(undefined)).toBe(1)
})
