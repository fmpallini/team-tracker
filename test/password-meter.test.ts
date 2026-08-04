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
