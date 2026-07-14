import { showStartScreen } from '../src/ui/start'
import { createEmptyDocument, SCHEMA_VERSION } from '../src/core/document'
import type { FileSession } from '../src/core/fs'
import type { Doc } from '../src/core/types'

const fsMocks = vi.hoisted(() => ({
  supportsFsApi: true,
  pickOpen: vi.fn(),
  pickCreate: vi.fn(),
  reopenLast: vi.fn(),
  writeFile: vi.fn(async () => {}),
  downloadFallback: vi.fn(),
}))
vi.mock('../src/core/fs', () => fsMocks)

const idbMocks = vi.hoisted(() => ({ idbGet: vi.fn(async () => undefined as unknown) }))
vi.mock('../src/core/idb', () => idbMocks)

const cryptoMocks = vi.hoisted(() => {
  class WrongPasswordError extends Error {}
  class CorruptFileError extends Error {}
  return {
    WrongPasswordError,
    CorruptFileError,
    decryptDocument: vi.fn(),
    encryptDocument: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }
})
vi.mock('../src/core/crypto', () => cryptoMocks)

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  fsMocks.supportsFsApi = true
  fsMocks.pickOpen.mockReset()
  fsMocks.pickCreate.mockReset()
  fsMocks.reopenLast.mockReset()
  fsMocks.writeFile.mockReset().mockImplementation(async () => {})
  fsMocks.downloadFallback.mockReset()
  idbMocks.idbGet.mockReset().mockImplementation(async () => undefined)
  cryptoMocks.decryptDocument.mockReset()
  cryptoMocks.encryptDocument.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3]))
})

function clickByText(text: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

test('renders start screen with open/create buttons but no reopen when no lastHandle', async () => {
  showStartScreen('en-US', () => {})
  await flush()
  expect(document.querySelector('.tt-start-title')?.textContent).toBe('Team Tracker')
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '⏪ Reopen last…')
  expect(reopenBtn).toBeDefined()
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('none')
})

test('shows reopen button when idbGet resolves a handle', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  showStartScreen('en-US', () => {})
  await flush()
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '⏪ Reopen last…')
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('')
})

test('open flow: wrong password loops until correct, then calls onOpen', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockRejectedValueOnce(new cryptoMocks.WrongPasswordError()).mockResolvedValueOnce(doc)

  let opened: [FileSession, Doc, string] | null = null
  showStartScreen('en-US', (s, d, p) => { opened = [s, d, p] })
  await flush()

  clickByText('📂 Open file…')
  await flush()

  // first prompt: wrong password
  let pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'wrong'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(document.querySelector('.tt-toast')?.textContent).toBe('Wrong password')

  // second prompt appears again
  pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'right'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(opened).not.toBeNull()
  expect(opened![1]).toEqual(doc)
  expect(opened![2]).toBe('right')
})

test('open flow: corrupt file shows error modal and does not call onOpen', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.decryptDocument.mockRejectedValue(new cryptoMocks.CorruptFileError())

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('📂 Open file…')
  await flush()

  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'x'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Corrupt or invalid file')
  expect(onOpen).not.toHaveBeenCalled()
})

test('create flow: prompts confirm password, encrypts, writes, then calls onOpen', async () => {
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.tmv', lastModified: 1 }
  fsMocks.pickCreate.mockResolvedValue(session)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('✨ Create new…')
  await flush()

  const pw = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  const confirm = document.querySelector('input[name="tt-password-confirm"]') as HTMLInputElement
  pw.value = 'sekret'
  pw.dispatchEvent(new Event('input'))
  confirm.value = 'sekret'
  confirm.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, expect.any(Uint8Array))
  expect(onOpen).toHaveBeenCalledTimes(1)
  const [openedSession, openedDoc, openedPw] = onOpen.mock.calls[0] as [FileSession, Doc, string]
  expect(openedSession).toBe(session)
  expect(openedDoc.schemaVersion).toBe(SCHEMA_VERSION)
  expect(openedPw).toBe('sekret')
})

test('fallback mode (no FS API): open uses hidden file input', async () => {
  fsMocks.supportsFsApi = false
  showStartScreen('en-US', () => {})
  await flush()
  expect(document.querySelector('.tt-start-fallback-notice')?.textContent).toBe(
    'This browser does not support direct file access: saving will download the file.'
  )
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(fileInput).not.toBeNull()
})

test('renders the advantages pitch', () => {
  showStartScreen('en-US', () => {})
  const list = document.querySelectorAll('.tt-start-advantages li')
  expect(list.length).toBe(3)
  expect(document.querySelector('.tt-start-tagline')).not.toBeNull()
})

describe('promo card', () => {
  it('start screen shows the hosted-invite promo card (test build: __PWA__ false, pages URL set)', () => {
    localStorage.removeItem('tt-promo-dismissed')
    showStartScreen('en-US', vi.fn())
    const card = document.querySelector('.tt-promo-card')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Try the installable version')
  })
})
