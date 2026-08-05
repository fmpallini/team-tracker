import { showModal, promptPassword, toast, confirmDelete } from '../src/ui/modal'
import { el } from '../src/ui/dom'

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('.tt-modal-overlay')
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('a danger button gets the tt-btn-danger class', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [{ label: 'Delete', danger: true, onClick: () => {} }] })
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.classList.contains('tt-btn-danger')).toBe(true)
})

test('a left button gets the tt-btn-left class', () => {
  showModal({ title: 'T', body: el('div', {}), buttons: [{ label: 'Delete', left: true, onClick: () => {} }] })
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.classList.contains('tt-btn-left')).toBe(true)
})

test('showModal renders title, body and buttons; close removes overlay', () => {
  const body = el('p', {}, 'hello')
  let clicked = false
  const handle = showModal({
    title: 'Title',
    body,
    buttons: [{ label: 'Go', primary: true, onClick: () => { clicked = true } }],
  })
  expect(overlays().length).toBe(1)
  expect(document.querySelector('.tt-modal-title')?.textContent).toBe('Title')
  expect(document.body.contains(body)).toBe(true)
  const btn = document.querySelector('.tt-modal-buttons button') as HTMLButtonElement
  expect(btn.textContent).toBe('Go')
  btn.click()
  expect(clicked).toBe(true)
  handle.close()
  expect(overlays().length).toBe(0)
})

test('Enter in a text input inside the modal triggers the primary button', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  document.body.appendChild(el('div', {})) // unrelated node, sanity noise
  let clicked = false
  showModal({
    title: 'T',
    body: el('div', {}, input),
    buttons: [
      { label: 'Cancel', onClick: () => {} },
      { label: 'OK', primary: true, onClick: () => { clicked = true } },
    ],
  })
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(clicked).toBe(true)
})

test('Enter does not trigger the primary button when there is none', () => {
  const input = el('input', { type: 'text' }) as HTMLInputElement
  showModal({ title: 'T', body: el('div', {}, input), buttons: [{ label: 'Cancel', onClick: () => {} }] })
  expect(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))).not.toThrow()
})

test('showModal closes on Escape', () => {
  showModal({ title: 'T', body: el('div'), buttons: [] })
  expect(overlays().length).toBe(1)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(overlays().length).toBe(0)
})

test('onClose fires once when closed via handle.close()', () => {
  const onClose = vi.fn()
  const handle = showModal({ title: 'T', body: el('div'), buttons: [], onClose })
  handle.close()
  expect(onClose).toHaveBeenCalledOnce()
})

test('onClose fires once when closed via Escape', () => {
  const onClose = vi.fn()
  showModal({ title: 'T', body: el('div'), buttons: [], onClose })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(onClose).toHaveBeenCalledOnce()
})

test('promptPassword resolves with entered password on OK', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  const input = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  input.value = 'secret'
  input.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(false)
  ok.click()
  await expect(promise).resolves.toEqual({ password: 'secret' })
  expect(overlays().length).toBe(0)
})

test('promptPassword OK is disabled until non-empty', () => {
  void promptPassword('en-US', { title: 'Open' })
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(true)
})

test('promptPassword resolves null on Cancel', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  const cancel = document.querySelectorAll('.tt-modal-buttons button')[0] as HTMLButtonElement
  cancel.click()
  await expect(promise).resolves.toBeNull()
})

test('promptPassword confirm mode rejects a password shorter than 4 characters', async () => {
  const promise = promptPassword('en-US', { confirm: true, title: 'Create' })
  const [pw, confirm] = document.querySelectorAll('input') as unknown as HTMLInputElement[]
  pw!.value = 'abc'
  pw!.dispatchEvent(new Event('input'))
  confirm!.value = 'abc'
  confirm!.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  ok.click()
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Password must be at least 4 characters')

  pw!.value = 'abcd'
  pw!.dispatchEvent(new Event('input'))
  confirm!.value = 'abcd'
  confirm!.dispatchEvent(new Event('input'))
  ok.click()
  await expect(promise).resolves.toEqual({ password: 'abcd' })
})

test('promptPassword resolves null on Escape', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await expect(promise).resolves.toBeNull()
})

test('promptPassword confirm mismatch shows inline error and does not resolve', async () => {
  const promise = promptPassword('en-US', { confirm: true, title: 'Create' })
  const [pw, confirm] = document.querySelectorAll('input') as unknown as HTMLInputElement[]
  pw!.value = 'abcd'
  pw!.dispatchEvent(new Event('input'))
  confirm!.value = 'defg'
  confirm!.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(false)
  ok.click()
  expect(document.querySelector('.tt-field-error')?.textContent).toBe('Passwords do not match')

  confirm!.value = 'abcd'
  confirm!.dispatchEvent(new Event('input'))
  ok.click()
  await expect(promise).resolves.toEqual({ password: 'abcd' })
})

test('promptPassword without allowPlain has no "use without password" button', () => {
  void promptPassword('en-US', { confirm: true, title: 'Create' })
  const labels = Array.from(document.querySelectorAll('.tt-modal-buttons button')).map((b) => b.textContent)
  expect(labels).not.toContain('Use without password')
})

test('promptPassword with allowPlain shows the plain button and hint, resolves {plain:true} on click', async () => {
  const promise = promptPassword('en-US', { confirm: true, allowPlain: true, title: 'Create' })
  expect(document.querySelector('.tt-password-plain-hint')?.textContent).toBe(
    'Stored as plain, unencrypted text — readable by anyone with access to the file, including automated scanning by cloud backup providers.'
  )
  const plainBtn = Array.from(document.querySelectorAll('.tt-modal-buttons button')).find((b) => b.textContent === 'Use without password') as HTMLButtonElement
  expect(plainBtn).toBeDefined()
  plainBtn.click()
  await expect(promise).resolves.toEqual({ plain: true })
})

test('promptPassword with allowPlain: the plain button is unaffected by password-field validation', () => {
  void promptPassword('en-US', { confirm: true, allowPlain: true, title: 'Create' })
  const plainBtn = Array.from(document.querySelectorAll('.tt-modal-buttons button')).find((b) => b.textContent === 'Use without password') as HTMLButtonElement
  expect(plainBtn.disabled).toBe(false) // unlike OK, which starts disabled until a password is typed
})

test('promptPassword confirm mode renders a live strength meter under the password field', () => {
  void promptPassword('en-US', { confirm: true, title: 'Create' })
  const pw = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  expect(document.querySelector('.tt-pwmeter')).not.toBeNull()
  pw.value = 'Tr0ub4dor&3xtra!'
  pw.dispatchEvent(new Event('input'))
  expect(document.querySelector('.tt-pwmeter-label')?.textContent).toBe('Strong')
})

test('promptPassword without confirm (open-file mode) has no strength meter', () => {
  void promptPassword('en-US', { title: 'Open' })
  expect(document.querySelector('.tt-pwmeter')).toBeNull()
})

test('confirmDelete shows a title/message/confirm button and calls onConfirm', () => {
  const onConfirm = vi.fn()
  confirmDelete('en-US', {
    title: 'Delete X',
    message: 'Are you sure?',
    confirmLabel: 'Delete',
    variant: 'danger',
    onConfirm,
  })
  const dialog = document.querySelector('.tt-modal-dialog')!
  expect(dialog.querySelector('.tt-modal-title')?.textContent).toBe('Delete X')
  expect(dialog.querySelector('.tt-modal-message')?.textContent).toBe('Are you sure?')
  const confirmBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
  expect(confirmBtn.className).toContain('tt-btn-danger')
  confirmBtn.click()
  expect(onConfirm).toHaveBeenCalledOnce()
  expect(document.querySelector('.tt-modal-overlay')).toBeNull()
})

test('toast renders message and is removed on click', () => {
  toast('hi')
  const node = document.querySelector('.tt-toast') as HTMLElement
  expect(node.textContent).toBe('hi')
  node.click()
  expect(document.querySelector('.tt-toast')).toBeNull()
})

test('toast auto-dismisses after timeout unless sticky', () => {
  vi.useFakeTimers()
  try {
    toast('bye')
    expect(document.querySelector('.tt-toast')).not.toBeNull()
    vi.advanceTimersByTime(4000)
    expect(document.querySelector('.tt-toast')).toBeNull()

    toast('sticky one', { sticky: true })
    vi.advanceTimersByTime(10000)
    expect(document.querySelector('.tt-toast')).not.toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

// A sticky fallback notice plus one transient message was already enough to
// wall off the lower-right corner of a note editor, and the stack had no
// upper bound at all.
test('the toast stack keeps at most three, dropping the oldest first', () => {
  toast('one', { sticky: true })
  toast('two', { sticky: true })
  toast('three', { sticky: true })
  toast('four', { sticky: true })

  const texts = [...document.querySelectorAll('.tt-toast')].map((n) => n.textContent)
  expect(texts).toEqual(['two', 'three', 'four'])
})
