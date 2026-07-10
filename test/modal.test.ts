import { showModal, promptPassword, toast } from '../src/ui/modal'
import { el } from '../src/ui/dom'

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('.tt-modal-overlay')
}

afterEach(() => {
  document.body.innerHTML = ''
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

test('promptPassword resolves with entered password on OK', async () => {
  const promise = promptPassword('en-US', { title: 'Open' })
  const input = document.querySelector('input[name="tt-password"]') as HTMLInputElement
  input.value = 'secret'
  input.dispatchEvent(new Event('input'))
  const ok = document.querySelectorAll('.tt-modal-buttons button')[1] as HTMLButtonElement
  expect(ok.disabled).toBe(false)
  ok.click()
  await expect(promise).resolves.toBe('secret')
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
  await expect(promise).resolves.toBe('abcd')
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
  await expect(promise).resolves.toBe('abcd')
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
