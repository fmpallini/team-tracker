import { askOlderFile, askBothChanged } from '../src/ui/reconcile-dialogs'
import { OpenCancelled } from '../src/core/live-open'
import { t } from '../src/core/i18n'

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('.tt-modal-overlay')
}
function buttonLabels(): string[] {
  return Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent ?? '')
}
function clickByText(text: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  ;(btn as HTMLButtonElement).click()
}
const esc = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }

afterEach(() => { document.body.innerHTML = '' })

describe('askOlderFile', () => {
  test('names the situation and offers keep-browser and use-file', async () => {
    const p = askOlderFile('en-US')
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('en-US', 'reconcile_older_title'))
    expect(buttonLabels()).toEqual([t('en-US', 'reconcile_older_use_file'), t('en-US', 'reconcile_older_keep_browser')])
    clickByText(t('en-US', 'reconcile_older_keep_browser'))
    await expect(p).resolves.toBe('browser')
  })

  test('choosing the file resolves "file"', async () => {
    const p = askOlderFile('pt-BR')
    clickByText(t('pt-BR', 'reconcile_older_use_file'))
    await expect(p).resolves.toBe('file')
    expect(overlays()).toHaveLength(0)
  })

  test('dismissing with Escape keeps the browser copy, the safe default', async () => {
    const p = askOlderFile('en-US')
    esc()
    await expect(p).resolves.toBe('browser')
  })
})

describe('askBothChanged', () => {
  test('offers keep-browser, use-file and cancel', async () => {
    const p = askBothChanged('en-US')
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('en-US', 'reconcile_both_title'))
    expect(buttonLabels()).toEqual([
      t('en-US', 'reconcile_both_cancel'), t('en-US', 'reconcile_both_use_file'), t('en-US', 'reconcile_both_keep_browser'),
    ])
    clickByText(t('en-US', 'reconcile_both_keep_browser'))
    await expect(p).resolves.toBe('browser')
  })

  test('the file choice resolves "file"', async () => {
    const p = askBothChanged('en-US')
    clickByText(t('en-US', 'reconcile_both_use_file'))
    await expect(p).resolves.toBe('file')
  })

  test('Cancel and Escape both cancel the open', async () => {
    const a = askBothChanged('en-US')
    clickByText(t('en-US', 'reconcile_both_cancel'))
    await expect(a).rejects.toBeInstanceOf(OpenCancelled)
    const b = askBothChanged('en-US')
    esc()
    await expect(b).rejects.toBeInstanceOf(OpenCancelled)
  })
})

test('every reconcile string exists in both locales', () => {
  for (const key of [
    'reconcile_older_title', 'reconcile_older_body', 'reconcile_older_keep_browser', 'reconcile_older_use_file',
    'reconcile_both_title', 'reconcile_both_body', 'reconcile_both_keep_browser', 'reconcile_both_use_file', 'reconcile_both_cancel',
    'live_copy_unreadable_toast', 'live_copy_password_title',
  ] as const) {
    expect(t('en-US', key)).not.toBe(t('pt-BR', key))
    expect(t('en-US', key).length).toBeGreaterThan(3)
  }
})
