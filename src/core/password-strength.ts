export type Strength = 'weak' | 'fair' | 'good' | 'strong'

/**
 * Deliberately crude heuristic, not a real entropy estimate (no zxcvbn —
 * zero runtime dependencies is a hard project constraint, see CLAUDE.md).
 * Good enough to nudge users toward longer/more varied passwords; makes no
 * claim about real attacker cost.
 */
export function estimateStrength(pw: string): Strength {
  if (pw.length < 8) return 'weak'

  let classes = 0
  if (/[a-z]/.test(pw)) classes++
  if (/[A-Z]/.test(pw)) classes++
  if (/[0-9]/.test(pw)) classes++
  if (/[^a-zA-Z0-9]/.test(pw)) classes++

  let score = classes
  if (pw.length >= 12) score++
  if (pw.length >= 16) score++

  if (score <= 1) return 'weak'
  if (score === 2) return 'fair'
  if (score === 3 || score === 4) return 'good'
  return 'strong'
}
