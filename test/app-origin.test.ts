import { computeAppOrigin } from '../scripts/app-origin.mjs'

test('computeAppOrigin resolves to the site origin, not pkg.homepage\'s subpath', () => {
  expect(computeAppOrigin('https://fmpallini.github.io/team-tracker/')).toBe('https://fmpallini.github.io/')
})

test('computeAppOrigin returns "" when package.json has no homepage', () => {
  expect(computeAppOrigin(undefined)).toBe('')
  expect(computeAppOrigin('')).toBe('')
})
