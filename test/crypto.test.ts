import { encryptDocument, decryptDocument, resetSessionKey, WrongPasswordError, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument } from '../src/core/document'

test('round-trip', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, 's3cret')
  expect(await decryptDocument(bytes, 's3cret')).toEqual(doc)
}, 20000)

test('wrong password', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'right')
  await expect(decryptDocument(bytes, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('corrupted body', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  const last = bytes.length - 1
  bytes[last] = bytes[last]! ^ 0xff
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
}, 20000)

test('bad magic', async () => {
  await expect(decryptDocument(new Uint8Array(100), 'pw')).rejects.toBeInstanceOf(CorruptFileError)
})

test('same-password saves reuse the derived key (only one PBKDF2 derivation)', async () => {
  const spy = vi.spyOn(crypto.subtle, 'deriveKey')
  const doc = createEmptyDocument('pt-BR')
  await encryptDocument(doc, 'cache-me')
  const callsAfterFirst = spy.mock.calls.length
  await encryptDocument(doc, 'cache-me')
  await encryptDocument(doc, 'cache-me')
  expect(spy.mock.calls.length).toBe(callsAfterFirst)
  spy.mockRestore()
}, 20000)

test('a password change invalidates the cached key (fresh PBKDF2 derivation)', async () => {
  const doc = createEmptyDocument('pt-BR')
  await encryptDocument(doc, 'first-pw')
  const spy = vi.spyOn(crypto.subtle, 'deriveKey')
  await encryptDocument(doc, 'second-pw')
  expect(spy).toHaveBeenCalledTimes(1)
  spy.mockRestore()
}, 20000)

test('decrypting with the same password+salt just used to encrypt reuses the cached key', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, 'round-trip-cache')
  const spy = vi.spyOn(crypto.subtle, 'deriveKey')
  expect(await decryptDocument(bytes, 'round-trip-cache')).toEqual(doc)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
}, 20000)

test('resetSessionKey forces a fresh salt for a new document under the same password (closeFile -> create new)', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytesA = await encryptDocument(doc, 'shared-pw')
  const saltA = bytesA.slice(5, 21)

  resetSessionKey()

  const bytesB = await encryptDocument(doc, 'shared-pw')
  const saltB = bytesB.slice(5, 21)
  expect(saltB).not.toEqual(saltA)
}, 20000)

test('without resetSessionKey, a new document under the same password would wrongly inherit the old salt', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytesA = await encryptDocument(doc, 'no-reset-pw')
  const saltA = bytesA.slice(5, 21)

  // No resetSessionKey() call here — demonstrates the bug resetSessionKey
  // exists to prevent: without it, two unrelated documents under the same
  // password would silently share a salt (and thus a key).
  const bytesB = await encryptDocument(doc, 'no-reset-pw')
  const saltB = bytesB.slice(5, 21)
  expect(saltB).toEqual(saltA)

  resetSessionKey() // don't leak this test's cache into whichever runs next
}, 20000)
