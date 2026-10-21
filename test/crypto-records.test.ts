import { recordCodec, blobCodec, resetSessionKey, CorruptFileError } from '../src/core/crypto'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

beforeEach(() => resetSessionKey())

test('seal then open round-trips', async () => {
  const codec = await recordCodec('pw')
  const sealed = await codec.seal('rec-1', enc('hello'))
  expect(dec(await codec.open('rec-1', sealed))).toBe('hello')
}, 30000)

test('opening under another aad fails with CorruptFileError', async () => {
  const codec = await recordCodec('pw')
  const sealed = await codec.seal('rec-1', enc('hello'))
  await expect(codec.open('rec-2', sealed)).rejects.toBeInstanceOf(CorruptFileError)
}, 30000)

test('a truncated or tampered record fails with CorruptFileError', async () => {
  const codec = await recordCodec('pw')
  const sealed = await codec.seal('a', enc('hello'))
  await expect(codec.open('a', sealed.slice(0, 10))).rejects.toBeInstanceOf(CorruptFileError)
  const flipped = sealed.slice()
  flipped[flipped.length - 1]! ^= 1
  await expect(codec.open('a', flipped)).rejects.toBeInstanceOf(CorruptFileError)
}, 30000)

test('two seals of the same plaintext differ (fresh IV)', async () => {
  const codec = await recordCodec('pw')
  const a = await codec.seal('a', enc('same'))
  const b = await codec.seal('a', enc('same'))
  expect(a).not.toEqual(b)
}, 30000)

test('records and image blobs are domain-separated: neither codec opens the other\'s output', async () => {
  const rec = await recordCodec('pw')
  const blob = await blobCodec('pw')
  const sealedByRec = await rec.seal('x', enc('data'))
  const sealedByBlob = await blob.seal('x', enc('data'))
  await expect(blob.open('x', sealedByRec)).rejects.toBeInstanceOf(CorruptFileError)
  await expect(rec.open('x', sealedByBlob)).rejects.toBeInstanceOf(CorruptFileError)
}, 30000)

test('without a salt it shares the file header\'s salt and key (blobCodec / session key)', async () => {
  const rec = await recordCodec('pw')
  const blob = await blobCodec('pw')
  expect(rec.salt).toEqual(blob.header!.salt)
}, 30000)

test('check block verifies under the same password and salt, not under another password', async () => {
  const codec = await recordCodec('pw')
  const check = await codec.makeCheck()
  expect(await codec.verifyCheck(check)).toBe(true)
  const same = await recordCodec('pw', codec.salt)
  expect(await same.verifyCheck(check)).toBe(true)
  const other = await recordCodec('other', codec.salt)
  expect(await other.verifyCheck(check)).toBe(false)
}, 60000)

test('verifyCheck never throws on malformed input', async () => {
  const codec = await recordCodec('pw')
  expect(await codec.verifyCheck(new Uint8Array(3))).toBe(false)
  expect(await codec.verifyCheck(new Uint8Array(0))).toBe(false)
  expect(await codec.verifyCheck(crypto.getRandomValues(new Uint8Array(40)))).toBe(false)
}, 30000)

test('a codec for a different salt does not evict the session key', async () => {
  const blob = await blobCodec('pw')
  const original = blob.header!.salt
  const foreign = crypto.getRandomValues(new Uint8Array(16))
  const other = await recordCodec('pw', foreign)
  expect(other.salt).toEqual(foreign)
  expect((await blobCodec('pw')).header!.salt).toEqual(original)
}, 60000)
