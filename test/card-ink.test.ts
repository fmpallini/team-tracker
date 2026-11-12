import { chipFill, syncCardInk, CARD_COLORS } from '../src/core/card-ink'

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

test('a fill the ink already reads on is left as it is', () => {
  expect(chipFill('#3b5a6b', '#ffffff')).toBe('#3b5a6b')
  expect(chipFill('#d4a84a', '#1c1a14')).toBe('#d4a84a')
})

test('a fill too light for white ink is darkened just enough, keeping its hue', () => {
  const out = chipFill('#b8862e', '#ffffff')!
  expect(contrast('#ffffff', out)).toBeGreaterThanOrEqual(4.5)
  // the smallest step: one step less would not read
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(out.slice(i, i + 2), 16))
  expect(r).toBeGreaterThan(g!)
  expect(g).toBeGreaterThan(b!) // still a brass, not a grey
})

test('a fill too dark for a dark ink is lightened just enough', () => {
  const out = chipFill('#3b5a6b', '#1c1a14')!
  expect(contrast('#1c1a14', out)).toBeGreaterThanOrEqual(4.5)
})

test('every fill reaches WCAG AA (4.5:1) under either ink', () => {
  const samples: string[] = []
  for (let v = 0; v < 256; v += 5) {
    const h = v.toString(16).padStart(2, '0')
    samples.push(`#${h}${h}${h}`, `#${h}8000`, `#00${h}80`, `#8000${h}`, `#ff${h}00`)
  }
  for (const ink of ['#ffffff', '#1c1a14', '#0b0b0d']) {
    for (const fill of samples) expect(contrast(ink, chipFill(fill, ink)!), `${fill} under ${ink}`).toBeGreaterThanOrEqual(4.5)
  }
})

test('an unparseable value gets no fill', () => {
  expect(chipFill('', '#ffffff')).toBeNull()
  expect(chipFill('var(--x)', '#ffffff')).toBeNull()
})

test('syncCardInk: white ink on a light page, the page color on a dark one, and a fill per card color', () => {
  const root = document.documentElement
  root.style.setProperty('--bg', '#eee7d6')
  root.style.setProperty('--card-slate', '#3b5a6b')
  root.style.setProperty('--card-brass', ' #b8862e')
  syncCardInk()
  expect(root.style.getPropertyValue('--on-chip')).toBe('#ffffff')
  expect(root.style.getPropertyValue('--chip-slate')).toBe('#3b5a6b')
  expect(contrast('#ffffff', root.style.getPropertyValue('--chip-brass'))).toBeGreaterThanOrEqual(4.5)
  // Not defined (e.g. jsdom without the stylesheet): left to the stylesheet's own default.
  expect(root.style.getPropertyValue('--chip-sage')).toBe('')

  root.style.setProperty('--bg', '#1c1a14')
  syncCardInk()
  expect(root.style.getPropertyValue('--on-chip')).toBe('#1c1a14')
  expect(contrast('#1c1a14', root.style.getPropertyValue('--chip-slate'))).toBeGreaterThanOrEqual(4.5)
  expect(CARD_COLORS).toEqual(['slate', 'brass', 'sage', 'rust', 'plum', 'ledger'])
})
