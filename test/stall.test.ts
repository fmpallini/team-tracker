import { stall, StallError, STALL_MS } from '../src/core/stall'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('a call that answers in time settles as itself, and leaves no timer behind', async () => {
  await expect(stall(Promise.resolve(7), 'step')).resolves.toBe(7)
  expect(vi.getTimerCount()).toBe(0)
})

test('a rejection in time passes through unchanged', async () => {
  const boom = new Error('boom')
  await expect(stall(Promise.reject(boom), 'step')).rejects.toBe(boom)
  expect(vi.getTimerCount()).toBe(0)
})

test('a call that never answers rejects with a StallError naming the step once the deadline passes', async () => {
  const result = stall(new Promise<never>(() => {}), 'IndexedDB open (x)')
  const assertion = expect(result).rejects.toSatisfy((e: unknown) =>
    e instanceof StallError && e.step === 'IndexedDB open (x)' && e.message.includes('IndexedDB open (x)'))
  await vi.advanceTimersByTimeAsync(STALL_MS - 1)
  await vi.advanceTimersByTimeAsync(1)
  await assertion
})

test('just before the deadline the call still wins', async () => {
  let answer: (v: string) => void = () => {}
  const result = stall(new Promise<string>((r) => { answer = r }), 'step')
  await vi.advanceTimersByTimeAsync(STALL_MS - 1)
  answer('ok')
  await expect(result).resolves.toBe('ok')
})

test('an answer after the deadline goes to onLate, so the caller can release it', async () => {
  let answer: (v: string) => void = () => {}
  const onLate = vi.fn()
  const result = stall(new Promise<string>((r) => { answer = r }), 'step', { ms: 100, onLate })
  const assertion = expect(result).rejects.toBeInstanceOf(StallError)
  await vi.advanceTimersByTimeAsync(100)
  await assertion
  answer('late')
  await Promise.resolve()
  await Promise.resolve()
  expect(onLate).toHaveBeenCalledWith('late')
})
