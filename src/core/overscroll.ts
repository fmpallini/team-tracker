// src/core/overscroll.ts — the tuned constants and the pure resistance curve
// behind daily-notes.ts's "push past the top/bottom edge to jump to the
// nearest day that has a note" gesture (a macOS-style rubber band +
// Chrome-overscroll-to-navigate commit).
//
// Only the maths lives here so it can be unit-tested without a DOM; the wheel
// listener, the CSS transform and the rAF spring-back animation stay in the
// module renderer. Values were tuned in prototypes/daily-overscroll.html.

export const OVERSCROLL = {
  /**
   * macOS rubber-band coefficient: the *initial* slope of resisted-vs-raw
   * travel at the edge (resisted px gained per raw wheel px). Lower = firmer
   * wall, so more wheel distance is needed before anything moves far.
   */
  resistanceCoeff: 0.31,
  /** Resisted travel past the edge, in px, that commits the day flip. */
  commitThresholdPx: 170,
  /** Spring-back animation length when the pull is released below threshold. */
  springBackMs: 320,
  /** Ease-out cubic — the spring-back curve. */
  springBackEasing: 'cubic' as const,
  /**
   * With no further wheel delta for this long — and still below threshold —
   * the pull is considered released and springs back. Must comfortably
   * outlast the gap between mouse-wheel notches (~100-500ms) or two
   * deliberate notches would never stack.
   */
  idleReleaseMs: 490,
}

/**
 * Resisted overscroll distance for `rawPx` of accumulated wheel travel past
 * the edge, given the scroll viewport height `viewportPx`. Approaches
 * `viewportPx` asymptotically, so the content can never be dragged off
 * screen however hard the user pushes. Returns 0 for non-positive input.
 */
export function rubberBand(
  rawPx: number,
  viewportPx: number,
  coeff: number = OVERSCROLL.resistanceCoeff,
): number {
  if (rawPx <= 0 || viewportPx <= 0) return 0
  return (1 - 1 / ((rawPx * coeff) / viewportPx + 1)) * viewportPx
}

/** Ease-out cubic on a 0..1 progress value. */
export function easeOutCubic(p: number): number {
  const c = Math.min(Math.max(p, 0), 1)
  return 1 - Math.pow(1 - c, 3)
}

/**
 * True once `rawPx` of raw wheel travel resists to at least the commit
 * threshold for a viewport of `viewportPx`. Thin wrapper over `rubberBand`
 * kept as its own function so the wheel handler reads declaratively and the
 * threshold logic has a direct unit test.
 */
export function overscrollCommits(
  rawPx: number,
  viewportPx: number,
  coeff: number = OVERSCROLL.resistanceCoeff,
  thresholdPx: number = OVERSCROLL.commitThresholdPx,
): boolean {
  return rubberBand(rawPx, viewportPx, coeff) >= thresholdPx
}
