import { encryptDocument, decryptDocument, WrongPasswordError, CorruptFileError } from '../src/core/crypto'
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
