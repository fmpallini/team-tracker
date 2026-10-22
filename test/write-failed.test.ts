import { showWriteFailedDialog } from '../src/ui/write-failed'
import { t } from '../src/core/i18n'

type Opts = Parameters<typeof showWriteFailedDialog>[0]

function opts(over: Partial<Opts> = {}): Opts {
  return {
    locale: 'en-US', reason: 'permission', canRegrant: true,
    onRegrant: vi.fn(async () => true), onDownload: vi.fn(), onRetry: vi.fn(async () => true),
    ...over,
  }
}
const labels = (): string[] => Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent ?? '')
function click(label: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!btn) throw new Error(`button "${label}" not found; have ${labels().join(' | ')}`)
  ;(btn as HTMLButtonElement).click()
}
const esc = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => { document.body.innerHTML = '' })

test('a lost permission offers re-grant, download, retry, close anyway and cancel', () => {
  void showWriteFailedDialog(opts())
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('en-US', 'write_failed_title'))
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe(t('en-US', 'write_failed_body_permission'))
  expect(labels()).toEqual([
    t('en-US', 'write_failed_close_anyway'), t('en-US', 'cancel'), t('en-US', 'write_failed_download'),
    t('en-US', 'write_failed_retry'), t('en-US', 'write_failed_regrant'),
  ])
})

test('without a document to leave (opened from the pill), there is no close-anyway choice', () => {
  void showWriteFailedDialog(opts({ allowCloseAnyway: false }))
  expect(labels()).not.toContain(t('en-US', 'write_failed_close_anyway'))
  expect(labels()).toContain(t('en-US', 'cancel'))
})

test('any other failure has no re-grant button, nor does a session that has no handle to re-grant', () => {
  void showWriteFailedDialog(opts({ reason: 'error' }))
  expect(labels()).not.toContain(t('en-US', 'write_failed_regrant'))
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe(t('en-US', 'write_failed_body_error'))
  document.body.innerHTML = ''
  void showWriteFailedDialog(opts({ reason: 'permission', canRegrant: false }))
  expect(labels()).not.toContain(t('en-US', 'write_failed_regrant'))
})

test('re-granting successfully resolves; a refused grant keeps the dialog open and says so', async () => {
  const onRegrant = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const p = showWriteFailedDialog(opts({ onRegrant }))
  click(t('en-US', 'write_failed_regrant'))
  await tick()
  expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
  expect(document.querySelector('.tt-write-failed-still')?.textContent).toBe(t('en-US', 'write_failed_still'))
  click(t('en-US', 'write_failed_regrant'))
  await expect(p).resolves.toBe('resolved')
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})

test('retry resolves when the write now works, and keeps the dialog open when it does not', async () => {
  const onRetry = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const p = showWriteFailedDialog(opts({ reason: 'error', onRetry }))
  click(t('en-US', 'write_failed_retry'))
  await tick()
  expect(document.querySelector('.tt-write-failed-still')).not.toBeNull()
  click(t('en-US', 'write_failed_retry'))
  await expect(p).resolves.toBe('resolved')
})

test('downloading a copy leaves the dialog open, so closing anyway is a separate, deliberate choice', async () => {
  const onDownload = vi.fn()
  const p = showWriteFailedDialog(opts({ onDownload }))
  click(t('en-US', 'write_failed_download'))
  expect(onDownload).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.tt-modal-overlay')).not.toBeNull()
  click(t('en-US', 'write_failed_close_anyway'))
  await expect(p).resolves.toBe('closed-anyway')
})

test('Cancel and Escape both keep the document open', async () => {
  const a = showWriteFailedDialog(opts())
  click(t('en-US', 'cancel'))
  await expect(a).resolves.toBe('cancelled')
  const b = showWriteFailedDialog(opts())
  esc()
  await expect(b).resolves.toBe('cancelled')
})

test('the text exists in both locales', () => {
  void showWriteFailedDialog(opts({ locale: 'pt-BR', reason: 'error' }))
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('pt-BR', 'write_failed_title'))
  for (const key of ['write_failed_title', 'write_failed_body_permission', 'write_failed_body_error', 'write_failed_regrant', 'write_failed_download', 'write_failed_retry', 'write_failed_close_anyway', 'write_failed_still', 'close_browser_copy_failed_toast'] as const) {
    expect(t('en-US', key)).not.toBe(t('pt-BR', key))
  }
})

test('when the browser copy has failed too, the dialog stops promising the browser has the work, and closing says it discards', () => {
  void showWriteFailedDialog(opts({ reason: 'error', canRegrant: false, copyFailed: true }))
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe(t('en-US', 'write_failed_body_store'))
  expect(labels()).toContain(t('en-US', 'write_failed_close_discard'))
  expect(labels()).not.toContain(t('en-US', 'write_failed_close_anyway'))
  expect(labels()).toContain(t('en-US', 'write_failed_download'))
})
