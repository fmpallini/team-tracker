import { askOlderFile, askBothChanged, askOtherFile, confirmDiscardCopy } from '../src/ui/reconcile-dialogs'
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
  test('names the situation and offers cancel, use-file and keep-browser, saying the file gets overwritten', async () => {
    const p = askOlderFile('en-US')
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('en-US', 'reconcile_older_title'))
    expect(buttonLabels()).toEqual([
      t('en-US', 'reconcile_older_cancel'), t('en-US', 'reconcile_older_use_file'), t('en-US', 'reconcile_older_keep_browser'),
    ])
    expect(t('en-US', 'reconcile_older_keep_browser')).toMatch(/overwrite/i)
    expect(t('en-US', 'reconcile_older_body')).toMatch(/overwritten/i)
    clickByText(t('en-US', 'reconcile_older_keep_browser'))
    await expect(p).resolves.toBe('browser')
  })

  test('choosing the file resolves "file"', async () => {
    const p = askOlderFile('pt-BR')
    clickByText(t('pt-BR', 'reconcile_older_use_file'))
    await expect(p).resolves.toBe('file')
    expect(overlays()).toHaveLength(0)
  })

  test('Cancel and Escape cancel the open: both answers change something, so neither is a default', async () => {
    const a = askOlderFile('en-US')
    clickByText(t('en-US', 'reconcile_older_cancel'))
    await expect(a).rejects.toBeInstanceOf(OpenCancelled)
    const b = askOlderFile('en-US')
    esc()
    await expect(b).rejects.toBeInstanceOf(OpenCancelled)
  })
})

describe('askOtherFile', () => {
  test('names the file the browser changes belong to and offers cancel, continue here, and open separately', async () => {
    const p = askOtherFile('en-US', 'team.tmv')
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('en-US', 'reconcile_other_title'))
    expect(document.querySelector('.tt-modal-message')?.textContent).toContain('team.tmv')
    expect(buttonLabels()).toEqual([
      t('en-US', 'reconcile_other_cancel'), t('en-US', 'reconcile_other_same'), t('en-US', 'reconcile_other_separate'),
    ])
    expect(document.querySelector('.tt-modal-buttons .tt-btn-primary')?.textContent).toBe(t('en-US', 'reconcile_other_separate'))
    clickByText(t('en-US', 'reconcile_other_separate'))
    await expect(p).resolves.toBe('separate')
  })

  test('"continue" resolves "same"', async () => {
    const p = askOtherFile('pt-BR', 'x.tmv')
    clickByText(t('pt-BR', 'reconcile_other_same'))
    await expect(p).resolves.toBe('same')
  })

  test('Cancel and Escape cancel the open', async () => {
    const a = askOtherFile('en-US', 'x.tmv')
    clickByText(t('en-US', 'reconcile_other_cancel'))
    await expect(a).rejects.toBeInstanceOf(OpenCancelled)
    const b = askOtherFile('en-US', 'x.tmv')
    esc()
    await expect(b).rejects.toBeInstanceOf(OpenCancelled)
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
    'reconcile_other_title', 'reconcile_other_body', 'reconcile_other_same', 'reconcile_other_separate',
    'reconcile_both_title', 'reconcile_both_body', 'reconcile_both_keep_browser', 'reconcile_both_use_file', 'reconcile_both_cancel',
    'live_copy_unreadable_toast', 'live_copy_password_title',
  ] as const) {
    expect(t('en-US', key)).not.toBe(t('pt-BR', key))
    expect(t('en-US', key).length).toBeGreaterThan(3)
  }
})

describe('confirmDiscardCopy', () => {
  test('proceeds only when the user explicitly opens the file and discards', async () => {
    const p = confirmDiscardCopy('en-US')
    expect(document.querySelector('.tt-modal-title')?.textContent).toBe(t('en-US', 'reconcile_unusable_title'))
    expect(buttonLabels()).toEqual([t('en-US', 'reconcile_unusable_cancel'), t('en-US', 'reconcile_unusable_use_file')])
    clickByText(t('en-US', 'reconcile_unusable_use_file'))
    await expect(p).resolves.toBeUndefined()
    expect(overlays()).toHaveLength(0)
  })

  test('Cancel and Escape both back out of the open', async () => {
    const a = confirmDiscardCopy('pt-BR')
    clickByText(t('pt-BR', 'reconcile_unusable_cancel'))
    await expect(a).rejects.toBeInstanceOf(OpenCancelled)
    const b = confirmDiscardCopy('en-US')
    esc()
    await expect(b).rejects.toBeInstanceOf(OpenCancelled)
  })
})
