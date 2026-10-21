import { docToBytes } from '../src/core/doc-bytes'
import { decryptDocument, decryptDocumentWithVersion, parsePlain, parsePlainWithVersion, blobCodec, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createImageStore } from '../src/core/image-store'

test('a null password yields a readable TMV-PLAIN2 file that parses back to the same document', async () => {
  const doc = createEmptyDocument('en-US')

  const bytes = await docToBytes(doc, null, createImageStore(null))

  expect(new TextDecoder().decode(bytes.slice(0, 11))).toBe('TMV-PLAIN2\n')
  expect(parsePlain(bytes)).toEqual(doc)
})

test('a password yields an encrypted TMV1 file that only that password opens', async () => {
  const doc = createEmptyDocument('en-US')

  const bytes = await docToBytes(doc, 'correct horse', createImageStore(null))

  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('TMV1')
  expect(new TextDecoder().decode(bytes)).not.toContain('TMV-PLAIN')
  expect(await decryptDocument(bytes, 'correct horse')).toEqual(doc)
  await expect(decryptDocument(bytes, 'wrong')).rejects.toThrow()
})

test('a document that fails validation is refused, so a file the app would not reopen is never written', async () => {
  const doc = createEmptyDocument('en-US')
  ;(doc as unknown as { teams: unknown }).teams = 'not an array'

  await expect(docToBytes(doc, null, createImageStore(null))).rejects.toMatchObject({ path: 'teams' })
  await expect(docToBytes(doc, 'pw', createImageStore(null))).rejects.toBeInstanceOf(CorruptFileError)
})

describe('image sweep', () => {
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)
  const meta = { mime: 'image/webp', w: 1, h: 1, bytes: 3 }

  function docWithTwoImages() {
    const doc = createEmptyDocument('en-US')
    const team = createEmptyTeam('T1', 'Team', '', 'en-US')
    team.dailyNotes['2026-01-01'] = `see\n\n![shot](img:${A})\n`
    doc.teams.push(team)
    doc.images = { [A]: { ...meta }, [B]: { ...meta } }
    return doc
  }

  it('writes only the referenced images and leaves doc.images untouched in memory', async () => {
    const doc = docWithTwoImages()
    const store = createImageStore(null)
    store.putPlain(A, new Uint8Array([1, 2, 3]))
    store.putPlain(B, new Uint8Array([4, 5, 6]))

    const bytes = await docToBytes(doc, null, store)

    const opened = parsePlainWithVersion(bytes)!
    expect(Object.keys(opened.doc.images)).toEqual([A])
    expect([...(await opened.images.getPlain(A))!]).toEqual([1, 2, 3])
    expect(opened.images.has(B)).toBe(false)
    expect(Object.keys(doc.images).sort()).toEqual([A, B])
  })

  it('sweeps in encrypted files too', async () => {
    const doc = docWithTwoImages()
    const store = createImageStore(await blobCodec('pw'))
    store.putPlain(A, new Uint8Array([1, 2, 3]))
    store.putPlain(B, new Uint8Array([4, 5, 6]))

    const opened = await decryptDocumentWithVersion(await docToBytes(doc, 'pw', store), 'pw')

    expect(Object.keys(opened.doc.images)).toEqual([A])
    expect(opened.images.has(B)).toBe(false)
  }, 30000)

  it('a reference whose bytes are missing from the store still saves, without that image', async () => {
    const doc = docWithTwoImages()
    const bytes = await docToBytes(doc, null, createImageStore(null))

    const opened = parsePlainWithVersion(bytes)!
    expect(opened.doc.images).toEqual({})
    expect(opened.doc.teams[0]!.dailyNotes['2026-01-01']).toContain(`img:${A}`)
  })
})

test('undo after save: deleting a note drops its image from the file, restoring it writes the image again', async () => {
  const A = 'a'.repeat(32)
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  const note = `![shot](img:${A})`
  team.dailyNotes['2026-01-01'] = note
  doc.teams.push(team)
  doc.images = { [A]: { mime: 'image/webp', w: 1, h: 1, bytes: 3 } }
  const store = createImageStore(null)
  store.putPlain(A, new Uint8Array([1, 2, 3]))

  const withImage = parsePlainWithVersion(await docToBytes(doc, null, store))!
  expect(withImage.images.has(A)).toBe(true)

  delete team.dailyNotes['2026-01-01']
  const without = parsePlainWithVersion(await docToBytes(doc, null, store))!
  expect(without.images.has(A)).toBe(false)
  expect(Object.keys(doc.images)).toEqual([A])

  team.dailyNotes['2026-01-01'] = note
  const restored = parsePlainWithVersion(await docToBytes(doc, null, store))!
  expect([...(await restored.images.getPlain(A))!]).toEqual([1, 2, 3])
})

describe('file stamp', () => {
  it('stamps every write with a fresh writeId', async () => {
    const doc = createEmptyDocument('en-US')
    const a = parsePlainWithVersion(await docToBytes(doc, null, createImageStore(null)))!.stamp
    const b = parsePlainWithVersion(await docToBytes(doc, null, createImageStore(null)))!.stamp
    expect(a!.writeId).toMatch(/^[0-9a-f]{32}$/)
    expect(a!.writeId).not.toBe(b!.writeId)
  })

  it('writes a passed stamp verbatim', async () => {
    const stamp = { writeId: 'cd'.repeat(16), savedAt: 99 }
    const doc = createEmptyDocument('en-US')
    expect(parsePlainWithVersion(await docToBytes(doc, null, createImageStore(null), stamp))!.stamp).toEqual(stamp)
    const enc = await docToBytes(doc, 'pw', createImageStore(await blobCodec('pw')), stamp)
    expect((await decryptDocumentWithVersion(enc, 'pw')).stamp).toEqual(stamp)
  }, 20000)
})
