import { createChangePassword } from '../src/core/change-password'
import { createStore } from '../src/core/store'
import { createEmptyDocument, createEmptyTeam } from '../src/core/document'
import { createImageStore } from '../src/core/image-store'
import { blobCodec, decryptDocumentWithVersion, parsePlainWithVersion, resetSessionKey, WrongPasswordError } from '../src/core/crypto'
import { docToBytes } from '../src/core/doc-bytes'
import type { FileSession } from '../src/core/fs'
import type { Shell } from '../src/ui/shell'
import type { BackupController } from '../src/core/backup-controller'

// Real crypto and real docToBytes: what matters here is which key the image
// blobs end up sealed under, which a mocked crypto module cannot show.
const fsMocks = vi.hoisted(() => ({ writeFile: vi.fn(async (_s: unknown, _b: Uint8Array) => {}), downloadFallback: vi.fn() }))
vi.mock('../src/core/fs', () => fsMocks)
vi.mock('../src/ui/modal', () => ({ toast: vi.fn() }))
vi.mock('../src/core/idb', () => ({ idbGet: vi.fn(async () => undefined), idbSet: vi.fn(async () => {}) }))

const A = 'a'.repeat(32)
const PIXELS = new Uint8Array([9, 8, 7, 6, 5])

function makeBackupCtl(): BackupController {
  return {
    writeBackupNow: vi.fn(async () => true), maybeWriteBackup: vi.fn(async () => {}), regrantPermission: vi.fn(async () => {}),
    hasMissingGrant: vi.fn(async () => false), checkOrphaned: vi.fn(async () => false), getStatus: vi.fn(async () => null),
    currentHealth: vi.fn(async () => 'ok' as const), markPasswordMismatch: vi.fn(),
  } as unknown as BackupController
}

async function setup(password: string | null) {
  const doc = createEmptyDocument('en-US')
  const team = createEmptyTeam('T1', 'Team', '', 'en-US')
  team.generalNotes = `![x](img:${A})`
  doc.teams.push(team)
  doc.images = { [A]: { mime: 'image/webp', w: 1, h: 1, bytes: PIXELS.length } }
  const images = createImageStore(password === null ? null : await blobCodec(password))
  images.putPlain(A, PIXELS)
  const store = createStore(doc, images)
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team.tmv', lastModified: 1 }
  let current = password
  const exclusive = vi.fn((fn: () => Promise<unknown>): Promise<unknown> => fn())
  const changePassword = createChangePassword({
    store, session, shell: { setSaveState: vi.fn(), setTitle: vi.fn() } as unknown as Shell, backupCtl: makeBackupCtl(),
    runExclusive: <T,>(fn: () => Promise<T>) => exclusive(fn) as Promise<T>, getPassword: () => current, setPassword: (p) => { current = p },
  })
  return { store, changePassword, exclusive, written: () => fsMocks.writeFile.mock.calls.at(-1)![1] }
}

beforeEach(() => { fsMocks.writeFile.mockReset().mockImplementation(async () => {}); resetSessionKey() })

test('password A to B: images open with B and the file no longer opens with A', async () => {
  const { changePassword, written } = await setup('A')
  await changePassword('B')
  const bytes = written()
  const opened = await decryptDocumentWithVersion(bytes, 'B')
  expect([...(await opened.images.getPlain(A))!]).toEqual([...PIXELS])
  await expect(decryptDocumentWithVersion(bytes, 'A')).rejects.toBeInstanceOf(WrongPasswordError)
}, 60000)

test('password to none: the image bytes are readable in the plain file', async () => {
  const { changePassword, written } = await setup('A')
  await changePassword(null)
  const opened = parsePlainWithVersion(written())!
  expect([...(await opened.images.getPlain(A))!]).toEqual([...PIXELS])
}, 60000)

test('none to password: the image blob is sealed (the pixels are not visible in the file)', async () => {
  const { changePassword, written } = await setup(null)
  await changePassword('B')
  const bytes = written()
  expect(new TextDecoder('latin1').decode(bytes)).not.toContain(String.fromCharCode(...PIXELS))
  const opened = await decryptDocumentWithVersion(bytes, 'B')
  expect([...(await opened.images.getPlain(A))!]).toEqual([...PIXELS])
}, 60000)

test('a failed write rolls the image store back so the next save still opens under the old password', async () => {
  const { store, changePassword } = await setup('A')
  const rekey = vi.spyOn(store.images, 'rekey')
  fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'))
  await expect(changePassword('B')).rejects.toThrow('disk full')
  expect(rekey).toHaveBeenCalledTimes(2)
  const bytes = await docToBytes(store.doc, 'A', store.images)
  const opened = await decryptDocumentWithVersion(bytes, 'A')
  expect([...(await opened.images.getPlain(A))!]).toEqual([...PIXELS])
}, 60000)

test('the whole sequence, re-sealing included, runs inside runExclusive', async () => {
  const { store, changePassword, exclusive } = await setup('A')
  const order: string[] = []
  vi.spyOn(store.images, 'rekey').mockImplementation(async () => { order.push('rekey') })
  exclusive.mockImplementation(async (fn) => { order.push('enter'); const r = await fn(); order.push('leave'); return r })
  await changePassword('B').catch(() => {})
  expect(order[0]).toBe('enter')
  expect(order.indexOf('rekey')).toBeGreaterThan(0)
  expect(order.at(-1)).toBe('leave')
}, 60000)
