import { showStartScreen, isMobileDevice } from '../src/ui/start'
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
  openFromHandle: vi.fn(),
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
    serializePlain: vi.fn(() => new Uint8Array([9, 9, 9])),
    parsePlain: vi.fn(() => null as unknown),
  }
})
vi.mock('../src/core/crypto', () => cryptoMocks)

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  localStorage.removeItem('tt-show-reopen')
  fsMocks.supportsFsApi = true
  fsMocks.pickOpen.mockReset()
  fsMocks.pickCreate.mockReset()
  fsMocks.reopenLast.mockReset()
  fsMocks.writeFile.mockReset().mockImplementation(async () => {})
  fsMocks.downloadFallback.mockReset()
  fsMocks.openFromHandle.mockReset()
  delete (window as unknown as { launchQueue?: unknown }).launchQueue
  idbMocks.idbGet.mockReset().mockImplementation(async () => undefined)
  cryptoMocks.decryptDocument.mockReset()
  cryptoMocks.encryptDocument.mockReset().mockImplementation(async () => new Uint8Array([1, 2, 3]))
  cryptoMocks.serializePlain.mockReset().mockReturnValue(new Uint8Array([9, 9, 9]))
  cryptoMocks.parsePlain.mockReset().mockReturnValue(null)
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
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '⏪ Reopen last…')
  expect(reopenBtn).toBeDefined()
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('none')
})

// "Reopen last file" is hidden from regular users even when a lastHandle
// exists — see start.ts's SHOW_REOPEN_KEY doc comment: the underlying
// Chromium crash on a lapsed grant has no app-level fix, so the button (and
// the requestPermission() machinery behind it) is kept working but out of
// sight, revealed only via the ttShowReopenButton() console command below.
test('reopen button stays hidden even with a lastHandle, unless explicitly revealed', async () => {
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  showStartScreen('en-US', () => {})
  await flush()
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '⏪ Reopen last…')
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('none')
})

test('shows reopen button when idbGet resolves a handle and the reveal flag is set', async () => {
  localStorage.setItem('tt-show-reopen', '1')
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  showStartScreen('en-US', () => {})
  await flush()
  const reopenBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '⏪ Reopen last…')
  expect((reopenBtn as HTMLButtonElement).style.display).toBe('')
})

test('ttShowReopenButton sets the reveal flag; ttHideReopenButton clears it', () => {
  const originalLocation = window.location
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { value: { ...originalLocation, reload }, writable: true, configurable: true })
  try {
    window.ttShowReopenButton!()
    expect(localStorage.getItem('tt-show-reopen')).toBe('1')
    window.ttHideReopenButton!()
    expect(localStorage.getItem('tt-show-reopen')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(2)
  } finally {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true })
  }
})

test('reopen-last: opens directly via reopenLast (no fallback dance)', async () => {
  localStorage.setItem('tt-show-reopen', '1')
  idbMocks.idbGet.mockImplementation(async () => ({}) as unknown)
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'last.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.reopenLast.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockResolvedValue(doc)

  let opened: [FileSession, Doc, string | null] | null = null
  showStartScreen('en-US', (s, d, p) => { opened = [s, d, p] })
  await flush()

  clickByText('⏪ Reopen last…')
  await flush()

  const pwInput = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  pwInput.value = 'right'
  pwInput.dispatchEvent(new Event('input'))
  clickByText('OK')
  await flush()
  await flush()

  expect(fsMocks.reopenLast).toHaveBeenCalledTimes(1)
  expect(opened).not.toBeNull()
  expect(opened![0]).toBe(session)
})

test('file handling launch: consumes launchQueue file, decrypts, and calls onOpen', async () => {
  const getConsumer = mockLaunchQueue()

  const handle = {} as unknown as FileSystemFileHandle
  const session: FileSession = { handle, name: 'launched.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.openFromHandle.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockResolvedValue(doc)

  let opened: [FileSession, Doc, string | null] | null = null
  showStartScreen('en-US', (s, d, p) => { opened = [s, d, p] })
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
  expect(opened![0]).toBe(session)
  expect(opened![1]).toEqual(doc)
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

test('open flow: wrong password loops until correct, then calls onOpen', async () => {
  const session: FileSession = { handle: null, name: 'x.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  const doc = createEmptyDocument('en-US')
  cryptoMocks.decryptDocument.mockRejectedValueOnce(new cryptoMocks.WrongPasswordError()).mockResolvedValueOnce(doc)

  let opened: [FileSession, Doc, string | null] | null = null
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
  const [openedSession, openedDoc, openedPw] = onOpen.mock.calls[0] as [FileSession, Doc, string | null]
  expect(openedSession).toBe(session)
  expect(openedDoc.schemaVersion).toBe(SCHEMA_VERSION)
  expect(openedPw).toBe('sekret')
})

test('create flow: "Use without password" writes serializePlain bytes and calls onOpen with password null', async () => {
  const session: FileSession = { handle: {} as unknown as FileSystemFileHandle, name: 'team-tracker.tmv', lastModified: 1 }
  fsMocks.pickCreate.mockResolvedValue(session)

  const onOpen = vi.fn()
  showStartScreen('en-US', onOpen)
  await flush()
  clickByText('✨ Create new…')
  await flush()

  clickByText('Use without password')
  await flush()
  await flush()

  expect(cryptoMocks.serializePlain).toHaveBeenCalledTimes(1)
  expect(cryptoMocks.encryptDocument).not.toHaveBeenCalled()
  expect(fsMocks.writeFile).toHaveBeenCalledWith(session, new Uint8Array([9, 9, 9]))
  expect(onOpen).toHaveBeenCalledTimes(1)
  const [, openedDoc, openedPw] = onOpen.mock.calls[0] as [FileSession, Doc, string | null]
  expect(openedDoc.schemaVersion).toBe(SCHEMA_VERSION)
  expect(openedPw).toBeNull()
})

test('open flow: a plain file opens directly, no password prompt at all', async () => {
  const session: FileSession = { handle: null, name: 'plain.tmv', lastModified: 1 }
  const bytes = new Uint8Array([9])
  fsMocks.pickOpen.mockResolvedValue({ session, bytes })
  const plainDoc = createEmptyDocument('en-US')
  cryptoMocks.parsePlain.mockReturnValue(plainDoc)

  let opened: [FileSession, Doc, string | null] | null = null
  showStartScreen('en-US', (s, d, p) => { opened = [s, d, p] })
  await flush()
  clickByText('📂 Open file…')
  await flush()

  expect(document.querySelector('input[name="tt-password"]')).toBeNull()
  expect(opened).not.toBeNull()
  expect(opened![1]).toEqual(plainDoc)
  expect(opened![2]).toBeNull()
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
  clickByText('📂 Open file…')
  await flush()

  expect(document.querySelector('input[name="tt-password"]')).not.toBeNull()
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

test('renders the cloud-backup tip with the desktop-client download links', () => {
  showStartScreen('en-US', () => {})
  const tip = document.querySelector('.tt-start-backup-tip')
  expect(tip).not.toBeNull()
  expect(tip!.textContent).toContain('synced by a cloud client')
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

describe('promo card', () => {
  it('start screen shows the hosted-invite promo card (test build: __PWA__ false, pages URL set)', () => {
    localStorage.removeItem('tt-promo-dismissed')
    showStartScreen('en-US', vi.fn())
    const card = document.querySelector('.tt-promo-card')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Try the installable version')
  })
})
