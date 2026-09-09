import { OVERSCROLL, rubberBand, easeOutCubic, overscrollCommits } from '../src/core/overscroll'

describe('rubberBand', () => {
  it('is 0 at or below the edge, and for a degenerate viewport', () => {
    expect(rubberBand(0, 600)).toBe(0)
    expect(rubberBand(-50, 600)).toBe(0)
    expect(rubberBand(100, 0)).toBe(0)
  })

  it('grows monotonically with raw travel', () => {
    let prev = 0
    for (let raw = 10; raw <= 2000; raw += 10) {
      const r = rubberBand(raw, 600)
      expect(r).toBeGreaterThan(prev)
      prev = r
    }
  })

  it('never reaches the viewport height however hard you push', () => {
    expect(rubberBand(1e6, 600)).toBeLessThan(600)
    expect(rubberBand(1e9, 600)).toBeLessThan(600)
  })

  it('a lower coefficient resists harder (less travel for the same raw push)', () => {
    const soft = rubberBand(300, 600, 0.55)
    const firm = rubberBand(300, 600, 0.31)
    expect(firm).toBeLessThan(soft)
  })

  it('initial slope ≈ the coefficient near the edge', () => {
    const slope = rubberBand(1, 600, 0.31) / 1
    expect(slope).toBeGreaterThan(0.3)
    expect(slope).toBeLessThan(0.31)
  })
})

describe('overscrollCommits (default tuning)', () => {
  const H = 600

  it('does not commit for a light push', () => {
    expect(overscrollCommits(100, H)).toBe(false)
  })

  it('commits once resisted travel reaches the 170px threshold', () => {
    // with coeff 0.31 / H 600, ~765px of raw wheel resists to 170px
    expect(overscrollCommits(740, H)).toBe(false)
    expect(overscrollCommits(790, H)).toBe(true)
  })

  it('respects an overridden threshold', () => {
    expect(overscrollCommits(200, H, OVERSCROLL.resistanceCoeff, 40)).toBe(true)
  })
})

describe('easeOutCubic', () => {
  it('pins the endpoints and stays within range', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
  })

  it('decelerates — past halfway by the time progress is halfway', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })
})

describe('OVERSCROLL constants', () => {
  it('carry the values tuned in the prototype', () => {
    expect(OVERSCROLL).toMatchObject({
      resistanceCoeff: 0.31,
      commitThresholdPx: 170,
      springBackMs: 320,
      springBackEasing: 'cubic',
      idleReleaseMs: 490,
    })
  })
})
