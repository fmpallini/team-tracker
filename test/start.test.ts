import { showStartScreen, isMobileDevice, START_LINKS } from '../src/ui/start'
import { createEmptyDocument, SCHEMA_VERSION } from '../src/core/document'
import type { FileSession } from '../src/core/fs'
import type { OpenedDocument } from '../src/ui/open-document'
import { StallError } from '../src/core/stall'

const fsMocks = vi.hoisted(() => ({
  FilePermissionError: class FilePermissionError extends Error {},
  FileMissingError: class FileMissingError extends Error {},
  supportsFsApi: true,
  pickOpen: vi.fn(),
  pickCreate: vi.fn(),
  reopenLast: vi.fn(),
  writeFile: vi.fn(async () => {}),
  downloadFallback: vi.fn(),
  openFromHandle: vi.fn(),
  hasReadWriteAccess: vi.fn(async (_handle: unknown) => false),
}))
vi.mock('../src/core/fs', () => fsMocks)

const idbMocks = vi.hoisted(() => ({
  idbGet: vi.fn(async (_key?: string) => undefined as unknown),
  idbSet: vi.fn(async () => {}),
}))
vi.mock('../src/core/idb', () => idbMocks)

const cryptoMocks = vi.hoisted(() => {
  class WrongPasswordError extends Error {}
  class CorruptFileError extends Error { constructor(readonly path?: string) { super() } }
  // Tests drive the decoded document through `parsePlain`/`decryptDocument`
  // and the file's pre-migration schema version through the two
  // `*PreSchemaVersion` knobs; the open-path functions start.ts actually
  // calls compose them the way crypto.ts does.
  const m = {
    WrongPasswordError,
    CorruptFileError,
    images: { has: () => false } as unknown,
    decryptDocument: vi.fn(),
    encryptDocument: vi.fn(async () => new Uint8Array([1, 2, 3])),
    blobCodec: vi.fn(async () => ({ seal: async () => new Uint8Array(), open: async () => new Uint8Array() })),
    serializePlain: vi.fn(() => new Uint8Array([9, 9, 9])),
    parsePlain: vi.fn((_bytes: Uint8Array) => null as unknown),
    looksLikeTmv: vi.fn((_bytes: Uint8Array) => true),
    plainPreSchemaVersion: vi.fn((_bytes: Uint8Array) => SCHEMA_VERSION as number | null),
    encryptedPreSchemaVersion: vi.fn((_bytes: Uint8Array) => SCHEMA_VERSION as number | null),
    parsePlainWithVersion: vi.fn((bytes: Uint8Array) => {
      const doc = m.parsePlain(bytes)
      return doc ? { doc, preSchemaVersion: m.plainPreSchemaVersion(bytes), images: m.images, stamp: null } : null
    }),
    decryptDocumentWithVersion: vi.fn(async (bytes: Uint8Array, password: string) => {
      const doc: unknown = await m.decryptDocument(bytes, password)
      return { doc, preSchemaVersion: m.encryptedPreSchemaVersion(bytes), images: m.images, stamp: null }
    }),
  }
  return m
})
vi.mock('../src/core/crypto', () => cryptoMocks)

// What happens between "decoded" and "mounted" (reconciling with the browser copy) is covered by
// open-document.test.ts and start-live.test.ts; here start.ts only has to route into it.
const openDocMocks = vi.hoisted(() => ({
  reconcileOpen: vi.fn(async (o: { session: unknown; opened: { doc: unknown; images: unknown; stamp: unknown }; password: string | null }) => ({
    session: o.session, doc: o.opened.doc, password: o.password, images: o.opened.images, store: {}, handle: null, needsFileWrite: false, stamp: o.opened.stamp,
  }) as unknown),
}))
vi.mock('../src/ui/open-document', () => openDocMocks)

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
  fsMocks.openFromHandle.mockReset()
  fsMocks.hasReadWriteAccess.mockReset().mockResolvedValue(false)
  delete (window as unknown as { launchQueue?: unknown }).launchQueue
  idbMocks.idbGet.mockReset().mockImplementation(async () => undefined)
  idbMocks.idbSet.mockReset().mockImplementation(async () => {})
  cryptoMocks.decryptDocument.mockReset()
  cryptoMocks.encryptDocument.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3]))
  cryptoMocks.serializePlain.mockReset().mockReturnValue(new Uint8Array([9, 9, 9]))
  cryptoMocks.parsePlain.mockReset().mockReturnValue(null)
  cryptoMocks.plainPreSchemaVersion.mockReset().mockReturnValue(SCHEMA_VERSION)
  cryptoMocks.encryptedPreSchemaVersion.mockReset().mockReturnValue(SCHEMA_VERSION)
  openDocMocks.reconcileOpen.mockClear()
})

function clickByText(text: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  btn.click()
}

type LaunchConsumer = (launchParams: { files: FileSystemFileHandle[] }) => void

function mockLaunchQueue(): () => LaunchConsumer {
  let consumer: LaunchConsumer | null = null
  ;(window as unknown as { launchQueue: unknown }).launchQueue = {
    setConsumer: (cb: LaunchConsumer) => {
      consumer = cb
    },
  }
  return () => {
    if (!consumer) throw new Error('launchQueue.setConsumer was never called')
    return consumer
  }
}

test('renders start screen with open/create buttons but no reopen when no lastHandle', async () => {
  showStartScreen('en-US', () => {})
  await flush()
  expect(document.querySelector('.tt-start-title')?.textContent).toBe('Team Tracker')
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Reopen last…')
  expect(reopenBtn).toBeDefined()
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('none')
})

test('shows reopen button when idbGet resolves a handle', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  showStartScreen('en-US', () => {})
  await flush()
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Reopen last…')
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('')
})

test('reopen-last: opens directly via reopenLast (no fallback dance)', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'last.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.reopenLast.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockResolvedValue(doc)

  let opened: OpenedDocument | null = null
  showStartScreen('en-US', (o) => { opened = o })
  await flush()

  clickByText('Reopen last…')
  await flush()

  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'right'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(fsMocks.reopenLast).toHaveBeenCalledTimes(1)
  expect(opened).not.toBeNull()
  expect(opened!.session).toBe(session)
})

test('file handling launch: consumes launchQueue file, decrypts, and calls onOpen', async () => {
  const getConsumer = mockLaunchQueue()

  const handle = {} as unknown as FileSystemFileHandle
  const session: FileSession = { handle, name: 'launched.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.openFromHandle.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockResolvedValue(doc)

  let opened: OpenedDocument | null = null
  showStartScreen('en-US', (o) => { opened = o })
  await flush()

  getConsumer()({ files: [handle] })
  await flush()

  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'right'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(fsMocks.openFromHandle).toHaveBeenCalledWith(handle)
  expect(opened).not.toBeNull()
  expect(opened!.session).toBe(session)
  expect(opened!.doc).toEqual(doc)
})

test('file handling launch: fetchResult resolving null (e.g. picker cancel) is a no-op', async () => {
  const getConsumer = mockLaunchQueue()
  fsMocks.openFromHandle.mockResolvedValue(null)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()

  getConsumer()({ files: [{} as unknown as FileSystemFileHandle] })
  await flush()

  expect(onOpen).not.toHaveBeenCalled()
  expect(document.querySelector('input[name="tt-password"]')).toBeNull()
})

test('a browser without the File System Access API is told which browsers can write the file itself', async () => {
  fsMocks.supportsFsApi = false
  showStartScreen('en-US', () => {})
  await flush()
  expect(document.querySelector('.tt-start-fallback-notice')?.textContent).toContain('Chrome, Edge')
})

test('reopen-last: a denied file permission explains how to unblock it and to open manually, instead of doing nothing', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  fsMocks.reopenLast.mockRejectedValue(new fsMocks.FilePermissionError())

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Reopen last…')
  await flush()

  const message = document.querySelector('.tt-modal-message')?.textContent ?? ''
  expect(message).toContain('site settings')
  expect(message).toContain('installed app')
  expect(message).toContain('Open file…')
  expect(onOpen).not.toHaveBeenCalled()
})

test('reopen-last: browser storage that stopped answering says what clears it, instead of a bare "unexpected error"', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  fsMocks.reopenLast.mockRejectedValue(new StallError('IndexedDB readonly (team-tracker)', 15_000))
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Reopen last…')
  await flush()

  const message = document.querySelector('.tt-modal-message')?.textContent ?? ''
  expect(message).toContain('not responding')
  expect(message).toContain('restart the browser')
  expect(message).toContain('not yet written to the file are lost')
  expect(onOpen).not.toHaveBeenCalled()
})

test('file handling launch: a denied file permission shows the same explanation', async () => {
  const getConsumer = mockLaunchQueue()
  fsMocks.openFromHandle.mockRejectedValue(new fsMocks.FilePermissionError())

  showStartScreen('pt-BR', () => {})
  await flush()
  getConsumer()({ files: [{} as unknown as FileSystemFileHandle] })
  await flush()

  expect(document.querySelector('.tt-modal-message')?.textContent).toContain('configurações do site')
})

test('open flow: wrong password loops until correct, then calls onOpen', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockRejectedValueOnce(new cryptoMocks.WrongPasswordError()).mockResolvedValueOnce(doc)

  let opened: OpenedDocument | null = null
  showStartScreen('en-US', (o) => { opened = o })
  await flush()

  clickByText('Open file…')
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
  expect(opened!.doc).toEqual(doc)
  expect(opened!.password).toBe('right')
})

test('open flow: corrupt file shows error modal and does not call onOpen', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.decryptDocument.mockRejectedValue(new cryptoMocks.CorruptFileError())
  cryptoMocks.looksLikeTmv.mockReturnValue(true)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Open file…')
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

test('open flow: a file that is not a .tmv at all (empty / wrong magic) is reported as corrupt WITHOUT asking for a password first', async () => {
  const session: FileSession = { handle: null, name: 'empty.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array(0) })
  cryptoMocks.looksLikeTmv.mockReturnValue(false)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Open file…')
  await flush()
  await flush()

  expect(document.querySelector('input[name="tt-password"]')).toBeNull()
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Corrupt or invalid file')
  expect(cryptoMocks.decryptDocument).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()
  cryptoMocks.looksLikeTmv.mockReturnValue(true)
})

test('open flow: a structurally invalid file names the offending field in the error modal', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.decryptDocument.mockRejectedValue(new cryptoMocks.CorruptFileError('teams[0].members[3].id'))

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Open file…')
  await flush()

  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'x'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(document.querySelector('.tt-modal-message')?.textContent)
    .toBe('Invalid file structure at: teams[0].members[3].id')
  expect(onOpen).not.toHaveBeenCalled()
})

test('open flow: a plain file with an invalid structure names the field too', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.parsePlain.mockImplementation(() => { throw new cryptoMocks.CorruptFileError('teams[0].dailyNotes') })

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Open file…')
  await flush()

  expect(document.querySelector('.tt-modal-message')?.textContent)
    .toBe('Invalid file structure at: teams[0].dailyNotes')
  expect(onOpen).not.toHaveBeenCalled()
})

test('create flow: prompts confirm password, encrypts, writes, then calls onOpen', async () => {
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.tmv', lastModified: 1 }
  fsMocks.pickCreate.mockResolvedValue(session)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Create new…')
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
  const { session: openedSession, doc: openedDoc, password: openedPw, stamp } = onOpen.mock.calls[0]![0] as OpenedDocument
  expect(openedSession).toBe(session)
  expect(openedDoc.schemaVersion).toBe(SCHEMA_VERSION)
  expect(openedPw).toBe('sekret')
  // the stamp that went into the written file is the one the browser copy starts its lineage from
  expect((cryptoMocks.encryptDocument.mock.calls[0] as unknown[])[4]).toEqual(stamp)
})

test('create flow: "Create without password" writes serializePlain bytes and calls onOpen with password null', async () => {
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.tmv', lastModified: 1 }
  fsMocks.pickCreate.mockResolvedValue(session)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Create new…')
  await flush()

  clickByText('Create without password')
  await flush()
  await flush()

  expect(cryptoMocks.serializePlain).toHaveBeenCalledTimes(1)
  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, new Uint8Array([9, 9, 9]))
  expect(onOpen).toHaveBeenCalledTimes(1)
  const { doc: openedDoc, password: openedPw } = onOpen.mock.calls[0]![0] as OpenedDocument
  expect(openedDoc.schemaVersion).toBe(SCHEMA_VERSION)
  expect(openedPw).toBeNull()
})

test('open flow: a plain file opens directly, no password prompt at all', async () => {
  const session: FileSession = { handle: null, name: 'plain.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  const plainDoc = createEmptyDocument('en-US')
  cryptoMocks.parsePlain.mockReturnValue(plainDoc)

  let opened: OpenedDocument | null = null
  showStartScreen('en-US', (o) => { opened = o })
  await flush()
  clickByText('Open file…')
  await flush()

  expect(document.querySelector('input[name="tt-password"]')).toBeNull()
  expect(opened).not.toBeNull()
  expect(opened!.doc).toEqual(plainDoc)
  expect(opened!.password).toBeNull()
  expect(cryptoMocks.decryptDocument).not.toHaveBeenCalled()
})

test('open flow: a non-plain file (parsePlain returns null) still goes through the password prompt', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.parsePlain.mockReturnValue(null)
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockResolvedValue(doc)

  showStartScreen('en-US', vi.fn())
  await flush()
  clickByText('Open file…')
  await flush()

  expect(document.querySelector('input[name="tt-password"]')).not.toBeNull()
})

test('open flow: the decoded file, its password and the start-screen locale go to the reconcile step, and its result is what opens', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.parsePlain.mockReturnValue(null)
  cryptoMocks.decryptDocument.mockResolvedValue(doc)
  const onOpen = vi.fn()
  showStartScreen('pt-BR', onOpen)
  await flush()
  clickByText('Abrir arquivo…')
  await flush()
  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'right'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(openDocMocks.reconcileOpen).toHaveBeenCalledTimes(1)
  expect(openDocMocks.reconcileOpen.mock.calls[0]![0]).toMatchObject({ locale: 'pt-BR', session, password: 'right', opened: { doc } })
  expect(onOpen).toHaveBeenCalledTimes(1)
})

test('open flow: backing out of a reconcile question opens nothing and leaves the start screen up', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  fsMocks.pickOpen.mockResolvedValue({ session, bytes: new Uint8Array([9]) })
  cryptoMocks.parsePlain.mockReturnValue(createEmptyDocument('en-US'))
  openDocMocks.reconcileOpen.mockResolvedValueOnce(null)
  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Open file…')
  await flush()
  await flush()

  expect(onOpen).not.toHaveBeenCalled()
  expect(document.querySelector('.tt-start-screen')).not.toBeNull()
})

test('fallback mode (no FS API): open uses hidden file input', async () => {
  fsMocks.supportsFsApi = false
  showStartScreen('en-US', () => {})
  await flush()
  expect(document.querySelector('.tt-start-fallback-notice')?.textContent).toBe(
    'This browser cannot write the file by itself (only Chrome, Edge and Brave can). Your work is kept in the browser; use Export file in the header to download a copy.'
  )
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(fileInput).not.toBeNull()
})

describe('fallback mode (no FS API): opening the picked file', () => {
  function pickFallbackFile(name = 'team.tmv'): void {
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([9])], name, { lastModified: 42 })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
  }

  test('a plain file opens with a null password, a handle-less session, and no prompt', async () => {
    fsMocks.supportsFsApi = false
    const plainDoc = createEmptyDocument('en-US')
    cryptoMocks.parsePlain.mockReturnValue(plainDoc)
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()

    pickFallbackFile()
    await flush()

    expect(document.querySelector('input[name="tt-password"]')).toBeNull()
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ session: { handle: null, name: 'team.tmv', lastModified: 42 }, doc: plainDoc, password: null, images: cryptoMocks.images }))
  })

  test('an encrypted file goes through the password prompt, then opens', async () => {
    fsMocks.supportsFsApi = false
    const doc = createEmptyDocument('en-US')
    cryptoMocks.decryptDocument.mockResolvedValue(doc)
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()

    pickFallbackFile()
    await flush()
    const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
    pwInput.value = 'right'
    pwInput.dispatchEvent(new Event('input'))
    clickByText('OK')
    await flush()
    await flush()

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ session: { handle: null, name: 'team.tmv', lastModified: 42 }, doc, password: 'right', images: cryptoMocks.images }))
  })

  test('a corrupt plain file shows the corrupt-file error and opens nothing', async () => {
    fsMocks.supportsFsApi = false
    cryptoMocks.parsePlain.mockImplementation(() => { throw new cryptoMocks.CorruptFileError() })
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()

    pickFallbackFile()
    await flush()

    expect(document.querySelector('.tt-modal-message')?.textContent).toBe('Corrupt or invalid file')
    expect(onOpen).not.toHaveBeenCalled()
  })
})

test('renders the advantages pitch', () => {
  showStartScreen('en-US', () => {})
  const list = document.querySelectorAll('.tt-start-advantages li')
  expect(list.length).toBe(4)
  expect(document.querySelector('.tt-start-tagline')).not.toBeNull()
})

describe('mobile block', () => {
  function fakeNav(ua: string, maxTouchPoints = 0, uaDataMobile?: boolean): Navigator {
    return {
      userAgent: ua,
      maxTouchPoints,
      ...(uaDataMobile === undefined ? {} : { userAgentData: { mobile: uaDataMobile } }),
    } as unknown as Navigator
  }

  it('isMobileDevice detects phones/tablets, not desktops', () => {
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36'))).toBe(true)
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'))).toBe(true)
    // iPadOS 13+ masquerading as macOS, but with multi-touch
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5))).toBe(true)
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (Anything)', 0, true))).toBe(true)
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBe(false)
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0))).toBe(false)
    expect(isMobileDevice(fakeNav('Mozilla/5.0 (X11; Linux x86_64)'))).toBe(false)
  })

  it('replaces the start screen with a blocking notice on mobile', () => {
    const uaSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    try {
      const onOpen = vi.fn()
      showStartScreen('en-US', onOpen)
      expect(document.querySelector('.tt-mobile-block-title')?.textContent).toContain('Built for desktop')
      expect(document.body.textContent).toContain('File System Access API')
      // no open/create buttons — the app is not usable from here
      expect(document.querySelectorAll('.tt-start-btn').length).toBe(0)
      expect(onOpen).not.toHaveBeenCalled()
    } finally {
      uaSpy.mockRestore()
    }
  })
})

test.each(['pt-BR', 'en-US'] as const)('marks the page language %s on the start screen and on the mobile notice', (locale) => {
  document.documentElement.lang = ''
  showStartScreen(locale, () => {})
  expect(document.documentElement.lang).toBe(locale)

  document.documentElement.lang = ''
  const uaSpy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  try {
    showStartScreen(locale, () => {})
    expect(document.documentElement.lang).toBe(locale)
  } finally {
    uaSpy.mockRestore()
  }
})

test('renders the cloud-backup tip with the desktop-client download links', () => {
  showStartScreen('en-US', () => {})
  const tip = document.querySelector('.tt-start-backup-tip')
  expect(tip).not.toBeNull()
  expect(tip!.textContent).toContain('cloud-synced folder')
  expect(tip!.textContent).toContain('that is your backup')
  const links = Array.from(tip!.querySelectorAll('a'))
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    'https://workspace.google.com/products/drive/#download',
    'https://www.microsoft.com/microsoft-365/onedrive/download',
    'https://www.dropbox.com/install',
  ])
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  }
})

test('every external link on the start screen is listed in START_LINKS (so the live check covers it)', () => {
  showStartScreen('en-US', () => {})
  const hrefs = Array.from(document.querySelectorAll('a[href^="http"]')).map((a) => a.getAttribute('href'))
  expect(hrefs.length).toBeGreaterThan(0)
  expect(Object.values(START_LINKS)).toEqual(expect.arrayContaining(hrefs))
})

test('reopen-last: a file moved, renamed or deleted since says so and points at Open, instead of a bare "unexpected error"', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  fsMocks.reopenLast.mockRejectedValue(new fsMocks.FileMissingError())
  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('Reopen last…')
  await flush()
  const message = document.querySelector('.tt-modal-message')?.textContent ?? ''
  expect(message).toContain('no longer where it was')
  expect(message).toContain('Open file…')
  expect(onOpen).not.toHaveBeenCalled()
})

describe('remembered file and auto-reopen on startup', () => {
  const lastHandle = { name: 'last.tmv' } as unknown as FileSystemFileHandle
  const lastSession: FileSession = { handle: lastHandle, name: 'last.tmv', lastModified: 1 }

  /** A remembered file, the auto-reopen box as given, and whether the browser kept this page's access to it. */
  function remember({ autoLoad = false, access = true }: { autoLoad?: boolean; access?: boolean } = {}): void {
    idbMocks.idbGet.mockImplementation(async (key?: string) => (key === 'lastHandle' ? lastHandle : key === 'autoLoadLast' ? autoLoad : undefined))
    fsMocks.hasReadWriteAccess.mockResolvedValue(access)
  }
  /** The auto-reopen's read of the remembered file, pending until `release()`; other handles (an OS launch) read at once. */
  function pendingAutoRead(): { release: () => void } {
    let release: () => void = () => {}
    fsMocks.openFromHandle.mockImplementation((handle: unknown) => handle === lastHandle
      ? new Promise((resolve) => { release = () => resolve({ session: lastSession, bytes: new Uint8Array([9]) }) })
      : Promise.resolve({ session: { handle, name: 'launched.tmv', lastModified: 2 }, bytes: new Uint8Array([9]) }))
    return { release: () => release() }
  }
  const row = (): HTMLElement => document.querySelector('.tt-start-autoload') as HTMLElement
  const reopenRow = (): HTMLElement => document.querySelector('.tt-start-reopen-row') as HTMLElement
  const checkbox = (): HTMLInputElement => document.querySelector('.tt-start-autoload-checkbox') as HTMLInputElement
  const hint = (): HTMLElement => document.querySelector('.tt-start-autoload-hint') as HTMLElement

  test('no remembered file: neither Reopen last nor the checkbox, and no permission check', async () => {
    showStartScreen('en-US', () => {})
    await flush()
    expect(reopenRow().style.display).toBe('none')
    expect(fsMocks.hasReadWriteAccess).not.toHaveBeenCalled()
  })

  test('the checkbox comes with Reopen last and keeps its setting even when the access did not survive', async () => {
    remember({ autoLoad: true, access: false })
    showStartScreen('en-US', () => {})
    await flush()
    expect(reopenRow().style.display).toBe('')
    expect(row().style.display).toBe('')
    expect(checkbox().checked).toBe(true)
  })

  test('ticked without access: a hint says what lets it open by itself; unticking hides it', async () => {
    remember({ autoLoad: true, access: false })
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()
    expect(hint().style.display).toBe('')
    expect(hint().textContent).toContain('Allow on every visit')
    expect(fsMocks.openFromHandle).not.toHaveBeenCalled() // nothing read, nothing asked
    expect(onOpen).not.toHaveBeenCalled()
    checkbox().checked = false
    checkbox().dispatchEvent(new Event('change'))
    expect(hint().style.display).toBe('none')
  })

  test('no hint while the box is unticked, nor while the access is there', async () => {
    remember({ autoLoad: false, access: false })
    showStartScreen('en-US', () => {})
    await flush()
    expect(hint().style.display).toBe('none')
    remember({ autoLoad: true, access: true })
    showStartScreen('en-US', vi.fn(), { skipAutoLoad: true })
    await flush()
    expect(hint().style.display).toBe('none')
  })

  test('toggling the checkbox persists the setting', async () => {
    remember()
    showStartScreen('en-US', () => {})
    await flush()
    checkbox().checked = true
    checkbox().dispatchEvent(new Event('change'))
    expect(idbMocks.idbSet).toHaveBeenCalledWith('autoLoadLast', true)
  })

  test('unticked: the file is never read, however the access stands', async () => {
    remember({ autoLoad: false, access: true })
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()
    expect(fsMocks.openFromHandle).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  test('ticked with access: a password-less file opens by itself, read without any prompt', async () => {
    remember({ autoLoad: true })
    fsMocks.openFromHandle.mockResolvedValue({ session: lastSession, bytes: new Uint8Array([9]) })
    const plainDoc = createEmptyDocument('en-US')
    cryptoMocks.parsePlain.mockReturnValue(plainDoc)
    let opened: OpenedDocument | null = null
    showStartScreen('en-US', (o) => { opened = o })
    await flush()
    expect(fsMocks.openFromHandle).toHaveBeenCalledWith(lastHandle, false, false)
    expect(opened!.session).toBe(lastSession)
    expect(opened!.doc).toEqual(plainDoc)
    expect(opened!.password).toBeNull()
  })

  test('ticked with access: an encrypted file asks for its password straight away and opens with it', async () => {
    remember({ autoLoad: true })
    fsMocks.openFromHandle.mockResolvedValue({ session: lastSession, bytes: new Uint8Array([9]) })
    const doc = createEmptyDocument('en-US')
    cryptoMocks.decryptDocument.mockResolvedValue(doc)
    let opened: OpenedDocument | null = null
    showStartScreen('en-US', (o) => { opened = o })
    await flush()
    const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
    expect(pwInput).not.toBeNull()
    pwInput.value = 'right'
    pwInput.dispatchEvent(new Event('input'))
    clickByText('OK')
    await flush()
    await flush()
    expect(opened!.session).toBe(lastSession)
    expect(opened!.password).toBe('right')
  })

  test('skipAutoLoad (back from Close file): nothing reopens, the box still shows its setting', async () => {
    remember({ autoLoad: true })
    cryptoMocks.parsePlain.mockReturnValue(createEmptyDocument('en-US'))
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen, { skipAutoLoad: true })
    await flush()
    expect(fsMocks.openFromHandle).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    expect(checkbox().checked).toBe(true)
  })

  test('a remembered file gone since opens nothing by itself, and shows no message until Reopen last is clicked', async () => {
    remember({ autoLoad: true })
    fsMocks.openFromHandle.mockRejectedValue(new fsMocks.FileMissingError())
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.querySelector('.tt-modal-message')).toBeNull()
  })

  test('a file launched by the OS while the auto-reopen is reading wins: opened once, the launched file', async () => {
    const getConsumer = mockLaunchQueue()
    remember({ autoLoad: true })
    const auto = pendingAutoRead()
    cryptoMocks.parsePlain.mockReturnValue(createEmptyDocument('en-US'))
    const launched = {} as unknown as FileSystemFileHandle
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()

    getConsumer()({ files: [launched] })
    await flush()
    auto.release()
    await flush()
    await flush()

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0]![0] as OpenedDocument).session.handle).toBe(launched)
  })

  test('clicking Open while the auto-reopen is reading wins, and an encrypted remembered file then asks no password', async () => {
    remember({ autoLoad: true })
    const auto = pendingAutoRead()
    const picked: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'picked.tmv', lastModified: 3 }
    fsMocks.pickOpen.mockResolvedValue({ session: picked, bytes: new Uint8Array([8]) })
    // The picked file is password-less; the remembered one is not (no plain header in its bytes).
    cryptoMocks.parsePlain.mockImplementation((bytes: Uint8Array) => (bytes[0] === 8 ? createEmptyDocument('en-US') : null))
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()

    clickByText('Open file…')
    await flush()
    auto.release()
    await flush()
    await flush()

    expect(document.querySelector('input[name="tt-password"]')).toBeNull()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0]![0] as OpenedDocument).session).toBe(picked)
  })

  test('an auto-reopen still reconciling when the user opens a file is dropped: the file the user picked opens, once', async () => {
    // Browser storage slow or stalled at startup (core/stall.ts): the auto-reopen is past its checks, waiting on the
    // reconcile, when the user picks a file themselves.
    remember({ autoLoad: true })
    fsMocks.openFromHandle.mockResolvedValue({ session: lastSession, bytes: new Uint8Array([9]) })
    cryptoMocks.parsePlain.mockReturnValue(createEmptyDocument('en-US'))
    let finishAuto: () => void = () => {}
    const reconcileFor = openDocMocks.reconcileOpen.getMockImplementation()!
    openDocMocks.reconcileOpen.mockImplementationOnce((o) => new Promise((resolve) => {
      finishAuto = () => resolve(reconcileFor(o))
    }))
    const picked: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'picked.tmv', lastModified: 3 }
    fsMocks.pickOpen.mockResolvedValue({ session: picked, bytes: new Uint8Array([9]) })
    const onOpen = vi.fn()
    showStartScreen('en-US', onOpen)
    await flush()
    expect(openDocMocks.reconcileOpen).toHaveBeenCalledTimes(1) // the auto-reopen is reconciling

    clickByText('Open file…')
    await flush()
    finishAuto()
    await flush()

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0]![0] as OpenedDocument).session).toBe(picked)
  })
})
