import { decodeForReload, ReloadCancelledError } from '../src/core/reload-document'
import { encryptDocument, serializePlain, resetSessionKey, CorruptFileError } from '../src/core/crypto'
import { createEmptyDocument } from '../src/core/document'

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
  const r = await decodeForReload(serializePlain(docWith('L')), 'old', ask)
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
