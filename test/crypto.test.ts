import { encryptDocument, decryptDocument, resetSessionKey, WrongPasswordError, CorruptFileError, serializePlain, parsePlain } from '../src/core/crypto'
import { createEmptyDocument, SCHEMA_VERSION, SchemaTooNewError } from '../src/core/document'

test('round-trip', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, 's3cret')
  expect(await decryptDocument(bytes, 's3cret')).toEqual(doc)
}, 20000)

test('wrong password', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'right')
  await expect(decryptDocument(bytes, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('same password typed with different Unicode normalization still opens the file', async () => {
  // pt-BR passwords routinely carry accents. The same visible password can
  // arrive as a different JS string depending on OS/keyboard/IME composition
  // (NFC vs NFD) even though the user typed identically-looking characters.
  const nfc = 'café'.normalize('NFC')
  const nfd = 'café'.normalize('NFD')
  expect(nfc).not.toBe(nfd) // sanity: these really are distinct JS strings
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), nfc)
  await expect(decryptDocument(bytes, nfd)).resolves.toBeTruthy()
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

// --- Field-by-field tamper matrix ---------------------------------------
// Layout: magic(0-3) version(4) salt(5-20) ivKcv(21-32) kcv(33-64) ivData(65-76) data(77+)

test('tampering the salt makes the key-check block fail authentication (reported as wrong password)', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[10] = bytes[10]! ^ 0xff // inside salt range
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('tampering the key-check IV fails GCM auth on the key-check block (reported as wrong password)', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[25] = bytes[25]! ^ 0xff // inside ivKcv range
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('tampering the key-check ciphertext fails GCM auth on the key-check block (reported as wrong password)', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[40] = bytes[40]! ^ 0xff // inside kcv range
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('tampering the data IV passes the key-check but fails the body decrypt (reported as corrupt)', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[70] = bytes[70]! ^ 0xff // inside ivData range, past the key-check block
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
}, 20000)

test('format version mismatch is reported as corrupt, not wrong password', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[4] = 99
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
}, 20000)

test('single-byte magic corruption is reported as corrupt', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  bytes[0] = bytes[0]! ^ 0xff
  await expect(decryptDocument(bytes, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
}, 20000)

test('truncated file (header cut short) is reported as corrupt, not a crash', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  for (const cut of [0, 1, 5, 21, 33, 65, 77]) {
    await expect(decryptDocument(bytes.slice(0, cut), 'pw')).rejects.toBeInstanceOf(CorruptFileError)
  }
}, 20000)

test('empty file is reported as corrupt, not a crash', async () => {
  await expect(decryptDocument(new Uint8Array(0), 'pw')).rejects.toBeInstanceOf(CorruptFileError)
})

// --- Password edge cases -------------------------------------------------

test('empty-string password round-trips and is distinguishable from a non-empty one', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, '')
  await expect(decryptDocument(bytes, '')).resolves.toEqual(doc)
  await expect(decryptDocument(bytes, 'x')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('very long password round-trips', async () => {
  const doc = createEmptyDocument('pt-BR')
  const longPw = 'p'.repeat(10_000)
  const bytes = await encryptDocument(doc, longPw)
  await expect(decryptDocument(bytes, longPw)).resolves.toEqual(doc)
}, 20000)

test('leading/trailing whitespace is significant — not trimmed away', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  await expect(decryptDocument(bytes, ' pw')).rejects.toBeInstanceOf(WrongPasswordError)
  await expect(decryptDocument(bytes, 'pw ')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('password is case-sensitive', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'Password')
  await expect(decryptDocument(bytes, 'password')).rejects.toBeInstanceOf(WrongPasswordError)
}, 20000)

test('emoji/surrogate-pair passwords round-trip', async () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, '🔒🚀pw')
  await expect(decryptDocument(bytes, '🔒🚀pw')).resolves.toEqual(doc)
}, 20000)

// --- Concurrency ----------------------------------------------------------

test('concurrent decrypts of two different files under different passwords do not cross-contaminate the session key cache', async () => {
  resetSessionKey()
  const docA = createEmptyDocument('pt-BR')
  const docB = createEmptyDocument('en-US')
  const bytesA = await encryptDocument(docA, 'password-a')
  resetSessionKey()
  const bytesB = await encryptDocument(docB, 'password-b')

  const [resA, resB] = await Promise.all([
    decryptDocument(bytesA, 'password-a'),
    decryptDocument(bytesB, 'password-b'),
  ])
  expect(resA).toEqual(docA)
  expect(resB).toEqual(docB)
  resetSessionKey()
}, 20000)

test('a wrong-password attempt racing a correct one does not poison the cache for the correct attempt', async () => {
  resetSessionKey()
  const doc = createEmptyDocument('pt-BR')
  const bytes = await encryptDocument(doc, 'right-pw')
  resetSessionKey()

  const results = await Promise.allSettled([
    decryptDocument(bytes, 'wrong-pw'),
    decryptDocument(bytes, 'right-pw'),
  ])
  expect(results[0]!.status).toBe('rejected')
  expect(results[1]).toEqual({ status: 'fulfilled', value: doc })
  resetSessionKey()
}, 20000)

// --- Plain (password-less) file format ---

test('serializePlain/parsePlain round-trip', () => {
  const doc = createEmptyDocument('pt-BR')
  const bytes = serializePlain(doc)
  expect(parsePlain(bytes)).toEqual(doc)
})

test('serializePlain output starts with the ASCII TMV-PLAIN tag, human-readable', () => {
  const doc = createEmptyDocument('en-US')
  const bytes = serializePlain(doc)
  const text = new TextDecoder().decode(bytes)
  expect(text.startsWith('TMV-PLAIN\n')).toBe(true)
  expect(JSON.parse(text.slice('TMV-PLAIN\n'.length))).toEqual(doc)
})

test('parsePlain returns null for encrypted-file bytes (no tag match)', async () => {
  const bytes = await encryptDocument(createEmptyDocument('pt-BR'), 'pw')
  expect(parsePlain(bytes)).toBeNull()
})

test('parsePlain returns null for garbage/empty bytes', () => {
  expect(parsePlain(new Uint8Array(0))).toBeNull()
  expect(parsePlain(new TextEncoder().encode('not a tmv file'))).toBeNull()
})

test('parsePlain throws CorruptFileError when the tag matches but the JSON body is broken', () => {
  const bytes = new TextEncoder().encode('TMV-PLAIN\n{not valid json')
  expect(() => parsePlain(bytes)).toThrow(CorruptFileError)
})

test('parsePlain runs migrate() on an old-schema plain payload', () => {
  const oldDoc = { ...createEmptyDocument('en-US'), schemaVersion: 1 }
  delete (oldDoc.nav as any).teamSplit
  const bytes = new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(oldDoc))
  const parsed = parsePlain(bytes)
  expect(parsed?.schemaVersion).toBe(SCHEMA_VERSION)
  expect(parsed?.nav.teamSplit).toEqual({})
})

test('parsePlain rejects a plain file claiming a newer schema than this build supports', () => {
  const futureDoc = { ...createEmptyDocument('en-US'), schemaVersion: SCHEMA_VERSION + 1 }
  const bytes = new TextEncoder().encode('TMV-PLAIN\n' + JSON.stringify(futureDoc))
  expect(() => parsePlain(bytes)).toThrow(SchemaTooNewError)
})
