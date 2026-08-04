import { createPasswordMeter } from '../src/ui/password-meter'

test('hidden (no visible label) when the password is empty', () => {
  const meter = createPasswordMeter('en-US')
  meter.update('')
  expect(meter.el.style.visibility).toBe('hidden')
})

test('shows the matching strength label and fills the right number of segments', () => {
  const meter = createPasswordMeter('en-US')
  meter.update('Tr0ub4dor&3xtra!') // strong, per password-strength.test.ts
  expect(meter.el.style.visibility).toBe('visible')
  expect(meter.el.querySelector('.tt-pwmeter-label')?.textContent).toBe('Strong')
  const filled = meter.el.querySelectorAll('.tt-pwmeter-seg-filled')
  expect(filled.length).toBe(4)
})

test('weak password fills exactly one segment', () => {
  const meter = createPasswordMeter('en-US')
  meter.update('a')
  expect(meter.el.querySelector('.tt-pwmeter-label')?.textContent).toBe('Weak')
  expect(meter.el.querySelectorAll('.tt-pwmeter-seg-filled').length).toBe(1)
})

test('locale is respected', () => {
  const meter = createPasswordMeter('pt-BR')
  meter.update('a')
  expect(meter.el.querySelector('.tt-pwmeter-label')?.textContent).toBe('Fraca')
})

test('clears stale strength classes when strength decreases', () => {
  const meter = createPasswordMeter('en-US')
  // First update: strong password (all 4 segments filled with tt-pwmeter-strong)
  meter.update('Tr0ub4dor&3xtra!')
  expect(meter.el.querySelectorAll('.tt-pwmeter-strong').length).toBe(4)
  // Second update: weak password (only 1 segment, should be tt-pwmeter-weak, not tt-pwmeter-strong)
  meter.update('a')
  expect(meter.el.querySelectorAll('.tt-pwmeter-strong').length).toBe(0)
  expect(meter.el.querySelectorAll('.tt-pwmeter-weak').length).toBe(1)
  // Verify the filled segment is weak, not strong
  const filledSegs = meter.el.querySelectorAll('.tt-pwmeter-seg-filled')
  expect(filledSegs.length).toBe(1)
  expect((filledSegs[0] as HTMLElement).classList.contains('tt-pwmeter-weak')).toBe(true)
  expect((filledSegs[0] as HTMLElement).classList.contains('tt-pwmeter-strong')).toBe(false)
})
