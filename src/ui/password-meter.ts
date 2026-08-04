import { estimateStrength, type Strength } from '../core/password-strength'
import { t, type Locale, type MsgKey } from '../core/i18n'
import { el } from './dom'

const STRENGTH_KEY: Record<Strength, MsgKey> = {
  weak: 'pwstrength_weak',
  fair: 'pwstrength_fair',
  good: 'pwstrength_good',
  strong: 'pwstrength_strong',
}
const STRENGTH_SEGMENTS: Record<Strength, number> = { weak: 1, fair: 2, good: 3, strong: 4 }
const SEGMENT_COUNT = 4

export interface PasswordMeter {
  el: HTMLElement
  update(pw: string): void
}

export function createPasswordMeter(locale: Locale): PasswordMeter {
  const segments = Array.from({ length: SEGMENT_COUNT }, () => el('span', { class: 'tt-pwmeter-seg' }))
  const label = el('span', { class: 'tt-pwmeter-label' })
  const root = el('div', { class: 'tt-pwmeter' }, el('div', { class: 'tt-pwmeter-bar' }, ...segments), label)

  function update(pw: string): void {
    if (pw.length === 0) {
      root.style.visibility = 'hidden'
      return
    }
    root.style.visibility = 'visible'
    const strength = estimateStrength(pw)
    const filled = STRENGTH_SEGMENTS[strength]
    segments.forEach((seg, i) => {
      seg.classList.toggle('tt-pwmeter-seg-filled', i < filled)
      seg.classList.toggle(`tt-pwmeter-${strength}`, i < filled)
    })
    label.textContent = t(locale, STRENGTH_KEY[strength])
  }

  update('')
  return { el: root, update }
}
