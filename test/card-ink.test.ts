import { inkFor, syncCardInk, CARD_COLORS } from '../src/core/card-ink'

const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

test('dark fills get white ink, light fills get black ink', () => {
  expect(inkFor('#3b5a6b')).toBe('#ffffff')
  expect(inkFor('#d4a84a')).toBe('#000000')
})

test('the ink always reads at WCAG AA (4.5:1) — including the mid-tones where neither white nor a soft dark does', () => {
  // A sweep through every grey plus the hues of the mid-luminance band, where the crossover lives.
  const samples: string[] = []
  for (let v = 0; v < 256; v += 3) {
    const h = v.toString(16).padStart(2, '0')
    samples.push(`#${h}${h}${h}`, `#${h}8000`, `#00${h}80`, `#8000${h}`)
  }
  for (const fill of samples) expect(contrast(inkFor(fill)!, fill), fill).toBeGreaterThanOrEqual(4.5)
})

test('an unparseable value gets no ink', () => {
  expect(inkFor('')).toBeNull()
  expect(inkFor('var(--x)')).toBeNull()
})

test('syncCardInk writes an --on-card-<color> for each card color the stylesheet defines', () => {
  const root = document.documentElement
  root.style.setProperty('--card-slate', '#3b5a6b')
  root.style.setProperty('--card-brass', ' #d4a84a')
  syncCardInk()
  expect(root.style.getPropertyValue('--on-card-slate')).toBe('#ffffff')
  expect(root.style.getPropertyValue('--on-card-brass')).toBe('#000000')
  // Not defined (e.g. jsdom without the stylesheet): left to the stylesheet's own default.
  expect(root.style.getPropertyValue('--on-card-sage')).toBe('')
  expect(CARD_COLORS).toEqual(['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'])
})
