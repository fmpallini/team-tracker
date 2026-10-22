import { docToBytes } from '../src/core/doc-bytes'
import { createImageStore } from '../src/core/image-store'
import { decodeForReload, ReloadCancelledError } from '../src/core/reload-document'
import { encryptDocument, serializePlain, resetSessionKey, blobCodec, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'

afterEach(() => resetSessionKey())

function docWith(size: 'S' | 'L') {
  const d = createEmptyDocument('en-US')
  d.prefs.fontSize = size
  return d
}

test('same password: decodes without ever asking', async () => {
  const bytes = await encryptDocument(docWith('L'), 'pw')
  const ask = vi.fn(async (_wasWrong: boolean): Promise<string | null> => 'never')
  const r = await decodeForReload(bytes, 'pw', ask)
  expect(r.password).toBe('pw')
  expect(r.doc.prefs.fontSize).toBe('L')
  expect(ask).not.toHaveBeenCalled()
})

test('the file is now password-less: opens it as plain and reports a null password', async () => {
  const ask = vi.fn(async (_wasWrong: boolean): Promise<string | null> => 'never')
  const r = await decodeForReload(await serializePlain(docWith('L')), 'old', ask)
  expect(r.password).toBeNull()
  expect(r.doc.prefs.fontSize).toBe('L')
  expect(ask).not.toHaveBeenCalled()
})

test('the file is now encrypted but the tab held it password-less: asks for the password', async () => {
  const bytes = await encryptDocument(docWith('L'), 'new')
  const ask = vi.fn(async (_wasWrong: boolean): Promise<string | null> => 'new')
  const r = await decodeForReload(bytes, null, ask)
  expect(ask).toHaveBeenCalledWith(false)
  expect(r.password).toBe('new')
})

test('the password was changed elsewhere: asks, and a wrong guess asks again flagged as wrong', async () => {
  const bytes = await encryptDocument(docWith('L'), 'new')
  const answers = ['typo', 'new']
  const ask = vi.fn(async (_wasWrong: boolean): Promise<string | null> => answers.shift() ?? null)
  const r = await decodeForReload(bytes, 'old', ask)
  expect(ask.mock.calls.map((c) => c[0])).toEqual([true, true])
  expect(r.password).toBe('new')
  expect(r.doc.prefs.fontSize).toBe('L')
})

test('cancelling the prompt rejects with ReloadCancelledError', async () => {
  const bytes = await encryptDocument(docWith('L'), 'new')
  await expect(decodeForReload(bytes, 'old', async () => null)).rejects.toBeInstanceOf(ReloadCancelledError)
})

test('a genuinely corrupt file is not mistaken for a password problem', async () => {
  const bytes = await encryptDocument(docWith('L'), 'pw')
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
  const ask = vi.fn(async (_wasWrong: boolean): Promise<string | null> => 'pw')
  await expect(decodeForReload(bytes, 'pw', ask)).rejects.toBeInstanceOf(CorruptFileError)
  expect(ask).not.toHaveBeenCalled()
})

test('hands back the image bytes of the file as it is now (encrypted)', async () => {
  const A = 'a'.repeat(32)
  const doc = docWith('S')
  doc.images = { [A]: { mime: 'image/webp', w: 1, h: 1, bytes: 3 } }
  doc.teams.push({ ...createEmptyTeam('T1', 'T', '', 'en-US'), generalNotes: `![x](img:${A})` })
  const store = createImageStore(await blobCodec('pw'))
  store.putPlain(A, new Uint8Array([1, 2, 3]))
  const bytes = await docToBytes(doc, 'pw', store)
  const r = await decodeForReload(bytes, 'pw', async () => null)
  expect([...(await r.images.getPlain(A))!]).toEqual([1, 2, 3])
}, 30000)

test('hands back the image bytes of the file as it is now (password-less)', async () => {
  const A = 'a'.repeat(32)
  const doc = docWith('S')
  doc.images = { [A]: { mime: 'image/webp', w: 1, h: 1, bytes: 3 } }
  doc.teams.push({ ...createEmptyTeam('T1', 'T', '', 'en-US'), generalNotes: `![x](img:${A})` })
  const store = createImageStore(null)
  store.putPlain(A, new Uint8Array([1, 2, 3]))
  const r = await decodeForReload(await docToBytes(doc, null, store), null, async () => null)
  expect(r.password).toBeNull()
  expect([...(await r.images.getPlain(A))!]).toEqual([1, 2, 3])
})

test('reports the write stamp of the file it decoded, plain or encrypted, so the browser copy can adopt that lineage', async () => {
  const stamp = { writeId: 'ab'.repeat(16), savedAt: 5 }
  const doc = createEmptyDocument('en-US')
  const plain = await decodeForReload(await docToBytes(doc, null, createImageStore(null), stamp), null, async () => null)
  expect(plain.stamp).toEqual(stamp)
  const enc = await decodeForReload(await docToBytes(doc, 'pw', createImageStore(await blobCodec('pw')), stamp), 'pw', async () => null)
  expect(enc.stamp).toEqual(stamp)
  const bare = await decodeForReload(await serializePlain(doc), null, async () => null)
  expect(bare.stamp).toBeNull()
}, 30000)
