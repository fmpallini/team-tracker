import { newStamp, randomHex } from '../src/core/file-stamp'

test('randomHex gives lowercase hex of the requested byte length', () => {
  expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/)
  expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/)
})

test('ids do not repeat across 1000 calls', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) seen.add(newStamp().writeId)
  expect(seen.size).toBe(1000)
})

test('newStamp carries a 32-hex writeId and the given time', () => {
  const s = newStamp(5)
  expect(s.writeId).toMatch(/^[0-9a-f]{32}$/)
  expect(s.savedAt).toBe(5)
})

test('newStamp defaults savedAt to the wall clock', () => {
  const before = Date.now()
  const s = newStamp()
  expect(s.savedAt).toBeGreaterThanOrEqual(before)
  expect(s.savedAt).toBeLessThanOrEqual(Date.now())
})
