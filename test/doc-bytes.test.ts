import { docToBytes } from '../src/core/doc-bytes'
import { decryptDocument, parsePlain, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument } from '../src/core/document'

test('a null password yields a readable TMV-PLAIN file that parses back to the same document', async () => {
  const doc = createEmptyDocument('en-US')

  const bytes = await docToBytes(doc, null)

  expect(new TextDecoder().decode(bytes.slice(0, 10))).toBe('TMV-PLAIN\n')
  expect(parsePlain(bytes)).toEqual(doc)
})

test('a password yields an encrypted TMV1 file that only that password opens', async () => {
  const doc = createEmptyDocument('en-US')

  const bytes = await docToBytes(doc, 'correct horse')

  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('TMV1')
  expect(new TextDecoder().decode(bytes)).not.toContain('TMV-PLAIN')
  expect(await decryptDocument(bytes, 'correct horse')).toEqual(doc)
  await expect(decryptDocument(bytes, 'wrong')).rejects.toThrow()
})

test('a document that fails validation is refused, so a file the app would not reopen is never written', async () => {
  const doc = createEmptyDocument('en-US')
  ;(doc as unknown as { teams: unknown }).teams = 'not an array'

  await expect(docToBytes(doc, null)).rejects.toMatchObject({ path: 'teams' })
  await expect(docToBytes(doc, 'pw')).rejects.toBeInstanceOf(CorruptFileError)
})
