import { showConflictModal } from '../src/ui/conflict'

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('.tt-modal-overlay')
}

function clickByText(text: string): void {
  const list = overlays()
  const scope: ParentNode = list.length > 0 ? list[list.length - 1]! : document
  const btn = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button "${text}" not found`)
  ;(btn as HTMLButtonElement).click()
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('renders the conflict title/message and Reload/Overwrite buttons', () => {
  showConflictModal({ locale: 'en-US', onReload: vi.fn(async () => {}), onOverwrite: vi.fn(async () => {}) })
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe('File changed externally')
  expect(document.querySelector('.tt-modal-message')?.textContent).toBe(
    'The file was changed by another program or tab since it was last read. Choose how to proceed.'
  )
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).toEqual(['Reload', 'Overwrite'])
})

test('Overwrite calls onOverwrite and closes the modal', () => {
  const onOverwrite = vi.fn(async () => {})
  const onReload = vi.fn(async () => {})
  showConflictModal({ locale: 'en-US', onReload, onOverwrite })

  clickByText('Overwrite')

  expect(onOverwrite).toHaveBeenCalledTimes(1)
  expect(onReload).not.toHaveBeenCalled()
  expect(overlays()).toHaveLength(0)
})

test('Reload asks for confirmation; Cancel keeps the conflict modal open without calling onReload', () => {
  const onReload = vi.fn(async () => {})
  showConflictModal({ locale: 'en-US', onReload, onOverwrite: vi.fn(async () => {}) })

  clickByText('Reload')
  const list = overlays()
  expect(list).toHaveLength(2)
  expect(list[list.length - 1]!.querySelector('.tt-modal-message')?.textContent).toBe(
    'This will discard your unsaved changes and reload the file contents. Continue?'
  )

  clickByText('Cancel')
  expect(onReload).not.toHaveBeenCalled()
  expect(overlays()).toHaveLength(1)
})

test('Reload confirm calls onReload and closes both modals', () => {
  const onReload = vi.fn(async () => {})
  showConflictModal({ locale: 'en-US', onReload, onOverwrite: vi.fn(async () => {}) })

  clickByText('Reload') // open confirm
  clickByText('Reload') // confirm button (same label)

  expect(onReload).toHaveBeenCalledTimes(1)
  expect(overlays()).toHaveLength(0)
})

test('renders in pt-BR', () => {
  showConflictModal({ locale: 'pt-BR', onReload: vi.fn(async () => {}), onOverwrite: vi.fn(async () => {}) })
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Arquivo modificado externamente')
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).toEqual(['Recarregar', 'Sobrescrever'])
})

test('offers a non-destructive fork as the first option', () => {
  showConflictModal({
    locale: 'en-US', onReload: vi.fn(async () => {}), onOverwrite: vi.fn(async () => {}),
    onFork: vi.fn(async () => true),
  })
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).toEqual(['Save my copy as a new file…', 'Reload', 'Overwrite'])
})

test('fork calls onFork without any confirmation step and closes the modal', async () => {
  const onFork = vi.fn(async () => true)
  const onReload = vi.fn(async () => {})
  const onOverwrite = vi.fn(async () => {})
  showConflictModal({ locale: 'en-US', onReload, onOverwrite, onFork })

  clickByText('Save my copy as a new file…')
  await Promise.resolve()

  expect(onFork).toHaveBeenCalledTimes(1)
  expect(onReload).not.toHaveBeenCalled()
  expect(onOverwrite).not.toHaveBeenCalled()
  expect(overlays()).toHaveLength(0)
})

test('a cancelled fork picker reopens the conflict modal so no choice is lost', async () => {
  const onFork = vi.fn(async () => false)
  showConflictModal({
    locale: 'en-US', onReload: vi.fn(async () => {}), onOverwrite: vi.fn(async () => {}), onFork,
  })

  clickByText('Save my copy as a new file…')
  await new Promise((r) => setTimeout(r, 0))

  expect(onFork).toHaveBeenCalledTimes(1)
  expect(overlays()).toHaveLength(1)
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).toEqual(['Save my copy as a new file…', 'Reload', 'Overwrite'])
})

test('renders the fork option in pt-BR', () => {
  showConflictModal({
    locale: 'pt-BR', onReload: vi.fn(async () => {}), onOverwrite: vi.fn(async () => {}),
    onFork: vi.fn(async () => true),
  })
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).toEqual(['Salvar minha cópia como novo arquivo…', 'Recarregar', 'Sobrescrever'])
})
